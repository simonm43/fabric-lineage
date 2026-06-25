<#
.SYNOPSIS
    Decommission the Fabric Data Lineage demo provisioned by deploy.ps1.

.DESCRIPTION
    Deletes the workspace (which removes every item inside it - Eventhouse,
    lakehouses, environment, notebooks, and the Rayfin app backend if deployed
    there) and, optionally, the Entra app registration.

    By default it reads scripts/.deploy-state.json (written by deploy.ps1) so you
    can simply run ./teardown.ps1. You can also target resources explicitly.

.PARAMETER StateFile
    Path to the deploy state file. Default: scripts/.deploy-state.json.

.PARAMETER WorkspaceId
    Workspace to delete (overrides the state file).

.PARAMETER WorkspaceName
    Display name of the workspace to delete (resolved to an id). Use this when you
    don't have a state file. Ignored when -WorkspaceId is supplied.

.PARAMETER AppRegistrationClientId
    Entra app registration to delete (overrides the state file).

.PARAMETER KeepAppRegistration
    Do not delete the Entra app registration.

.PARAMETER ItemsOnly
    Delete every item inside the workspace but keep the workspace itself (and the
    app registration). Useful for re-deploying into a workspace you created by hand.

.PARAMETER Force
    Skip the confirmation prompt.

.EXAMPLE
    ./teardown.ps1

.EXAMPLE
    ./teardown.ps1 -WorkspaceName lineage-test -Force

.EXAMPLE
    ./teardown.ps1 -WorkspaceId <guid> -KeepAppRegistration -Force
#>
[CmdletBinding()]
param(
    [string]$StateFile = "$PSScriptRoot/.deploy-state.json",
    [string]$WorkspaceId,
    [string]$WorkspaceName,
    [string]$AppRegistrationClientId,
    [switch]$KeepAppRegistration,
    [switch]$ItemsOnly,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/lib/fabric.ps1"

$state = $null
if (Test-Path $StateFile) { $state = Get-Content $StateFile -Raw | ConvertFrom-Json }
if (-not $WorkspaceId            -and $state) { $WorkspaceId = $state.workspaceId }
if (-not $AppRegistrationClientId -and $state) { $AppRegistrationClientId = $state.appRegistrationClientId }

$fabToken = Get-AzToken

# Resolve a workspace name to its id when no id is available.
if (-not $WorkspaceId -and $WorkspaceName) {
    $ws = (Invoke-Fabric -Method GET -Path "/workspaces" -Token $fabToken).value |
            Where-Object { $_.displayName -eq $WorkspaceName } | Select-Object -First 1
    if (-not $ws) { throw "Workspace '$WorkspaceName' not found." }
    $WorkspaceId = $ws.id
}

if (-not $WorkspaceId) { throw "No workspace to delete. Pass -WorkspaceName, -WorkspaceId, or provide a state file." }

$wsName = $WorkspaceId
try { $wsName = (Invoke-Fabric -Method GET -Path "/workspaces/$WorkspaceId" -Token $fabToken).displayName } catch { }

Write-Host ""
Write-Host "About to DELETE:" -ForegroundColor Yellow
if ($ItemsOnly) {
    Write-Host "  ALL items inside workspace: $wsName ($WorkspaceId) - the workspace itself is kept" -ForegroundColor Yellow
} else {
    Write-Host "  Workspace: $wsName ($WorkspaceId) - and ALL items inside it" -ForegroundColor Yellow
}
if ($AppRegistrationClientId -and -not $KeepAppRegistration -and -not $ItemsOnly) {
    Write-Host "  Entra app registration: $AppRegistrationClientId" -ForegroundColor Yellow
}
Write-Host ""

if (-not $Force) {
    $answer = Read-Host "Type the workspace name '$wsName' to confirm"
    if ($answer -ne $wsName) { Write-Host "Aborted." -ForegroundColor Gray; return }
}

if ($ItemsOnly) {
    Write-Step "Deleting all items in $wsName (keeping the workspace)"
    # Retry a few passes: child items (SQL endpoints) disappear with their parent,
    # and an environment mid-publish returns 400 until publishing settles.
    for ($pass = 1; $pass -le 4; $pass++) {
        $items = (Invoke-Fabric -Method GET -Path "/workspaces/$WorkspaceId/items" -Token $fabToken).value
        if (-not $items -or $items.Count -eq 0) { break }
        Write-Info "pass $pass : $($items.Count) item(s) remaining"
        foreach ($it in $items) {
            try {
                Invoke-Fabric -Method DELETE -Path "/workspaces/$WorkspaceId/items/$($it.id)" -Token $fabToken | Out-Null
                Write-Ok "deleted $($it.type) $($it.displayName)"
            } catch {
                Write-Warn2 "skip $($it.type) $($it.displayName): $($_.Exception.Message.Split([char]10)[0])"
            }
        }
        Start-Sleep -Seconds 5
    }
    $left = (Invoke-Fabric -Method GET -Path "/workspaces/$WorkspaceId/items" -Token $fabToken).value
    if ($left -and $left.Count -gt 0) {
        Write-Warn2 "$($left.Count) item(s) could not be deleted; re-run teardown -ItemsOnly shortly."
    } else {
        Write-Ok "Workspace emptied"
    }
    Write-Step "Teardown complete"
    return
}

Write-Step "Deleting workspace $wsName"
try {
    Invoke-Fabric -Method DELETE -Path "/workspaces/$WorkspaceId" -Token $fabToken | Out-Null
    Write-Ok "Workspace deleted"
} catch {
    Write-Warn2 "Workspace delete failed: $($_.Exception.Message.Split([char]10)[0])"
}

if ($AppRegistrationClientId -and -not $KeepAppRegistration) {
    Write-Step "Deleting Entra app registration $AppRegistrationClientId"
    try { az ad app delete --id $AppRegistrationClientId 2>$null; Write-Ok "App registration deleted" }
    catch { Write-Warn2 "Could not delete app registration: $($_.Exception.Message)" }
}

# Clean up the local app artefacts the deploy step generates so the repo is left
# pristine (these are git-ignored): rayfin's per-deployment env + state, the Vite
# .env.local, and any hosting URLs rayfin appended to rayfin.yml.
if (-not $ItemsOnly) {
    $appDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'app'
    foreach ($rel in @('rayfin/.env', 'rayfin/.env.bak', 'rayfin/.deployments.json', '.env.local')) {
        $p = Join-Path $appDir $rel
        if (Test-Path $p) { Remove-Item $p -Force; Write-Ok "Removed app/$rel" }
    }
    $rayfinYml = Join-Path $appDir 'rayfin/rayfin.yml'
    if (Test-Path $rayfinYml) {
        $yml = Get-Content $rayfinYml
        $out = New-Object System.Collections.Generic.List[string]
        $inRedirects = $false
        foreach ($line in $yml) {
            if ($line -match '^\s*allowedRedirectUris:\s*$') {
                $out.Add($line)
                $indent = ($line -replace 'allowedRedirectUris:.*$', '')
                $out.Add("$indent  - http://localhost:5173")
                $inRedirects = $true
                continue
            }
            if ($inRedirects) {
                # Skip existing list entries; stop at the next non-list line.
                if ($line -match '^\s*-\s') { continue }
                $inRedirects = $false
            }
            $out.Add($line)
        }
        Set-Content -Path $rayfinYml -Value $out -Encoding ascii
        Write-Ok "Reset app/rayfin/rayfin.yml redirect URIs to localhost"
    }
}

if ($state -and (Test-Path $StateFile)) {
    Remove-Item $StateFile -Force
    Write-Ok "Removed $StateFile"
}
Write-Step "Teardown complete"
