# =============================================================================
# fabric.ps1 - shared helpers for the lineage deploy / teardown scripts.
#
# Dot-source this file:  . "$PSScriptRoot/lib/fabric.ps1"
#
# Works on PowerShell 7+ (cross-platform) and Windows PowerShell 5.1.
# All Fabric calls authenticate with the Azure CLI (`az`) signed-in user.
# =============================================================================

$script:FabricApi = 'https://api.fabric.microsoft.com/v1'

function Write-Step { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Info { param([string]$m) Write-Host "    $m" -ForegroundColor Gray }
function Write-Ok   { param([string]$m) Write-Host "    [ok] $m" -ForegroundColor Green }
function Write-Warn2{ param([string]$m) Write-Host "    [!] $m"  -ForegroundColor Yellow }

# --- Tokens -----------------------------------------------------------------

function Get-AzToken {
    param([string]$Resource = 'https://api.fabric.microsoft.com')
    $t = az account get-access-token --resource $Resource --query accessToken -o tsv 2>$null
    if (-not $t) { throw "Could not get an access token for '$Resource'. Run 'az login' first." }
    return $t.Trim()
}

# --- Generic Fabric REST call with long-running-operation (LRO) handling -----

function Invoke-Fabric {
    param(
        [Parameter(Mandatory)][ValidateSet('GET','POST','PATCH','PUT','DELETE')][string]$Method,
        [Parameter(Mandatory)][string]$Path,   # path after /v1 (e.g. /workspaces) or an absolute URL
        [object]$Body,
        [string]$Token,
        [switch]$Raw                            # return the raw response, skip LRO handling
    )
    if (-not $Token) { $Token = Get-AzToken }
    $url = if ($Path -match '^https?://') { $Path } else { "$script:FabricApi$Path" }
    $headers = @{ Authorization = "Bearer $Token" }
    $json = $null
    if ($null -ne $Body) {
        $json = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 40 }
        $headers['Content-Type'] = 'application/json'
    }
    try {
        $resp = Invoke-WebRequest -Method $Method -Uri $url -Headers $headers -Body $json -UseBasicParsing -ErrorAction Stop
    }
    catch {
        $detail = $_.ErrorDetails.Message
        if (-not $detail -and $_.Exception.Response) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $detail = (New-Object IO.StreamReader($stream)).ReadToEnd()
            } catch { }
        }
        throw "Fabric $Method $Path failed: $($_.Exception.Message)`n$detail"
    }
    if ($Raw) { return $resp }

    if ([int]$resp.StatusCode -eq 202) {
        $op = $resp.Headers['Location']
        if ($op -is [array]) { $op = $op[0] }
        if (-not $op) { return $null }
        $retry = 5
        $ra = $resp.Headers['Retry-After']
        if ($ra) { if ($ra -is [array]) { $ra = $ra[0] }; $retry = [int]$ra }
        return Wait-FabricLro -OperationUrl $op -Token $Token -RetrySeconds $retry
    }
    if ($resp.Content) { try { return $resp.Content | ConvertFrom-Json } catch { return $resp.Content } }
    return $null
}

function Wait-FabricLro {
    param(
        [Parameter(Mandatory)][string]$OperationUrl,
        [string]$Token,
        [int]$RetrySeconds = 5,
        [int]$TimeoutMinutes = 30
    )
    if (-not $Token) { $Token = Get-AzToken }
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $status = $null
    do {
        Start-Sleep -Seconds ([Math]::Max($RetrySeconds, 3))
        # Refresh the token each poll so a long operation does not 401 mid-wait.
        $h = @{ Authorization = "Bearer $(Get-AzToken)" }
        $op = Invoke-RestMethod -Method Get -Uri $OperationUrl -Headers $h
        $status = "$($op.status)"
        if ((Get-Date) -gt $deadline) { throw "Operation timed out after $TimeoutMinutes min: $OperationUrl" }
    } while ($status -notin @('Succeeded', 'Failed', 'Completed', 'Cancelled'))

    if ($status -in @('Failed', 'Cancelled')) {
        $msg = if ($op.error) { $op.error.message } else { $status }
        throw "Operation $status`: $msg"
    }
    try { return Invoke-RestMethod -Method Get -Uri "$OperationUrl/result" -Headers $h -ErrorAction Stop }
    catch { return $op }
}

# --- Capacity helpers -------------------------------------------------------

# Resolve a Fabric/Power BI capacity id from its display name (case-insensitive).
function Get-FabricCapacityIdByName {
    param(
        [Parameter(Mandatory)][string]$Name,
        [string]$Token
    )
    $caps = (Invoke-Fabric -Method GET -Path "/capacities" -Token $Token).value
    $match = $caps | Where-Object { $_.displayName -ieq $Name }
    if (-not $match) {
        $available = ($caps | ForEach-Object { $_.displayName }) -join ', '
        throw "Capacity '$Name' not found. Available capacities: $available"
    }
    if (@($match).Count -gt 1) { throw "Multiple capacities named '$Name'; pass -CapacityId to disambiguate." }
    return @($match)[0].id
}

# --- Folder helpers ---------------------------------------------------------

# Create a workspace folder by display name (idempotent). Returns the folder id.
function New-FabricFolder {
    param(
        [Parameter(Mandatory)][string]$WorkspaceId,
        [Parameter(Mandatory)][string]$DisplayName,
        [string]$ParentFolderId,
        [string]$Token
    )
    $existing = (Invoke-Fabric -Method GET -Path "/workspaces/$WorkspaceId/folders" -Token $Token).value |
                    Where-Object { $_.displayName -eq $DisplayName -and ("$($_.parentFolderId)" -eq "$ParentFolderId") } |
                    Select-Object -First 1
    if ($existing) { Write-Info "Folder '$DisplayName' already exists ($($existing.id))"; return $existing.id }
    $body = @{ displayName = $DisplayName }
    if ($ParentFolderId) { $body.parentFolderId = $ParentFolderId }
    $folder = Invoke-Fabric -Method POST -Path "/workspaces/$WorkspaceId/folders" -Token $Token -Body $body
    return $folder.id
}

# Move an item (and its children) into a folder. Best-effort with 429 back-off:
# a persistent failure is logged, not thrown, so a layout hiccup never aborts a
# deployment.
function Move-FabricItemToFolder {
    param(
        [Parameter(Mandatory)][string]$WorkspaceId,
        [Parameter(Mandatory)][string]$ItemId,
        [Parameter(Mandatory)][string]$TargetFolderId,
        [string]$Token
    )
    if (-not $ItemId -or -not $TargetFolderId) { return }
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Invoke-Fabric -Method POST -Path "/workspaces/$WorkspaceId/items/$ItemId/move" `
                -Token $Token -Body @{ targetFolderId = $TargetFolderId } | Out-Null
            return
        } catch {
            $msg = $_.Exception.Message.Split([char]10)[0]
            if ($msg -match '\(429\)' -and $attempt -lt 5) {
                Start-Sleep -Seconds (5 * $attempt)
                continue
            }
            Write-Warn2 "could not move item $ItemId into folder: $msg"
            return
        }
    }
}

# --- Item helpers -----------------------------------------------------------

function Get-FabricItemByName {
    param(
        [Parameter(Mandatory)][string]$WorkspaceId,
        [Parameter(Mandatory)][string]$Type,        # e.g. Eventhouse, Lakehouse, Notebook, Environment, KQLDatabase
        [Parameter(Mandatory)][string]$DisplayName,
        [string]$Token
    )
    $items = (Invoke-Fabric -Method GET -Path "/workspaces/$WorkspaceId/items?type=$Type" -Token $Token).value
    return $items | Where-Object { $_.displayName -eq $DisplayName } | Select-Object -First 1
}

# Create an item by display name, then resolve and return it (handles 201 and 202/LRO).
function New-FabricItem {
    param(
        [Parameter(Mandatory)][string]$WorkspaceId,
        [Parameter(Mandatory)][string]$Collection,  # plural REST collection, e.g. eventhouses, lakehouses, environments
        [Parameter(Mandatory)][string]$Type,         # item type for resolution, e.g. Eventhouse
        [Parameter(Mandatory)][string]$DisplayName,
        [object]$Body,
        [string]$Token
    )
    $existing = Get-FabricItemByName -WorkspaceId $WorkspaceId -Type $Type -DisplayName $DisplayName -Token $Token
    if ($existing) { Write-Info "$Type '$DisplayName' already exists ($($existing.id))"; return $existing }

    $payload = if ($Body) { $Body } else { @{ displayName = $DisplayName } }
    $created = Invoke-Fabric -Method POST -Path "/workspaces/$WorkspaceId/$Collection" -Body $payload -Token $Token
    if ($created -and $created.id) { return $created }
    # LRO / no body: resolve by name (retry a few times for eventual consistency)
    for ($i = 0; $i -lt 10; $i++) {
        $item = Get-FabricItemByName -WorkspaceId $WorkspaceId -Type $Type -DisplayName $DisplayName -Token $Token
        if ($item) { return $item }
        Start-Sleep -Seconds 4
    }
    throw "Created $Type '$DisplayName' but could not resolve its id."
}

# --- Kusto (Eventhouse) helpers ---------------------------------------------

function Get-KustoResource {
    param([Parameter(Mandatory)][string]$QueryUri)
    $u = [Uri]$QueryUri
    return "$($u.Scheme)://$($u.Host)"
}

function Invoke-KustoMgmt {
    param(
        [Parameter(Mandatory)][string]$QueryUri,
        [Parameter(Mandatory)][string]$Database,
        [Parameter(Mandatory)][string]$Csl,
        [string]$KustoToken
    )
    if (-not $KustoToken) { $KustoToken = Get-AzToken -Resource (Get-KustoResource $QueryUri) }
    return Invoke-RestMethod -Method Post -Uri "$QueryUri/v1/rest/mgmt" `
        -Headers @{ Authorization = "Bearer $KustoToken"; 'Content-Type' = 'application/json' } `
        -Body (@{ db = $Database; csl = $Csl } | ConvertTo-Json)
}

# --- Notebook definition builder --------------------------------------------

function ConvertTo-B64 { param([string]$Text) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text)) }

# Build a notebook createDefinition payload from a local .ipynb file, injecting
# the lakehouse + environment dependencies for the target workspace.
function New-NotebookDefinition {
    param(
        [Parameter(Mandatory)][string]$IpynbPath,
        [Parameter(Mandatory)][string]$DisplayName,
        [string]$WorkspaceId,
        [string]$DefaultLakehouseId,
        [string]$DefaultLakehouseName,
        [string[]]$KnownLakehouseIds,
        [string]$EnvironmentId,
        [string]$ClusterUri
    )
    $raw = Get-Content $IpynbPath -Raw
    # Point any hardcoded Eventhouse/Kusto cluster host at this deployment's cluster.
    if ($ClusterUri) {
        $raw = $raw -replace 'https://[A-Za-z0-9.\-]+\.kusto\.fabric\.microsoft\.com', $ClusterUri
    }
    $nb = $raw | ConvertFrom-Json
    $deps = @{}
    if ($DefaultLakehouseId) {
        $known = @()
        foreach ($id in ($KnownLakehouseIds + $DefaultLakehouseId | Select-Object -Unique)) {
            if ($id) { $known += @{ id = $id } }
        }
        $deps.lakehouse = @{
            default_lakehouse              = $DefaultLakehouseId
            default_lakehouse_name         = $DefaultLakehouseName
            default_lakehouse_workspace_id = $WorkspaceId
            known_lakehouses               = $known
        }
    }
    if ($EnvironmentId) {
        $deps.environment = @{ environmentId = $EnvironmentId; workspaceId = $WorkspaceId }
    }
    # Replace the metadata.dependencies node.
    $meta = @{}
    foreach ($p in $nb.metadata.PSObject.Properties) { $meta[$p.Name] = $p.Value }
    if ($deps.Count -gt 0) { $meta['dependencies'] = $deps } else { $meta.Remove('dependencies') | Out-Null }
    $nb.metadata = $meta

    $ipynbJson = $nb | ConvertTo-Json -Depth 40
    $platform = @{
        '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json'
        metadata  = @{ type = 'Notebook'; displayName = $DisplayName }
        config    = @{ version = '2.0'; logicalId = [guid]::NewGuid().ToString() }
    } | ConvertTo-Json -Depth 10

    return @{
        format = 'ipynb'
        parts  = @(
            @{ path = 'notebook-content.ipynb'; payload = (ConvertTo-B64 $ipynbJson); payloadType = 'InlineBase64' }
            @{ path = '.platform';              payload = (ConvertTo-B64 $platform);  payloadType = 'InlineBase64' }
        )
    }
}

# Run a notebook item and wait for completion.
function Invoke-NotebookRun {
    param(
        [Parameter(Mandatory)][string]$WorkspaceId,
        [Parameter(Mandatory)][string]$NotebookId,
        [string]$Token,
        [int]$TimeoutMinutes = 45
    )
    if (-not $Token) { $Token = Get-AzToken }
    # Always mint a fresh token: a long-running deploy can outlive the caller's token (401).
    $resp = Invoke-Fabric -Method POST -Path "/workspaces/$WorkspaceId/items/$NotebookId/jobs/instances?jobType=RunNotebook" -Body @{} -Token (Get-AzToken) -Raw
    $op = $resp.Headers['Location']
    if ($op -is [array]) { $op = $op[0] }
    if (-not $op) { throw "Notebook run did not return a job-instance URL." }
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    do {
        Start-Sleep -Seconds 10
        # Refresh the token each poll so a long run does not 401 mid-wait.
        $inst = Invoke-RestMethod -Method Get -Uri $op -Headers @{ Authorization = "Bearer $(Get-AzToken)" }
        $st = "$($inst.status)"
        if ((Get-Date) -gt $deadline) { throw "Notebook run timed out: $NotebookId" }
    } while ($st -notin @('Completed', 'Failed', 'Cancelled', 'Deduped'))
    if ($st -in @('Failed', 'Cancelled')) {
        $err = if ($inst.failureReason) { $inst.failureReason.message } else { $st }
        throw "Notebook run $st`: $err"
    }
    return $inst
}
