#requires -Version 5.1
<#
.SYNOPSIS
    Re-host the prebuilt lineage SPA bundle into the already-deployed workspace,
    pointed at that deployment's Eventhouse + app registration.

.DESCRIPTION
    A prebuilt production bundle is kept locally in app/prebuilt/dist as a backup
    (gitignored, not part of the repo). This script stages that bundle into
    app/dist with the runtime config pre-seeded into
    localStorage('lineage.config.v1'), then deploys it through the existing Rayfin
    app via `rayfin up` (temporarily neutralising the build command so the
    prebuilt dist is packaged as-is).

    It reads everything it needs from scripts/.deploy-state.json, so run a normal
    deploy.ps1 first. This does NOT re-provision the workspace, Eventhouse,
    lakehouses or notebooks - it only replaces the app's static content.

    Deployments build the source app (app/src) by default; re-run deploy.ps1
    (or `cd app; npm run deploy`) for that. Use this script only to re-host the
    local prebuilt backup.

.EXAMPLE
    ./scripts/deploy-app.ps1
#>
[CmdletBinding()]
param(
    [string]$StateFile = "$PSScriptRoot/.deploy-state.json"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
. "$PSScriptRoot/lib/fabric.ps1"
. "$PSScriptRoot/lib/prebuilt-app.ps1"

$RepoRoot = Split-Path $PSScriptRoot -Parent

Write-Step "Preflight"
if (-not (Test-Path $StateFile)) { throw "State file not found: $StateFile. Run deploy.ps1 first." }
$state = Get-Content $StateFile -Raw | ConvertFrom-Json
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) { throw "Not logged in. Run 'az login'." }
$WorkspaceName = $state.workspaceName
foreach ($k in 'workspaceName','queryUri','databaseName','workspaceId') {
    if (-not $state.$k) { throw "State is missing '$k' - re-run deploy.ps1." }
}
if (-not $state.appRegistrationClientId) {
    Write-Warn2 "State has no appRegistrationClientId - interactive login won't work until one is set."
}
Write-Ok "Workspace '$WorkspaceName' ($($state.workspaceId))"

# --- 1. Stage the prebuilt bundle with runtime config -----------------------
Write-Step "Staging prebuilt bundle"
$clusterUri = Get-KustoResource $state.queryUri
$cfg = [ordered]@{
    clusterUri               = $clusterUri
    databaseName             = $state.databaseName
    entraClientId            = "$($state.appRegistrationClientId)"
    entraTenantId            = "$($state.tenantId)"
    workspaceId              = "$($state.workspaceId)"
    fabricPortalUrl          = 'https://app.fabric.microsoft.com'
    semanticModelWorkspaceId = ''
    semanticModelDatasetId   = ''
}
$dist = Set-PrebuiltAppDist -RepoRoot $RepoRoot -Config $cfg
Write-Ok "Staged app/dist (config -> cluster $clusterUri, db $($state.databaseName))"

# --- 2. Deploy through Rayfin (no-op build so our dist is packaged) ----------
Write-Step "Deploying app (prebuilt bundle)"
$appDir = Join-Path $RepoRoot 'app'
$origBuild = Set-RayfinBuildCommand -RepoRoot $RepoRoot -NewCommand 'node -e "0"'
Push-Location $appDir
try {
    Write-Info "npm install ..."; npm install | Out-Null
    Write-Info "rayfin up -w $WorkspaceName ..."
    # rayfin-cli writes progress to stderr; under PowerShell that surfaces as a
    # NativeCommandError and aborts the script. Merge stderr->stdout and rely on
    # the process exit code instead.
    $eapRayfin = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $rayfinOut = & node ./node_modules/@microsoft/rayfin-cli/scripts/main up -w $WorkspaceName -y 2>&1
    $rayfinExit = $LASTEXITCODE
    $ErrorActionPreference = $eapRayfin
    $rayfinOut | ForEach-Object { Write-Host "    $_" }
    if ($rayfinExit -ne 0) { throw "rayfin up failed (exit $rayfinExit)" }
} finally {
    Pop-Location
    Restore-RayfinBuildCommand -RepoRoot $RepoRoot -OriginalCommand $origBuild
    Write-Ok "Restored rayfin.yml buildCommand"
}

# --- 3. Record + patch redirect URIs ----------------------------------------
$depFile = Join-Path $appDir 'rayfin/.deployments.json'
$appUrl  = $state.appUrl
if (Test-Path $depFile) {
    $dep = (Get-Content $depFile -Raw | ConvertFrom-Json).deployments.$WorkspaceName
    if ($dep) {
        $appUrl = $dep.hostingUrl
        $state.appItemId = $dep.fabricItemId
        $state.appUrl    = $dep.hostingUrl
        if ($state.appRegistrationClientId -and $dep.hostingUrl) {
            $eapSaved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            try {
                $objId = az ad app show --id $state.appRegistrationClientId --query id -o tsv 2>$null
                if ($objId) {
                    $redirects = @('http://localhost:5173', $dep.hostingUrl)
                    $spaBody = @{ spa = @{ redirectUris = $redirects } } | ConvertTo-Json -Compress -Depth 5
                    $spaTmp = [IO.Path]::GetTempFileName()
                    Set-Content -Path $spaTmp -Value $spaBody -Encoding ascii
                    az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$objId" `
                        --headers "Content-Type=application/json" --body "@$spaTmp" 2>$null | Out-Null
                    Remove-Item $spaTmp -Force -ErrorAction SilentlyContinue
                    Write-Ok "Ensured hosting URL is an SPA redirect URI"
                }
            } catch { Write-Warn2 "Could not patch redirect URIs: $($_.Exception.Message.Split([char]10)[0])" }
            finally { $ErrorActionPreference = $eapSaved }
        }
    }
}
$state | ConvertTo-Json -Depth 10 | Set-Content -Path $StateFile -Encoding utf8

# --- 4. Verify --------------------------------------------------------------
Write-Step "Verify"
# The expected main-bundle asset name (content-hashed) comes from the staged
# index.html, so this keeps working when the bundle is re-hashed after a patch.
$expectedAsset = $null
$localIdx = Join-Path $dist 'index.html'
if (Test-Path $localIdx) {
    $mm = [regex]::Match((Get-Content $localIdx -Raw), 'assets/(index-[^"'']+\.js)')
    if ($mm.Success) { $expectedAsset = $mm.Groups[1].Value }
}
if ($appUrl) {
    try {
        $resp = Invoke-WebRequest -Uri $appUrl -UseBasicParsing -TimeoutSec 60
        $servedExpected = $expectedAsset -and ($resp.Content -match [regex]::Escape($expectedAsset))
        Write-Ok "GET $appUrl -> HTTP $($resp.StatusCode) ($([int]$resp.RawContentLength) bytes)"
        if ($servedExpected) { Write-Ok "Serving the expected build ($expectedAsset)" }
        else { Write-Warn2 "Live index.html does not yet reference $expectedAsset - edge cache may be propagating; retry in a moment." }
    } catch {
        Write-Warn2 "Could not GET $appUrl yet: $($_.Exception.Message.Split([char]10)[0])"
    }
}
Write-Host ""
Write-Host "  App deployed." -ForegroundColor White
Write-Host "  App URL : $appUrl" -ForegroundColor White
Write-Host "  Backend : $($state.databaseName) @ $($state.queryUri)" -ForegroundColor White
Write-Host "  Sign in with a tenant user; lineage views query the Eventhouse above." -ForegroundColor Gray
Write-Host "  To deploy the source-built app instead: ./scripts/deploy.ps1 -UsePrebuiltApp:`$false" -ForegroundColor Gray
exit 0

