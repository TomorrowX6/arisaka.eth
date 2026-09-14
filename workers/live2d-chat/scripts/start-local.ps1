$ErrorActionPreference = 'Stop'
# Windows DPAPI encrypts the local runtime keys for the current Windows user.
# Cloudflare account credentials are never stored here.
$storeRoot = Join-Path $env:LOCALAPPDATA 'ArisakaLive2D'
$storePath = Join-Path $storeRoot 'local-secrets.clixml'
if (!(Test-Path -LiteralPath $storePath)) {
    New-Item -ItemType Directory -Path $storeRoot -Force | Out-Null
    $deepseek = Read-Host 'Local DeepSeek API key' -AsSecureString
    $random = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($random)
    $rng.Dispose()
    $ipHash = ConvertTo-SecureString ([Convert]::ToBase64String($random)) -AsPlainText -Force
    @{ DEEPSEEK_API_KEY = $deepseek; IP_HASH_SECRET = $ipHash } | Export-Clixml -LiteralPath $storePath
    $acl = Get-Acl -LiteralPath $storePath
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.WindowsIdentity]::GetCurrent().Name, 'FullControl', 'Allow')
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $storePath -AclObject $acl
}
$saved = Import-Clixml -LiteralPath $storePath
if ($saved.ContainsKey('TURNSTILE_SECRET')) {
    $saved.Remove('TURNSTILE_SECRET')
    $saved | Export-Clixml -LiteralPath $storePath
}
if (!$saved.ContainsKey('DEEPSEEK_API_KEY')) {
    $saved['DEEPSEEK_API_KEY'] = Read-Host 'Local DeepSeek API key' -AsSecureString
    $saved | Export-Clixml -LiteralPath $storePath
}
$runtimeSecrets = @{}
try {
    foreach ($name in @('DEEPSEEK_API_KEY', 'IP_HASH_SECRET')) {
        if ($saved[$name] -isnot [System.Security.SecureString]) { throw "Invalid encrypted local secret: $name" }
        $runtimeSecrets[$name] = [System.Net.NetworkCredential]::new('', $saved[$name]).Password
    }
    $nodePath = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (!(Test-Path -LiteralPath $nodePath)) { throw 'Install official Node.js in Program Files before starting the local Worker.' }
    $runtimeSecrets | ConvertTo-Json -Compress | & $nodePath (Join-Path $PSScriptRoot 'dev-stdin.mjs')
} finally { $runtimeSecrets.Clear() }
