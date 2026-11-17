# read_gh_token.ps1 -- read the GitHub token from Windows Credential Manager via Win32 CredRead
# ASCII only.

$sig = @"
using System;
using System.Runtime.InteropServices;

public class CredApi {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr cred);
}
"@

if (-not ("CredApi" -as [type])) { Add-Type -TypeDefinition $sig }

$targets = @(
  "git:https://github.com",
  "LegacyGeneric:target=git:https://github.com",
  "github.com"
)

$found = $false
foreach ($t in $targets) {
  $ptr = [IntPtr]::Zero
  $ok = [CredApi]::CredRead($t, 1, 0, [ref]$ptr)
  if (-not $ok) { continue }

  $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredApi+CREDENTIAL])
  Write-Output ("  target   : " + $cred.TargetName)
  Write-Output ("  username : " + $cred.UserName)
  Write-Output ("  blobSize : " + $cred.CredentialBlobSize)

  if ($cred.CredentialBlobSize -gt 0) {
    $bytes = New-Object byte[] $cred.CredentialBlobSize
    [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)

    # try UTF-8 first, then UTF-16LE
    $utf8 = [System.Text.Encoding]::UTF8.GetString($bytes)
    $u16 = [System.Text.Encoding]::Unicode.GetString($bytes)

    $token = $null
    if ($utf8 -match '^[\x20-\x7E]+$') { $token = $utf8.Trim() }
    elseif ($u16 -match '^[\x20-\x7E]+$') { $token = $u16.Trim() }

    if ($token) {
      Set-Content -Path (Join-Path $env:TEMP "gh_token.txt") -Value $token -NoNewline -Encoding ascii
      Write-Output ("  TOKEN OK  length=" + $token.Length + "  prefix=" + $token.Substring(0, [Math]::Min(4, $token.Length)) + "...")
      $found = $true
    } else {
      Write-Output "  blob is not plain ASCII text"
    }
  }

  [CredApi]::CredFree($ptr) | Out-Null
  if ($found) { break }
}

if (-not $found) { Write-Output "  NOT FOUND" }
