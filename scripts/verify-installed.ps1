param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$OutputRoot
)
$ErrorActionPreference = 'Stop'
$pchatExecutable = (Resolve-Path -LiteralPath $Executable).Path
if (-not [IO.Path]::IsPathFullyQualified($OutputRoot)) { throw 'OutputRoot must be absolute.' }
$pchatProbeRoot = Join-Path $OutputRoot ('installed-acceptance-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $pchatProbeRoot -Force | Out-Null
$pchatPreviousRoot = $env:PCHAT_DEV_ROOT
$pchatPreviousProbe = $env:PCHAT_ACCEPTANCE_PROBE
try {
    $env:PCHAT_DEV_ROOT = $pchatProbeRoot
    $env:PCHAT_ACCEPTANCE_PROBE = '1'
    $pchatProcess = Start-Process -FilePath $pchatExecutable -PassThru -WindowStyle Hidden
    if (-not $pchatProcess.WaitForExit(45000)) {
        Stop-Process -Id $pchatProcess.Id
        throw 'Installed application did not finish acceptance within 45 seconds.'
    }
    # GUI process exit codes alone do not prove that the page loaded.
    $pchatRecords = Get-Content -LiteralPath (Join-Path $pchatProbeRoot 'state/pchat/acceptance.ndjson') | ForEach-Object { $_ | ConvertFrom-Json }
    foreach ($pchatOperation in @('ListRoles', 'ListConversations', 'harness.subscribe')) {
        if (-not ($pchatRecords | Where-Object { $_.operation -eq $pchatOperation -and $_.ok -eq $true })) {
            throw "Missing successful installed UI operation: $pchatOperation"
        }
    }
    $pchatChildren = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $pchatProcess.Id -and $_.Name -eq 'pchat-node.exe' }
    if ($pchatChildren) { throw 'Bundled Runtime remained alive after application exit.' }
    $pchatResult = [ordered]@{ passed = $true; executable = $pchatExecutable; stateRoot = $pchatProbeRoot; operations = @($pchatRecords); runtimeCleanedUp = $true }
    $pchatResult | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $pchatProbeRoot 'result.json') -Encoding utf8
    $pchatResult | ConvertTo-Json -Depth 5
} finally {
    $env:PCHAT_DEV_ROOT = $pchatPreviousRoot
    $env:PCHAT_ACCEPTANCE_PROBE = $pchatPreviousProbe
}
