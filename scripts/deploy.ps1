<#
.SYNOPSIS
    Provision the full Fabric Data Lineage demo into a dedicated workspace.

.DESCRIPTION
    Creates everything needed to run and test the lineage solution end to end:

      1. A Fabric workspace - an existing one (-WorkspaceId) or a new one created
         on the capacity you specify (-CapacityId).
      2. The OpenLineage Eventhouse (KQL DB) + full schema. Ingestion authenticates
         with the user-identity Kusto token kept fresh by a scheduled notebook.
      3. A Spark Environment ('lineage-env') configured for the OpenLineage HTTP
         transport, published and set as the workspace default Spark environment.
      4. Sample lakehouses (taxi_lh, retail_lh, finance_lh) with synthetic
         NYC-taxi / retail / finance data produced by the medallion notebooks.
      5. The medallion + cleanup notebooks, optionally executed to populate data
         and emit lineage.
      6. An Entra app registration for the SPA + Eventhouse access (default on).
      7. The Rayfin app, deployed into the workspace via `rayfin up` (default on).

    Items are organised into folders: lineage infrastructure (Eventhouse,
    Environment, lineage notebooks) under '_lineage', the sample lakehouses and
    medallion notebooks under 'demo-data', and the Rayfin app at the workspace root.

    All created resource ids are written to a state file so teardown.ps1 can
    cleanly decommission everything.

.PARAMETER WorkspaceName
    Display name for the workspace to create (or reuse if it already exists).
    Default: 'lineage-demo'. Ignored when -WorkspaceId is supplied.

.PARAMETER CapacityName
    Display name of the Fabric/Power BI capacity to bind a NEW workspace to.
    Required when creating a new workspace (i.e. when neither -WorkspaceId nor
    -CapacityId is supplied). Resolved to a capacity id automatically.

.PARAMETER WorkspaceId
    (Advanced) Id of an existing Fabric workspace to deploy into. When supplied,
    the workspace is used as-is and -CapacityName/-CapacityId are not needed.

.PARAMETER CapacityId
    (Advanced) Capacity id to bind a NEW workspace to. Use -CapacityName instead
    unless you already have the id; -CapacityId wins if both are supplied.

.PARAMETER EventhouseName
    Eventhouse/KQL database name. Default: 'lineage_eh' (keep this - the checked-in
    KQL schema references the database by this name).

.PARAMETER RunNotebooks
    Run the medallion notebooks after upload to populate data + lineage. Default: $true.

.PARAMETER CreateAppRegistration
    Create an Entra app registration (SPA redirects + Kusto user_impersonation
    + Power BI Workspace.Read.All for "Check lakehouse access").
    Default: $true. Requires rights to create app registrations and (ideally) to
    grant admin consent. Disable with -CreateAppRegistration:$false.

.PARAMETER DeployApp
    Deploy the Rayfin app into the workspace (writes app/rayfin/.env then runs
    `rayfin up -w <workspace> -y`). Default: $true. Disable with -DeployApp:$false.

.PARAMETER DeployedAppUrl
    Public URL of the deployed app, added as an SPA redirect URI (optional).
    Normally not needed - the app deploy step adds the real hosting URL itself.

.PARAMETER RefreshIntervalMinutes
    Cron interval (minutes) for the native Fabric schedule that re-publishes the
    OpenLineage ingestion token via the 01_refresh_openlineage_token notebook.
    Default: 60. Set to 0 to skip creating the schedule.

.EXAMPLE
    ./deploy.ps1 -WorkspaceName lineage-test -CapacityName fabriccapacitydemo

.EXAMPLE
    ./deploy.ps1 -WorkspaceName lineage-test -CapacityName fabriccapacitydemo `
        -CreateAppRegistration -DeployApp

.EXAMPLE
    ./deploy.ps1 -WorkspaceId <workspaceGuid>   # deploy into an existing workspace
#>
[CmdletBinding()]
param(
    [string]$WorkspaceName = 'lineage-demo',
    [string]$CapacityName,
    [string]$WorkspaceId,
    [string]$CapacityId,
    [string]$EventhouseName = 'lineage_eh',
    [bool]$RunNotebooks = $true,
    [bool]$CreateAppRegistration = $true,
    [bool]$DeployApp = $true,
    [bool]$UsePrebuiltApp = $false,
    [string]$DeployedAppUrl,
    [int]$RefreshIntervalMinutes = 60,
    [string]$StateFile = "$PSScriptRoot/.deploy-state.json"
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/lib/fabric.ps1"
. "$PSScriptRoot/lib/prebuilt-app.ps1"

$RepoRoot      = Split-Path $PSScriptRoot -Parent
$SchemaPath    = Join-Path $RepoRoot 'eventhouse/lineage_eh_schema.kql'
$NotebooksDir  = Join-Path $RepoRoot 'notebooks'
$state = [ordered]@{ createdAt = (Get-Date).ToString('o'); workspaceName = $WorkspaceName }

# --- 0. Preflight -----------------------------------------------------------
Write-Step "Preflight"
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) { throw "Not logged in. Run 'az login'." }
$TenantId = $account.tenantId
Write-Ok "Signed in as $($account.user.name) (tenant $TenantId)"
$fabToken = Get-AzToken
if (-not (Test-Path $SchemaPath)) { throw "KQL schema not found at $SchemaPath" }
$state.tenantId = $TenantId

# --- 1. Workspace -----------------------------------------------------------
Write-Step "Workspace"
if ($WorkspaceId) {
    $ws = Invoke-Fabric -Method GET -Path "/workspaces/$WorkspaceId" -Token $fabToken
    if (-not $ws) { throw "Workspace $WorkspaceId not found." }
    $WorkspaceName = $ws.displayName
    Write-Ok "Using existing workspace '$WorkspaceName' ($WorkspaceId)"
} else {
    $ws = (Invoke-Fabric -Method GET -Path "/workspaces" -Token $fabToken).value |
            Where-Object { $_.displayName -eq $WorkspaceName } | Select-Object -First 1
    if ($ws) {
        Write-Ok "Using existing workspace '$WorkspaceName' ($($ws.id))"
    } else {
        # Resolve the capacity to bind the new workspace to (name -> id).
        if (-not $CapacityId) {
            if (-not $CapacityName) { throw "Workspace '$WorkspaceName' not found. Provide -CapacityName (or -CapacityId) to create it, or -WorkspaceId for an existing one." }
            $CapacityId = Get-FabricCapacityIdByName -Name $CapacityName -Token $fabToken
            Write-Ok "Resolved capacity '$CapacityName' -> $CapacityId"
        }
        $ws = Invoke-Fabric -Method POST -Path "/workspaces" -Token $fabToken `
                -Body @{ displayName = $WorkspaceName; capacityId = $CapacityId }
        Write-Ok "Created workspace '$WorkspaceName' ($($ws.id)) on capacity $CapacityId"
    }
    $WorkspaceId = $ws.id
}
$state.workspaceId = $WorkspaceId
$state.workspaceName = $WorkspaceName
if ($CapacityId)   { $state.capacityId = $CapacityId }
if ($CapacityName) { $state.capacityName = $CapacityName }

# --- 1b. Folders ------------------------------------------------------------
# Keep the workspace tidy: lineage infrastructure under '_lineage', the sample
# data + medallion notebooks under 'demo-data'. The Rayfin app stays at the root.
Write-Step "Folders"
$folders = [ordered]@{
    '_lineage'  = New-FabricFolder -WorkspaceId $WorkspaceId -DisplayName '_lineage'  -Token $fabToken
    'demo-data' = New-FabricFolder -WorkspaceId $WorkspaceId -DisplayName 'demo-data' -Token $fabToken
}
$state.folders = $folders
Write-Ok "Folders ready: _lineage, demo-data"

# --- 2. Eventhouse + schema -------------------------------------------------
Write-Step "Eventhouse '$EventhouseName'"
$eh = New-FabricItem -WorkspaceId $WorkspaceId -Collection 'eventhouses' -Type 'Eventhouse' `
        -DisplayName $EventhouseName -Token $fabToken
$state.eventhouseId = $eh.id
# The child KQL database moves with its Eventhouse parent automatically.
Move-FabricItemToFolder -WorkspaceId $WorkspaceId -ItemId $eh.id -TargetFolderId $folders['_lineage'] -Token $fabToken

# Resolve the child KQL database + its query URI.
$kqlDb = $null
for ($i = 0; $i -lt 12; $i++) {
    $kqlDb = (Invoke-Fabric -Method GET -Path "/workspaces/$WorkspaceId/kqlDatabases" -Token $fabToken).value |
                Where-Object { $_.properties.parentEventhouseItemId -eq $eh.id } | Select-Object -First 1
    if ($kqlDb -and $kqlDb.properties.queryServiceUri -and $kqlDb.properties.databaseName) { break }
    Start-Sleep -Seconds 5
}
if (-not $kqlDb) { throw "Could not resolve the KQL database for Eventhouse $($eh.id)." }
$QueryUri = $kqlDb.properties.queryServiceUri
$DbName   = $kqlDb.properties.databaseName
if (-not $DbName) { $DbName = $kqlDb.displayName }
if (-not $DbName) { $DbName = $EventhouseName }
if (-not $QueryUri) { throw "KQL database '$DbName' has no queryServiceUri yet; re-run the deployment." }
$state.kqlDatabaseId = $kqlDb.id
$state.queryUri = $QueryUri
$state.databaseName = $DbName
Write-Ok "KQL DB '$DbName' @ $QueryUri"

Write-Info "Deploying KQL schema..."
$schema = Get-Content $SchemaPath -Raw
$kustoToken = Get-AzToken -Resource (Get-KustoResource $QueryUri)
$csl = ".execute database script with (ContinueOnErrors=true) <|`n" + $schema
$schemaResult = Invoke-KustoMgmt -QueryUri $QueryUri -Database $DbName -Csl $csl -KustoToken $kustoToken
# .execute database script returns columns OperationId, CommandType, CommandText, Result
# where Result is 'Completed' on success. Locate the columns by name to be robust.
$schemaTable = $schemaResult.Tables[0]
$resultIdx = 0; $cmdIdx = 0
for ($c = 0; $c -lt $schemaTable.Columns.Count; $c++) {
    switch ($schemaTable.Columns[$c].ColumnName) {
        'Result'      { $resultIdx = $c }
        'CommandText' { $cmdIdx = $c }
    }
}
$failed = @($schemaTable.Rows | Where-Object { "$($_[$resultIdx])" -ne 'Completed' })
Write-Ok "Schema deployed ($($schemaTable.Rows.Count) commands; $($failed.Count) failed)"
foreach ($f in $failed) {
    Write-Warn2 ("schema issue: {0} => {1}" -f ("$($f[$cmdIdx])".Split([char]10)[0]).Trim(), $f[$resultIdx])
}

# --- 3. Spark Environment (OpenLineage) -------------------------------------
Write-Step "Spark Environment 'lineage-env'"
$env = New-FabricItem -WorkspaceId $WorkspaceId -Collection 'environments' -Type 'Environment' `
        -DisplayName 'lineage-env' -Token $fabToken
$EnvironmentId = $env.id
$state.environmentId = $EnvironmentId
Move-FabricItemToFolder -WorkspaceId $WorkspaceId -ItemId $EnvironmentId -TargetFolderId $folders['_lineage'] -Token $fabToken

$sparkProps = @{
    'spark.openlineage.transport.type'                  = 'http'
    'spark.openlineage.transport.url'                   = $QueryUri
    'spark.openlineage.transport.endpoint'              = "/v1/rest/ingest/$DbName/OpenLineageRaw"
    'spark.openlineage.transport.urlParams.streamFormat'= 'SINGLEJSON'
    'spark.openlineage.transport.urlParams.mappingName' = 'OpenLineageRaw_mapping'
    'spark.openlineage.transport.auth.type'             = 'api_key'
    'spark.openlineage.transport.auth.apiKey'           = $kustoToken
    'spark.extraListeners'                              = 'io.openlineage.spark.agent.OpenLineageSparkListener'
    'spark.openlineage.namespace'                       = 'fabric-lineage-demo'
}
$envBase = "/workspaces/$WorkspaceId/environments/$EnvironmentId"
Invoke-Fabric -Method PATCH -Path "$envBase/staging/sparkcompute" -Token $fabToken -Body @{
    instancePool             = @{ name = 'Starter Pool'; type = 'Workspace' }
    dynamicExecutorAllocation= @{ enabled = $false }
    sparkProperties          = $sparkProps
} | Out-Null
Write-Info "Publishing environment (this can take several minutes)..."
Invoke-Fabric -Method POST -Path "$envBase/staging/publish" -Token $fabToken -Body @{} | Out-Null
$deadline = (Get-Date).AddMinutes(30)
do {
    Start-Sleep -Seconds 15
    $envState = Invoke-Fabric -Method GET -Path $envBase -Token $fabToken
    $ps = "$($envState.properties.publishDetails.state)"
    Write-Info "publish state: $ps"
    if ((Get-Date) -gt $deadline) { throw "Environment publish timed out." }
} while ($ps -notin @('Success', 'Failed', 'Cancelled'))
if ($ps -ne 'Success') { throw "Environment publish ended in state '$ps'." }
Write-Ok "Environment published"

# Set this environment as the workspace Spark default so notebooks/jobs pick up
# the OpenLineage config (and runtime) without per-item attachment.
try {
    $envRuntime = "$($envState.properties.runtimeVersion)"
    if (-not $envRuntime) {
        $envCompute = Invoke-Fabric -Method GET -Path "$envBase/sparkcompute" -Token $fabToken
        $envRuntime = "$($envCompute.runtimeVersion)"
    }
    if (-not $envRuntime) { $envRuntime = '1.3' }
    Invoke-Fabric -Method PATCH -Path "/workspaces/$WorkspaceId/spark/settings" -Token $fabToken -Body @{
        environment = @{ name = 'lineage-env'; runtimeVersion = $envRuntime }
    } | Out-Null
    Write-Ok "Workspace Spark default environment set to 'lineage-env' (runtime $envRuntime)"
} catch {
    Write-Warn2 "Could not set the workspace default Spark environment automatically: $($_.Exception.Message)"
    Write-Warn2 "Set it manually: Workspace settings -> Data Engineering/Science -> Spark settings -> Environment -> lineage-env."
}
Write-Warn2 "The OpenLineage apiKey is a Kusto token captured now and it expires (~1h). The 01_refresh_openlineage_token notebook (scheduled below, every $RefreshIntervalMinutes min) keeps it fresh."

# --- 4. Lakehouses ----------------------------------------------------------
Write-Step "Lakehouses"
$lakehouseNames = @('taxi_lh', 'retail_lh', 'finance_lh')
$lakehouses = @{}
foreach ($name in $lakehouseNames) {
    $lh = New-FabricItem -WorkspaceId $WorkspaceId -Collection 'lakehouses' -Type 'Lakehouse' `
            -DisplayName $name -Token $fabToken
    $lakehouses[$name] = $lh.id
    Move-FabricItemToFolder -WorkspaceId $WorkspaceId -ItemId $lh.id -TargetFolderId $folders['demo-data'] -Token $fabToken
    Write-Ok "$name -> $($lh.id)"
}
$state.lakehouses = $lakehouses

# --- 5. Notebooks -----------------------------------------------------------
Write-Step "Notebooks"
# name -> @{ subfolder; default lakehouse; known lakehouses; attach env }
$nbPlan = [ordered]@{
    '01_bronze_silver'             = @{ dir = 'demo-lakehouse'; default = 'taxi_lh'; known = @('taxi_lh');                        env = $true  }
    '02_gold'                      = @{ dir = 'demo-lakehouse'; default = 'taxi_lh'; known = @('taxi_lh');                        env = $true  }
    '03_marts'                     = @{ dir = 'demo-lakehouse'; default = 'taxi_lh'; known = @('taxi_lh');                        env = $true  }
    '04_cross_marts'               = @{ dir = 'demo-lakehouse'; default = 'taxi_lh'; known = @('taxi_lh','retail_lh','finance_lh'); env = $true }
    '00_refresh_active_tables'     = @{ dir = 'lineage';        default = $null;     known = @();                                 env = $false }
    '01_refresh_openlineage_token' = @{ dir = 'lineage';        default = $null;     known = @();                                 env = $false }
}
$notebookIds = @{}
$nbClusterUri = Get-KustoResource $QueryUri
foreach ($nbName in $nbPlan.Keys) {
    $plan = $nbPlan[$nbName]
    $ipynb = Join-Path $NotebooksDir (Join-Path $plan.dir "$nbName.ipynb")
    if (-not (Test-Path $ipynb)) { Write-Warn2 "skipping $nbName (file not found)"; continue }
    $defId   = if ($plan.default) { $lakehouses[$plan.default] } else { $null }
    $knownIds= @($plan.known | ForEach-Object { $lakehouses[$_] })
    $envId   = if ($plan.env) { $EnvironmentId } else { $null }
    $def = New-NotebookDefinition -IpynbPath $ipynb -DisplayName $nbName -WorkspaceId $WorkspaceId `
            -DefaultLakehouseId $defId -DefaultLakehouseName $plan.default -KnownLakehouseIds $knownIds -EnvironmentId $envId `
            -ClusterUri $nbClusterUri
    $existing = Get-FabricItemByName -WorkspaceId $WorkspaceId -Type 'Notebook' -DisplayName $nbName -Token $fabToken
    if ($existing) {
        Invoke-Fabric -Method POST -Path "/workspaces/$WorkspaceId/notebooks/$($existing.id)/updateDefinition" `
            -Token $fabToken -Body @{ definition = $def } | Out-Null
        $notebookIds[$nbName] = $existing.id
    } else {
        $created = Invoke-Fabric -Method POST -Path "/workspaces/$WorkspaceId/notebooks" -Token $fabToken `
                    -Body @{ displayName = $nbName; definition = $def }
        if (-not ($created -and $created.id)) {
            $created = Get-FabricItemByName -WorkspaceId $WorkspaceId -Type 'Notebook' -DisplayName $nbName -Token $fabToken
        }
        $notebookIds[$nbName] = $created.id
    }
    $nbFolder = if ($plan.dir -eq 'lineage') { $folders['_lineage'] } else { $folders['demo-data'] }
    Move-FabricItemToFolder -WorkspaceId $WorkspaceId -ItemId $notebookIds[$nbName] -TargetFolderId $nbFolder -Token $fabToken
    Write-Ok "$nbName -> $($notebookIds[$nbName])"
}
$state.notebooks = $notebookIds

# Schedule the OpenLineage token-refresh notebook to run natively in Fabric so the
# ingestion apiKey is kept fresh without anyone's laptop being involved.
$refreshNb = $notebookIds['01_refresh_openlineage_token']
if ($refreshNb -and $RefreshIntervalMinutes -gt 0) {
    Write-Info "Scheduling 01_refresh_openlineage_token every $RefreshIntervalMinutes min..."
    $start = (Get-Date).ToUniversalTime().AddMinutes(-5).ToString('yyyy-MM-ddTHH:mm:ss')
    $end   = (Get-Date).ToUniversalTime().AddYears(1).ToString('yyyy-MM-ddTHH:mm:ss')
    $schedBody = @{
        enabled       = $true
        configuration = @{
            type            = 'Cron'
            interval        = $RefreshIntervalMinutes
            startDateTime   = $start
            endDateTime     = $end
            localTimeZoneId = 'UTC'
        }
    }
    try {
        $sched = Invoke-Fabric -Method POST -Token $fabToken `
            -Path "/workspaces/$WorkspaceId/items/$refreshNb/jobs/RunNotebook/schedules" -Body $schedBody
        $state.tokenRefreshScheduleId = $sched.id
        Write-Ok "Token-refresh schedule created ($($sched.id))"
    } catch {
        Write-Warn2 "Could not create the token-refresh schedule automatically: $($_.Exception.Message)"
        Write-Warn2 "Schedule 01_refresh_openlineage_token manually in Fabric (Run -> Schedule)."
    }
}

# --- 6. Run the medallion notebooks (optional) ------------------------------
if ($RunNotebooks) {
    Write-Step "Running notebooks (populating data + lineage)"
    $nbFailures = @()
    foreach ($nbName in @('01_bronze_silver','02_gold','03_marts','04_cross_marts','00_refresh_active_tables')) {
        if (-not $notebookIds[$nbName]) { continue }
        Write-Info "running $nbName ..."
        try {
            $inst = Invoke-NotebookRun -WorkspaceId $WorkspaceId -NotebookId $notebookIds[$nbName] -Token $fabToken
            Write-Ok "$nbName -> $($inst.status)"
        } catch {
            $msg = $_.Exception.Message.Split([char]10)[0]
            Write-Warn2 "$nbName run failed (continuing): $msg"
            $nbFailures += "$nbName : $msg"
        }
    }
    if ($nbFailures.Count) { $state.notebookRunFailures = $nbFailures }
} else {
    Write-Warn2 "Skipped notebook execution (-RunNotebooks:`$false). Run them to populate data + lineage."
}

# --- 7. App registration (optional) -----------------------------------------
if ($CreateAppRegistration) {
    Write-Step "Entra app registration"
    # az writes informational warnings to stderr (e.g. "permission grant ... is needed");
    # under -ErrorAction Stop + 2>&1 those would abort. Treat them as non-terminating here.
    $eapSaved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $appName = "$WorkspaceName-app"
        $appId = az ad app list --display-name $appName --query "[0].appId" -o tsv 2>$null
        if (-not $appId) {
            $appId = az ad app create --display-name $appName --sign-in-audience AzureADMyOrg --query appId -o tsv
        }
        $state.appRegistrationClientId = $appId   # record early so a later az warning can't lose it
        $objId = az ad app show --id $appId --query id -o tsv
        $redirects = @('http://localhost:5173')
        if ($DeployedAppUrl) { $redirects += $DeployedAppUrl }
        # az rest --body mangles inline JSON on Windows PowerShell; pass it via a temp file (@file).
        $spaBody = @{ spa = @{ redirectUris = $redirects } } | ConvertTo-Json -Compress -Depth 5
        $spaTmp = [IO.Path]::GetTempFileName()
        Set-Content -Path $spaTmp -Value $spaBody -Encoding ascii
        az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$objId" `
            --headers "Content-Type=application/json" --body "@$spaTmp" 2>$null | Out-Null
        Remove-Item $spaTmp -Force -ErrorAction SilentlyContinue
        # Delegated permissions: ADX user_impersonation + Graph User.Read +
        # Graph User.ReadBasic.All (directory people-picker in "Check lakehouse
        # access") + Power BI / Fabric Workspace.Read.All (reads workspace role
        # assignments via the Fabric REST API).
        $adxAppId = '2746ea77-4702-4b45-80ca-3c97e680e8b7'   # Azure Data Explorer
        $adxScope = az ad sp show --id $adxAppId --query "oauth2PermissionScopes[?value=='user_impersonation'].id | [0]" -o tsv 2>$null
        if ($adxScope) { az ad app permission add --id $appId --api $adxAppId --api-permissions "$adxScope=Scope" 2>$null | Out-Null }
        az ad app permission add --id $appId --api '00000003-0000-0000-c000-000000000000' `
            --api-permissions 'e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope' 2>$null | Out-Null
        # Graph User.ReadBasic.All (directory user search for the access drawer).
        az ad app permission add --id $appId --api '00000003-0000-0000-c000-000000000000' `
            --api-permissions 'b340eb25-3456-403f-be2f-af7a0d370277=Scope' 2>$null | Out-Null
        $pbiAppId = '00000009-0000-0000-c000-000000000000'   # Power BI Service / Fabric (api.fabric.microsoft.com)
        $pbiScope = az ad sp show --id $pbiAppId --query "oauth2PermissionScopes[?value=='Workspace.Read.All'].id | [0]" -o tsv 2>$null
        if ($pbiScope) { az ad app permission add --id $appId --api $pbiAppId --api-permissions "$pbiScope=Scope" 2>$null | Out-Null }
        # admin-consent makes the delegated permissions effective tenant-wide.
        az ad app permission admin-consent --id $appId 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Ok "Admin consent granted" }
        else { Write-Warn2 "Could not grant admin consent automatically - do it in the Entra portal (Kusto user_impersonation + Power BI Workspace.Read.All)." }
        Write-Ok "App registration clientId $appId"
    } catch {
        Write-Warn2 "App registration step failed (continuing): $($_.Exception.Message.Split([char]10)[0])"
        $state.appRegistrationError = $_.Exception.Message.Split([char]10)[0]
    } finally {
        $ErrorActionPreference = $eapSaved
    }
}

# --- 8. Deploy the Rayfin app -----------------------------------------------
if ($DeployApp) {
    Write-Step "Deploying the Rayfin app"
    if (-not $state.appRegistrationClientId) {
        Write-Warn2 "No app registration client id available - the app will deploy but interactive login won't work until VITE_*ENTRA_CLIENT_ID is set. Re-run with -CreateAppRegistration."
    }
    $clusterUri = Get-KustoResource $QueryUri
    # Bake the app config through rayfin/.env. `rayfin up` regenerates .env.local
    # from these on every build, emitting them as VITE_RAYFIN_* (see app/src/config.ts),
    # so hand-written VITE_* values would otherwise be lost.
    $rayfinEnv = @"
# Generated by scripts/deploy.ps1 for workspace '$WorkspaceName'.
# rayfin emits these as VITE_RAYFIN_* at build time (consumed by app/src/config.ts).
RAYFIN_PUBLIC_KUSTO_CLUSTER_URI=$clusterUri
RAYFIN_PUBLIC_KUSTO_DATABASE=$DbName
RAYFIN_PUBLIC_ENTRA_CLIENT_ID=$($state.appRegistrationClientId)
RAYFIN_PUBLIC_ENTRA_TENANT_ID=$TenantId
RAYFIN_PUBLIC_LINEAGE_WORKSPACE_ID=$WorkspaceId
RAYFIN_PUBLIC_REQUIRE_APP_LOGIN=false
"@
    $appDir = Join-Path $RepoRoot 'app'
    Set-Content -Path (Join-Path $appDir 'rayfin/.env') -Value $rayfinEnv -Encoding ascii
    Write-Ok "Wrote app/rayfin/.env"

    # By default the deployment builds the app from source (app/src) via `rayfin up`.
    # A prebuilt production bundle is also kept locally in app/prebuilt (not in git);
    # pass -UsePrebuiltApp:$true to re-host that bundle as-is instead of building.
    $origBuildCmd = $null
    if ($UsePrebuiltApp) {
        try {
            $cfg = [ordered]@{
                clusterUri               = $clusterUri
                databaseName             = $DbName
                entraClientId            = "$($state.appRegistrationClientId)"
                entraTenantId            = "$TenantId"
                workspaceId              = "$WorkspaceId"
                fabricPortalUrl          = 'https://app.fabric.microsoft.com'
                semanticModelWorkspaceId = ''
                semanticModelDatasetId   = ''
            }
            Set-PrebuiltAppDist -RepoRoot $RepoRoot -Config $cfg | Out-Null
            $origBuildCmd = Set-RayfinBuildCommand -RepoRoot $RepoRoot -NewCommand 'node -e "0"'
            Write-Ok "Staged prebuilt app bundle into app/dist (config -> $clusterUri / $DbName)"
        } catch {
            Write-Warn2 "Prebuilt bundle unavailable ($($_.Exception.Message.Split([char]10)[0])) - falling back to the source-built app."
            $UsePrebuiltApp = $false
        }
    }

    Push-Location $appDir
    try {
        Write-Info "npm install ..."; npm install | Out-Null
        Write-Info "rayfin up -w $WorkspaceName ..."
        # Call the CLI entry directly; the .bin shims trip the execution policy.
        node ./node_modules/@microsoft/rayfin-cli/scripts/main up -w $WorkspaceName -y
    } finally {
        Pop-Location
        if ($origBuildCmd) { Restore-RayfinBuildCommand -RepoRoot $RepoRoot -OriginalCommand $origBuildCmd }
    }

    # rayfin records the deployment (item id + public hosting URL) here.
    $depFile = Join-Path $appDir 'rayfin/.deployments.json'
    if (Test-Path $depFile) {
        $dep = (Get-Content $depFile -Raw | ConvertFrom-Json).deployments.$WorkspaceName
        if ($dep) {
            $state.appItemId = $dep.fabricItemId
            $state.appUrl    = $dep.hostingUrl
            Write-Ok "App deployed: $($dep.hostingUrl)"
            # Register the live hosting URL as an SPA redirect URI on the app reg so
            # MSAL can complete the auth redirect from the deployed app.
            if ($state.appRegistrationClientId -and $dep.hostingUrl) {
                $eapSaved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
                try {
                    $objId = az ad app show --id $state.appRegistrationClientId --query id -o tsv 2>$null
                    if ($objId) {
                        $redirects = @('http://localhost:5173', $dep.hostingUrl)
                        if ($DeployedAppUrl -and ($DeployedAppUrl -notin $redirects)) { $redirects += $DeployedAppUrl }
                        $spaBody = @{ spa = @{ redirectUris = $redirects } } | ConvertTo-Json -Compress -Depth 5
                        $spaTmp = [IO.Path]::GetTempFileName()
                        Set-Content -Path $spaTmp -Value $spaBody -Encoding ascii
                        az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$objId" `
                            --headers "Content-Type=application/json" --body "@$spaTmp" 2>$null | Out-Null
                        Remove-Item $spaTmp -Force -ErrorAction SilentlyContinue
                        Write-Ok "Added hosting URL to app registration SPA redirect URIs"
                    }
                } catch {
                    Write-Warn2 "Could not add hosting URL to app registration redirects: $($_.Exception.Message.Split([char]10)[0])"
                } finally { $ErrorActionPreference = $eapSaved }
            }
        }
    }
} else {
    Write-Warn2 "Skipped app deploy (-DeployApp:`$false). To deploy: cd app; npm install; npm run deploy"
}

# --- 9. State + summary -----------------------------------------------------
$state | ConvertTo-Json -Depth 10 | Set-Content -Path $StateFile -Encoding utf8
Write-Step "Done"
Write-Ok "State written to $StateFile"
Write-Host ""
Write-Host "  Workspace : $WorkspaceName ($WorkspaceId)" -ForegroundColor White
Write-Host "  Folders   : _lineage (infra), demo-data (lakehouses+notebooks), app at root" -ForegroundColor White
Write-Host "  Eventhouse: $DbName @ $QueryUri" -ForegroundColor White
Write-Host "  Lakehouses: $($lakehouseNames -join ', ')" -ForegroundColor White
Write-Host "  Notebooks : $($notebookIds.Keys -join ', ')" -ForegroundColor White
if ($state.appRegistrationClientId) { Write-Host "  App reg   : $($state.appRegistrationClientId)" -ForegroundColor White }
if ($state.appUrl) { Write-Host "  App URL   : $($state.appUrl)" -ForegroundColor White }
if ($state.appUrl) { Write-Host "  App build : $(if ($UsePrebuiltApp) { 'prebuilt bundle (app/prebuilt)' } else { 'source-built (app/src)' })" -ForegroundColor White }
Write-Host ""
Write-Host "  Open the workspace in Fabric to explore the lineage data, or run:" -ForegroundColor Gray
Write-Host "    cd app; npm install; npm run dev" -ForegroundColor Gray
Write-Host "  To remove everything:  ./scripts/teardown.ps1" -ForegroundColor Gray

# Reaching here means the deployment succeeded (any real error would have thrown
# under -ErrorAction Stop). Reset the exit code so a non-fatal `az` warning during
# the optional app-registration step (e.g. admin-consent needing portal rights)
# does not make the whole script report failure.
$global:LASTEXITCODE = 0
exit 0

