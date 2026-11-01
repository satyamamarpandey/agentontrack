# Installs AgentOnTrack for this user, with no administrator rights and nothing else required.
# Usage: irm https://pandeysatyam.com/agentontrack/install.ps1 | iex
# Options through the environment, because a piped script takes no arguments: AOT_VERSION, AOT_FROM, AOT_NO_PATH=1.
& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = 'satyamamarpandey/agentontrack'
$version = $env:AOT_VERSION
$from = $env:AOT_FROM

function Fail($message) { throw "AgentOnTrack install failed: $message" }

$arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($arch -eq 'Arm64') { Write-Host 'Windows on Arm: using the x64 build, through Windows emulation. This combination has not been tested.' }
elseif ($arch -ne 'X64') { Fail "no build for $arch. Supported: x64." }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("aot-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  function Get-ReleaseFile($name, $dest) {
    if ($from) {
      if (-not (Test-Path -LiteralPath (Join-Path $from $name))) { Fail "$name is not in $from" }
      Copy-Item -LiteralPath (Join-Path $from $name) $dest
      return
    }
    $url = if ($version) { "https://github.com/$repo/releases/download/v$version/$name" } else { "https://github.com/$repo/releases/latest/download/$name" }
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $dest }
    catch { Fail "could not download $url. See https://github.com/$repo/releases" }
  }

  $sums = Join-Path $tmp 'SHA256SUMS'
  Get-ReleaseFile 'SHA256SUMS' $sums
  $pattern = if ($version) { "agentontrack-$([regex]::Escape($version))-windows-x64\.zip$" } else { 'agentontrack-.*-windows-x64\.zip$' }
  $line = Get-Content $sums | Where-Object { $_ -match $pattern } | Select-Object -First 1
  if (-not $line) { Fail 'this release has no Windows build.' }
  $want, $file = $line -split '\s+'
  $zip = Join-Path $tmp $file
  Get-ReleaseFile $file $zip
  # .NET rather than Get-FileHash or Expand-Archive, whose modules may not load in every PowerShell setup.
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($zip)
  try { $got = ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLower() } finally { $stream.Dispose(); $sha.Dispose() }
  if ($got -ne $want.ToLower()) { Fail "checksum mismatch for ${file}: expected $want, got $got. Nothing was installed." }
  Write-Host "Checksum verified: $file"

  $ver = $file -replace '^agentontrack-(.*)-windows-x64\.zip$', '$1'
  $homeDir = if ($env:AGENTONTRACK_HOME) { $env:AGENTONTRACK_HOME } else { Join-Path $HOME '.agentontrack' }
  $app = Join-Path $homeDir 'app'
  $versions = Join-Path $app 'versions'
  New-Item -ItemType Directory -Force -Path $versions | Out-Null
  $x = Join-Path $tmp 'x'
  New-Item -ItemType Directory -Path $x | Out-Null
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $zip -C $x
  if ($LASTEXITCODE -ne 0) { Fail "could not unpack $file." }
  $dest = Join-Path $versions $ver
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item (Join-Path $x ($file -replace '\.zip$', '')) $dest
  foreach ($n in 'uninstall-pending', 'uninstall-purge') { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath (Join-Path $app $n) }
  $env:AGENTONTRACK_HOME = $homeDir
  & (Join-Path $dest 'node\node.exe') (Join-Path $dest 'lib\cli.mjs') self activate --version $ver | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'the bundled program would not start on this system.' }

  $bin = Join-Path $app 'bin'
  if ($env:AOT_NO_PATH -ne '1') {
    # Read unexpanded, so %VAR% entries in the user's PATH survive.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    $userPath = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    if (-not (($userPath -split ';') -contains $bin)) { $key.SetValue('Path', ((@($userPath, $bin) | Where-Object { $_ }) -join ';'), 'ExpandString') }
    $key.Close()
    [Environment]::SetEnvironmentVariable('AOT_PATH_REFRESH', $null, 'User')
  }
  & (Join-Path $bin 'agentontrack.cmd') --version | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'installed, but the program did not start.' }
  Write-Host "AgentOnTrack $ver is installed in $app"
  if ($env:AOT_NO_PATH -ne '1') { Write-Host 'Open a new terminal, so the PATH change applies.' } else { Write-Host "Add this to your PATH: $bin" }
  Write-Host 'Then, in a project folder: agentontrack setup'
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
}
