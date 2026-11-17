# push_via_api.ps1 -- commit via GitHub Git Data API when `git push` is unavailable
# Produces ONE commit (so only one CI run is triggered).
# ASCII only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI and would garble non-ASCII text.

param(
  [string]$Repo = "Forever-Mu/ciyi",
  [string]$Branch = "main",
  [string]$Message = "update",
  [string]$Root = "D:\personal\study\en-word-memory"
)

$ErrorActionPreference = "Stop"

# PowerShell 5.1 默认可能不用 TLS1.2，GitHub 只接受 TLS1.2+
try {
  [Net.ServicePointManager]::SecurityProtocol = `
    [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11
} catch { }

$token = $null

# 1) 先看临时文件（由 read_gh_token.ps1 写入）
$tmpDir = $env:TEMP
if (-not $tmpDir) { $tmpDir = [System.IO.Path]::GetTempPath() }
if (-not $tmpDir) { $tmpDir = "C:\Windows\Temp" }
$tokFile = Join-Path $tmpDir "gh_token.txt"
Write-Output "  token file: $tokFile"
if (Test-Path $tokFile) {
  $token = (Get-Content $tokFile -Raw).Trim()
  if ($token) { Write-Output "  token: from file (length $($token.Length))" }
}

# 2) 再退回 git credential fill
if (-not $token) {
  $out = "protocol=https`nhost=github.com`n`n" | & git credential fill 2>&1
  foreach ($line in $out) { if ($line -match '^password=(.+)$') { $token = $Matches[1] } }
  if ($token) { Write-Output "  token: from git credential fill" }
}

if (-not $token) { Write-Output "ERROR: no GitHub credential available"; exit 1 }

$H = @{
  Authorization = "Bearer $token"
  Accept        = "application/vnd.github+json"
  'User-Agent'  = 'dsh'
}

function Invoke-Api {
  param([string]$Method, [string]$Path, $Body)

  $uri = "https://api.github.com/repos/$Repo$Path"
  $json = if ($null -eq $Body) { $null } else { $Body | ConvertTo-Json -Depth 10 -Compress }
  $payload = if ($null -eq $json) { $null } else { [System.Text.Encoding]::UTF8.GetBytes($json) }

  $lastErr = $null
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      if ($null -eq $payload) {
        return Invoke-RestMethod -Uri $uri -Method $Method -Headers $H -TimeoutSec 60
      }
      return Invoke-RestMethod -Uri $uri -Method $Method -Headers $H -Body $payload `
        -ContentType "application/json; charset=utf-8" -TimeoutSec 60
    } catch {
      $lastErr = $_
      Write-Output ("        retry $attempt/5: " + $_.Exception.Message)
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
  throw $lastErr
}

Write-Output "  [1/6] read branch head"
$ref = Invoke-Api "GET" "/git/ref/heads/$Branch" $null
$baseCommit = $ref.object.sha
$commit = Invoke-Api "GET" "/git/commits/$baseCommit" $null
$baseTree = $commit.tree.sha
Write-Output "        HEAD=$($baseCommit.Substring(0,7))  tree=$($baseTree.Substring(0,7))"

Write-Output "  [2/6] collect changed files"
$changed = & git -C $Root diff --name-only "origin/$Branch" 2>&1 | Where-Object { $_ -and $_.Trim() }
if (-not $changed) { Write-Output "        nothing to commit"; exit 0 }
foreach ($f in $changed) { Write-Output "        $f" }

Write-Output "  [3/6] upload blobs"
$entries = @()
foreach ($f in $changed) {
  $full = Join-Path $Root ($f -replace '/', '\')
  if (-not (Test-Path $full)) { Write-Output "        SKIP (deleted): $f"; continue }
  $raw = [System.IO.File]::ReadAllBytes($full)
  $b64 = [Convert]::ToBase64String($raw)
  $blob = Invoke-Api "POST" "/git/blobs" @{ content = $b64; encoding = "base64" }
  $entries += @{ path = $f; mode = "100644"; type = "blob"; sha = $blob.sha }
  Write-Output "        $f -> $($blob.sha.Substring(0,8))  ($($raw.Length) B)"
}

if ($entries.Count -eq 0) { Write-Output "        no blobs uploaded"; exit 0 }

Write-Output "  [4/6] create tree"
$tree = Invoke-Api "POST" "/git/trees" @{ base_tree = $baseTree; tree = $entries }
Write-Output "        tree=$($tree.sha.Substring(0,8))"

Write-Output "  [5/6] create commit"
$newCommit = Invoke-Api "POST" "/git/commits" @{
  message = $Message
  tree    = $tree.sha
  parents = @($baseCommit)
}
Write-Output "        commit=$($newCommit.sha.Substring(0,8))"

Write-Output "  [6/6] update branch ref"
$upd = Invoke-Api "PATCH" "/git/refs/heads/$Branch" @{ sha = $newCommit.sha; force = $false }
Write-Output "        branch -> $(($upd.object.sha).Substring(0,8))"

& git -C $Root update-ref "refs/remotes/origin/$Branch" $newCommit.sha 2>&1 | Out-Null

Write-Output ""
Write-Output "  DONE $($newCommit.sha.Substring(0,7))"
