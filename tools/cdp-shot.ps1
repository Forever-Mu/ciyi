# CDP mobile-viewport screenshot helper (ASCII only -- PowerShell 5.1 reads BOM-less .ps1 as ANSI)
# Usage: powershell -File cdp-shot.ps1 -Url "http://127.0.0.1:8899/index.html#home" -Out "D:\x.png"

param(
  [string]$Url = "http://127.0.0.1:8899/index.html",
  [string]$Out = "shot.png",
  [int]$Width = 390,
  [int]$Height = 844,
  [int]$Port = 9222,
  [int]$WaitMs = 6000,
  # Optional: navigate here first (same origin) to populate IndexedDB before shooting
  [string]$SeedUrl = "",
  [int]$SeedWaitMs = 20000
)

$ErrorActionPreference = "Stop"

$edge = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { Write-Output "ERROR: Edge not found"; exit 1 }

$profile = Join-Path $env:TEMP ("cdp-profile-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$profile",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=$($Width + 16),$($Height + 120)",
  $Url
)

$targets = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $targets = Invoke-RestMethod "http://127.0.0.1:$Port/json" -TimeoutSec 3
    if ($targets) { break }
  } catch { }
}
if (-not $targets) { Write-Output "ERROR: debug port not ready"; exit 1 }

$page = $targets | Where-Object { $_.type -eq "page" } | Select-Object -First 1
if (-not $page) { Write-Output "ERROR: no page target"; exit 1 }

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [System.Threading.CancellationToken]::None
$null = $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $ct).Wait(10000)

function Send-Cdp([int]$id, [string]$method, $params) {
  $obj = @{ id = $id; method = $method; params = $params }
  $json = $obj | ConvertTo-Json -Depth 12 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $bytes)
  $null = $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait(10000)
}

function Receive-Until([int]$wantId) {
  $buf = New-Object byte[] 8388608
  for ($k = 0; $k -lt 300; $k++) {
    $sb = New-Object System.Text.StringBuilder
    do {
      $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $buf)
      $r = $ws.ReceiveAsync($seg, $ct).Result
      [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
    } while (-not $r.EndOfMessage)
    $o = $sb.ToString() | ConvertFrom-Json
    if ($o.id -eq $wantId) { return $o }
  }
  return $null
}

Send-Cdp 1 "Emulation.setDeviceMetricsOverride" @{
  width = $Width; height = $Height; deviceScaleFactor = 2; mobile = $true
}
$null = Receive-Until 1

# Optional: seed IndexedDB first (same origin as the target URL)
if ($SeedUrl -ne "") {
  Send-Cdp 3 "Page.navigate" @{ url = $SeedUrl }
  $null = Receive-Until 3
  Start-Sleep -Milliseconds $SeedWaitMs
  Send-Cdp 4 "Page.navigate" @{ url = $Url }
  $null = Receive-Until 4
  Start-Sleep -Milliseconds $WaitMs
} else {
  Start-Sleep -Milliseconds $WaitMs
}

Send-Cdp 2 "Page.captureScreenshot" @{ format = "png"; fromSurface = $true }
$shot = Receive-Until 2
if ($shot -and $shot.result -and $shot.result.data) {
  [IO.File]::WriteAllBytes($Out, [Convert]::FromBase64String($shot.result.data))
  Write-Output ("OK " + $Out)
} else {
  Write-Output "ERROR: capture failed"
}

try { $ws.Dispose() } catch { }
try {
  $kids = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $proc.Id) -ErrorAction SilentlyContinue
  foreach ($c in $kids) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
} catch { }
Start-Sleep -Milliseconds 500
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
