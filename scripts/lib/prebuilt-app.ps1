# Helpers for re-hosting the prebuilt lineage SPA bundle.
#
# Deployments build the app from app/src by default. These helpers are only used
# when -UsePrebuiltApp:$true is passed to re-host a prebuilt production bundle
# (app/prebuilt/dist) kept locally as a backup instead of rebuilding from source.
# That bundle reads its runtime config from the localStorage key
# 'lineage.config.v1' (falling back to empty VITE_* build-time values), so we
# pre-seed that key via a tiny bootstrap <script> injected into index.html.

function Set-PrebuiltAppDist {
    <#
    .SYNOPSIS
        Stage the prebuilt app bundle into app/dist with runtime config
        pre-seeded into localStorage('lineage.config.v1').
    .PARAMETER RepoRoot
        Repository root (the folder containing 'app').
    .PARAMETER Config
        Ordered/hashtable with: clusterUri, databaseName, entraClientId,
        entraTenantId, workspaceId, fabricPortalUrl,
        semanticModelWorkspaceId, semanticModelDatasetId.
    #>
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config
    )
    $appDir = Join-Path $RepoRoot 'app'
    $src    = Join-Path $appDir 'prebuilt/dist'
    $dist   = Join-Path $appDir 'dist'
    $idxSrc = Join-Path $src 'index.html'
    if (-not (Test-Path $idxSrc)) {
        throw "Prebuilt app bundle not found at $src (expected index.html + assets/). It lives in app/prebuilt/."
    }
    if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
    New-Item -ItemType Directory -Path $dist | Out-Null
    Copy-Item (Join-Path $src '*') $dist -Recurse -Force

    # The stored JSON is itself a valid JS object literal; JSON.stringify(obj)
    # reproduces exactly the string the app later JSON.parse()s back out.
    $cfgJson = ($Config | ConvertTo-Json -Compress -Depth 5)
    $boot = "<script>try{var k='lineage.config.v1';if(!localStorage.getItem(k)){localStorage.setItem(k,JSON.stringify($cfgJson));}}catch(e){}</script>"

    $idx  = Join-Path $dist 'index.html'
    $html = Get-Content $idx -Raw
    if ($html -notmatch 'lineage\.config\.v1') {
        $html = $html -replace '(<script type="module")', "$boot`r`n    `$1"
        Set-Content -Path $idx -Value $html -Encoding utf8
    }
    return $dist
}

function Set-RayfinBuildCommand {
    <#
    .SYNOPSIS
        Rewrite app/rayfin/rayfin.yml staticHosting.buildCommand and return the
        original value so the caller can restore it in a finally block. A no-op
        build command makes `rayfin up` package the already-staged app/dist
        instead of rebuilding the (different) source app over it.
    #>
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$NewCommand
    )
    $yml  = Join-Path $RepoRoot 'app/rayfin/rayfin.yml'
    $text = Get-Content $yml -Raw
    $m = [regex]::Match($text, '(?m)^(\s*)buildCommand:\s*(.+?)\s*$')
    if (-not $m.Success) { throw "buildCommand not found in $yml" }
    $original = $m.Groups[2].Value
    $indent   = $m.Groups[1].Value
    $updated  = $text -replace '(?m)^(\s*)buildCommand:.*$', "${indent}buildCommand: $NewCommand"
    Set-Content -Path $yml -Value $updated -Encoding utf8
    return $original
}

function Restore-RayfinBuildCommand {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$OriginalCommand
    )
    $yml  = Join-Path $RepoRoot 'app/rayfin/rayfin.yml'
    $text = Get-Content $yml -Raw
    $m = [regex]::Match($text, '(?m)^(\s*)buildCommand:.*$')
    $indent = if ($m.Success) { $m.Groups[1].Value } else { '    ' }
    $text = $text -replace '(?m)^(\s*)buildCommand:.*$', "${indent}buildCommand: $OriginalCommand"
    Set-Content -Path $yml -Value $text -Encoding utf8
}

