param(
  [Parameter(Mandatory=$true)][string]$OutputPrefix,
  [string]$ScriptPath = 'D:\DeepSeekHarness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js',
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$DshArguments
)
$ErrorActionPreference = 'Stop'
$originalNodeMode = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $arguments = @('--expose-internals', $ScriptPath) + @($DshArguments | Where-Object { $null -ne $_ })
  $quoted = ($arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
  $process = Start-Process -FilePath 'D:\DeepSeekHarness\DeepSeek Harness.exe' -ArgumentList $quoted -PassThru -Wait -NoNewWindow -RedirectStandardOutput ($OutputPrefix + '.stdout.log') -RedirectStandardError ($OutputPrefix + '.stderr.log')
  if ($DshArguments -contains '--dump-config') {
    Get-Content -LiteralPath ($OutputPrefix + '.stdout.log') | Select-String -Pattern 'codex-auto-approval|experimental-auto-review|dsh-auto-review' -Context 1,3
  } else {
    Get-Content -LiteralPath ($OutputPrefix + '.stdout.log')
  }
  Get-Content -LiteralPath ($OutputPrefix + '.stderr.log')
  exit $process.ExitCode
} finally {
  $env:ELECTRON_RUN_AS_NODE = $originalNodeMode
}
