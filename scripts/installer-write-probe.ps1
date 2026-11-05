$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-InstallerProbeRequest([hashtable]$context) {
    $context.transport = @{inputBefore=[Console]::InputEncoding.CodePage;outputBefore=[Console]::OutputEncoding.CodePage;inputRedirected=[Console]::IsInputRedirected;outputRedirected=[Console]::IsOutputRedirected}
    # Node sends UTF8 bytes; never inherit an unrelated console codepage for redirected JSON.
    $utf8 = [Text.UTF8Encoding]::new($false,$true)
    [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $script:OutputEncoding = $utf8
    $context.transport.inputCodePage = [Console]::InputEncoding.CodePage; $context.transport.outputCodePage = [Console]::OutputEncoding.CodePage
    $text = [Console]::In.ReadToEnd(); $bytes = $utf8.GetBytes($text)
    if ($bytes.Length -gt 8192) { throw 'Installer probe request exceeds byte bound' }
    $context.transport.requestUtf8Base64 = [Convert]::ToBase64String($bytes)
    $request = ConvertFrom-Json -InputObject $text
    $context.transport.decodedDirectories = @($request.directories)
    if ($request.directories.Count -ne 2 -or $request.probeName -notmatch '^installer-write-probe-[a-f0-9-]{36}$') { throw 'Invalid owned installer probe request' }
    return $request
}
function Get-InstallerProbeDirectory([string]$directory,[hashtable]$context) {
    $check = @{directory=$directory;utf8Base64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($directory))}
    $context.directoryChecks += $check
    # Native metadata is diagnostic only; it can never replace a failed provider/type/reparse gate.
    try { $attributes = [IO.File]::GetAttributes($directory); $check.nativeMetadata = @{attributes=[int]$attributes;directory=[bool]($attributes -band [IO.FileAttributes]::Directory);reparse=[bool]($attributes -band [IO.FileAttributes]::ReparsePoint)} }
    catch { $leaf=$_.Exception; while($null -ne $leaf.InnerException){$leaf=$leaf.InnerException}; $check.nativeMetadata = @{errorType=$leaf.GetType().FullName;hresult=[int64]$leaf.HResult;message=$leaf.Message} }
    try {
        $item = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
        $check.provider = @{fullName=$item.FullName;directory=$item.PSIsContainer;reparse=[bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)}
        if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Probe requires a real installed directory' }
        return $item
    } catch { $check.providerError = @{type=$_.Exception.GetType().FullName;message=$_.Exception.Message;id=$_.FullyQualifiedErrorId;category=[string]$_.CategoryInfo}; throw }
}

$context = @{format=1;method='FileStream(CreateNew,Write,None)';fileOptions=0;directoryChecks=@();probes=@();stage='input';status='running';pid=$PID;powerShell=$PSVersionTable.PSVersion.ToString();dotnet=[Environment]::Version.ToString()}
$exitCode = 0
try {
    $request = Read-InstallerProbeRequest $context
    Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
    $context.stage = 'identity'
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $context.sid = $sid
    $rows = @(& (Join-Path $env:SystemRoot 'System32/whoami.exe') /priv /fo csv /nh)
    if ($LASTEXITCODE -ne 0) { throw "Read-only token privilege query failed: $LASTEXITCODE" }
    $context.privileges = @($rows | ConvertFrom-Csv -Header name,description,state | Where-Object { $_.name -in @('SeBackupPrivilege','SeRestorePrivilege') } | ForEach-Object { @{name=$_.name;state=$_.state} })
    foreach ($directory in $request.directories) {
        $context.stage = 'path-lookup'
        $item = Get-InstallerProbeDirectory $directory $context
        $context.stage = 'acl'
        $acl = Get-Acl -LiteralPath $directory
        $denies = @($acl.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $sid -and $_.AccessControlType -eq 'Deny' } | ForEach-Object { @{mask=[int64]$_.FileSystemRights;inherited=$_.IsInherited;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags} })
        $path = [IO.Path]::Combine($directory,$request.probeName)
        $stream = $null; $created = $false; $written = $false; $stage = 'open'; $exceptionType = $null; $hresult = $null; $nativeError = $null
        $context.stage = 'write-probe'
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
        $context.probes += @{directory=$directory;path=$path;ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;sddl=$acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access);explicitDenies=$denies;stage=$stage;created=$created;writeCompleted=$written;existsAfter=[IO.File]::Exists($path);outcome=$outcome;exceptionType=$exceptionType;hresult=$hresult;nativeError=$nativeError}
    }
    $context.status = 'complete'
} catch { $context.status='failed'; $context.failure=@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message;id=$_.FullyQualifiedErrorId;category=[string]$_.CategoryInfo}; $exitCode=1 }
[Console]::Out.WriteLine(($context | ConvertTo-Json -Depth 8 -Compress))
exit $exitCode
