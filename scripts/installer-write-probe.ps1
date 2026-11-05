$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
if ($request.directories.Count -ne 2 -or $request.probeName -notmatch '^installer-write-probe-[a-f0-9-]{36}$') { throw 'Invalid owned installer probe request' }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rows = @(& (Join-Path $env:SystemRoot 'System32/whoami.exe') /priv /fo csv /nh)
if ($LASTEXITCODE -ne 0) { throw "Read-only token privilege query failed: $LASTEXITCODE" }
$privileges = @($rows | ConvertFrom-Csv -Header name,description,state | Where-Object { $_.name -in @('SeBackupPrivilege','SeRestorePrivilege') } | ForEach-Object { @{name=$_.name;state=$_.state} })
$probes = @(foreach ($directory in $request.directories) {
    $item = Get-Item -LiteralPath $directory -Force
    if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Probe requires a real installed directory' }
    $acl = Get-Acl -LiteralPath $directory
    $denies = @($acl.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $sid -and $_.AccessControlType -eq 'Deny' } | ForEach-Object { @{mask=[int64]$_.FileSystemRights;inherited=$_.IsInherited;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags} })
    $path = [IO.Path]::Combine($directory,$request.probeName)
    $stream = $null; $created = $false; $written = $false; $stage = 'open'; $exceptionType = $null; $hresult = $null; $nativeError = $null
    try {
        # FileOptions.None uses ordinary CreateFile access, without Node/libuv's backup-semantics flag.
        $stream = [IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,1,[IO.FileOptions]::None)
        $created = $true; $stage = 'write'; $stream.WriteByte(49); $written = $true; $outcome = 'write-succeeded'
    } catch {
        $leaf = $_.Exception
        while ($null -ne $leaf.InnerException) { $leaf = $leaf.InnerException }
        $exceptionType = $leaf.GetType().FullName; $hresult = [int64]$leaf.HResult; $nativeError = $leaf.HResult -band 65535
        $outcome = 'error'
    } finally { if ($null -ne $stream) { $stream.Dispose() } }
    @{directory=$directory;path=$path;ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;sddl=$acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access);explicitDenies=$denies;stage=$stage;created=$created;writeCompleted=$written;existsAfter=[IO.File]::Exists($path);outcome=$outcome;exceptionType=$exceptionType;hresult=$hresult;nativeError=$nativeError}
})
@{format=1;method='FileStream(CreateNew,Write,None)';fileOptions=0;sid=$sid;pid=$PID;powerShell=$PSVersionTable.PSVersion.ToString();dotnet=[Environment]::Version.ToString();privileges=$privileges;probes=$probes} | ConvertTo-Json -Depth 8 -Compress
