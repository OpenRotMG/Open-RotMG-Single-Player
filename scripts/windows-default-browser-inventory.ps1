$ErrorActionPreference='Stop'
$report=[ordered]@{errors=@();notReady=@();profileContentsRead=$false}
try {
function Observe($name,[scriptblock]$action) {
  try { $report[$name]=& $action } catch { $report.errors+=@{stage=$name;type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult;message=$_.Exception.Message} }
}
Add-Type -TypeDefinition @'
#pragma warning disable SYSLIB0057
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
public static class DefaultBrowserNative {
  [DllImport("shlwapi.dll",CharSet=CharSet.Unicode)] static extern int AssocQueryString(uint flags,uint kind,string association,string extra,StringBuilder output,ref uint length);
  [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id,uint flags,IntPtr token,out IntPtr path);
  [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command,out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern uint GetDriveType(string root);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct FileInfo {public uint size;[MarshalAs(UnmanagedType.LPWStr)] public string path;public IntPtr file;public IntPtr subject;}
  [StructLayout(LayoutKind.Sequential)] struct TrustData {public uint size;public IntPtr policy,sip;public uint ui,revocation,choice;public IntPtr file;public uint action;public IntPtr state,url;public uint flags,context;public IntPtr settings;}
  [DllImport("wintrust.dll",ExactSpelling=true)] static extern int WinVerifyTrust(IntPtr window,ref Guid action,ref TrustData data);
  public static object Query(uint kind) {
    uint length=0;int first=AssocQueryString(0x1000,kind,"http",null,null,ref length);
    if(length==0||length>32768)return new {hresult=first,value=(string)null};
    var output=new StringBuilder((int)length);int result=AssocQueryString(0x1000,kind,"http",null,output,ref length);
    return new {hresult=result,value=result==0?output.ToString():null};
  }
  public static string KnownFolder(string value) {
    Guid id=new Guid(value);IntPtr result;Marshal.ThrowExceptionForHR(SHGetKnownFolderPath(ref id,0x4000,IntPtr.Zero,out result));
    try{if(result==IntPtr.Zero)throw new InvalidOperationException("Known folder did not resolve a path");return Marshal.PtrToStringUni(result);}finally{Marshal.FreeCoTaskMem(result);}
  }
  public static string[] Words(string command) {
    int count;IntPtr result=CommandLineToArgvW(command,out count);if(result==IntPtr.Zero)throw new InvalidOperationException("Cannot inspect command-line profile options");
    try{var words=new string[count];for(int i=0;i<count;i++)words[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(result,i*IntPtr.Size));return words;}finally{LocalFree(result);}
  }
  public static int OfflineTrust(string path) {
    var file=new FileInfo{size=(uint)Marshal.SizeOf(typeof(FileInfo)),path=path};IntPtr pointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
    try{
      Marshal.StructureToPtr(file,pointer,false);
      // Cache-only retrieval and no revocation checks prohibit network fetches by WinTrust.
      var data=new TrustData{size=(uint)Marshal.SizeOf(typeof(TrustData)),ui=2,choice=1,file=pointer,flags=0x1010};
      Guid action=new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");return WinVerifyTrust(new IntPtr(-1),ref action,ref data);
    }finally{Marshal.DestroyStructure(pointer,typeof(FileInfo));Marshal.FreeHGlobal(pointer);}
  }
  public static string Signer(string path) {using(var certificate=new X509Certificate2(X509Certificate.CreateFromSignedFile(path)))return certificate.Subject;}
}
'@
function LocalPath([string]$path) {
  if($path -notmatch '^[A-Za-z]:\\' -or $path.Contains('%')) {throw 'Absolute unexpanded local-drive path required'}
  $root=[IO.Path]::GetPathRoot($path)
  if([DefaultBrowserNative]::GetDriveType($root) -ne 3) {throw 'Only fixed local drives may be inspected'}
  $parent=$root
  foreach($piece in $path.Substring($root.Length).Split('\',[StringSplitOptions]::RemoveEmptyEntries)) {
    if($piece -eq '..' -or $piece -eq '.') {throw 'Noncanonical path component'}
    $parent=[IO.Path]::Combine($parent,$piece)
    try { $item=Get-Item -LiteralPath $parent -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { return @{path=$path;exists=$false;observation='ItemNotFound'} }
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Reparse path is not a proven local namespace'}
  }
  return @{path=$path;exists=$true}
}
function RegistryValues([string]$path,[string[]]$names) {
  try {$key=Get-Item -LiteralPath $path -ErrorAction Stop}
  catch [System.Management.Automation.ItemNotFoundException] {return @{path=$path;exists=$false}}
  $values=@{path=$path;exists=$true}
  foreach($name in $names) {$values[$name]=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}
  return $values
}
function ProfileOptions([string]$command) {
  $words=[DefaultBrowserNative]::Words($command);$values=@()
  for($i=0;$i -lt $words.Length;$i++) {
    if($words[$i] -eq '--user-data-dir') {if(++$i -ge $words.Length -or $words[$i].StartsWith('--')) {throw 'Missing profile override'};$values+= $words[$i]}
    elseif($words[$i].StartsWith('--user-data-dir=')) {$values+=$words[$i].Substring(16)}
  }
  if($values.Count -gt 1 -or ($values.Count -eq 1 -and $values[0] -notmatch '^[A-Za-z]:\\')) {throw 'Ambiguous/empty/nonlocal profile override'}
  if($values.Count -eq 1) {return $values[0]};return $null
}
Observe resolver { @{executable=[DefaultBrowserNative]::Query(2);command=[DefaultBrowserNative]::Query(1);progId=[DefaultBrowserNative]::Query(20)} }
Observe userChoice {RegistryValues 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice' @('ProgId')}
Observe httpCommand {RegistryValues 'Registry::HKEY_CLASSES_ROOT\http\shell\open\command' @('','DelegateExecute')}
$prog=$report.resolver.progId.value
if(!$prog -or $report.resolver.progId.hresult -ne 0) {$report.notReady+='Native HTTP ProgID resolution unavailable; registry is attribution only'}
if($report.userChoice.ProgId -and $prog -and $report.userChoice.ProgId -ine $prog) {$report.notReady+='Native ProgID differs from raw UserChoice; indirection is not assumed safe'}
if($prog) {
  Observe progId {
    if($prog -notmatch '^[A-Za-z0-9_.-]{1,200}$') {throw 'Unsupported HTTP ProgID shape'}
    @{command=(RegistryValues "Registry::HKEY_CLASSES_ROOT\$prog\shell\open\command" @('','DelegateExecute'));application=(RegistryValues "Registry::HKEY_CLASSES_ROOT\$prog\Application" @('AppUserModelID','ApplicationName','ApplicationCompany'));appx=($prog.StartsWith('AppX'))}
  }
  if($report.progId.appx -or $report.progId.command.DelegateExecute) {$report.notReady+='AppX/delegated HTTP association; direct target/profile semantics are not assumed'}
}
Observe localAppData {[DefaultBrowserNative]::KnownFolder('F1B32785-6FBA-4FCF-9D55-7B8E7F157091')}
Observe target {
  if($report.resolver.executable.hresult -ne 0 -or !$report.resolver.executable.value) {throw 'Native ASSOCSTR_EXECUTABLE did not resolve HTTP; see raw HRESULT'}
  $path=$report.resolver.executable.value;$state=LocalPath $path;if(!$state.exists) {throw 'Resolved target image missing'}
  $file=Get-Item -LiteralPath $path -Force;if($file.PSIsContainer) {throw 'Resolved target is not an image file'}
  $trust=[DefaultBrowserNative]::OfflineTrust($path);$signer=$null;if($trust -eq 0) {$signer=[DefaultBrowserNative]::Signer($path)}
  @{path=$path;company=$file.VersionInfo.CompanyName;product=$file.VersionInfo.ProductName;version=$file.VersionInfo.FileVersion;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();offlineWinTrust=$trust;signer=$signer;trustNetworkRetrieval='CACHE_ONLY; revocation disabled; no online verification claimed'}
}
if($report.target) {
  $target=$report.target;$relative=$null;$policy=$null
  if($target.path -match '\\Microsoft\\Edge\\Application\\msedge\.exe$' -and $target.product -eq 'Microsoft Edge' -and $target.company -eq 'Microsoft Corporation' -and $target.signer -eq 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US') {$relative='Microsoft\Edge\User Data';$policy='Microsoft\Edge'}
  elseif($target.path -match '\\Google\\Chrome\\Application\\chrome\.exe$' -and $target.product -eq 'Google Chrome' -and $target.company -eq 'Google LLC' -and $target.signer -eq 'CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US') {$relative='Google\Chrome\User Data';$policy='Google\Chrome'}
  if($target.offlineWinTrust -ne 0) {$report.notReady+='Offline native image trust did not validate; no online retry'}
  if(!$relative) {$report.notReady+='Unsupported target publisher/product/default-profile semantics'}
  if($relative -and $report.localAppData) {
    Observe profileNamespace {LocalPath ([IO.Path]::Combine($report.localAppData,$relative))}
    if($report.profileNamespace.exists) {$report.notReady+='Existing default profile namespace must not be adopted'}
    Observe policyOverrides { @{user=(RegistryValues "Registry::HKEY_CURRENT_USER\Software\Policies\$policy" @('UserDataDir'));machine=(RegistryValues "Registry::HKEY_LOCAL_MACHINE\Software\Policies\$policy" @('UserDataDir'))} }
    foreach($scope in @('user','machine')) {if($report.policyOverrides[$scope].UserDataDir) {$report.notReady+='UserDataDir policy present; default namespace is not assumed';Observe "policyNamespace:$scope" {LocalPath ([Environment]::ExpandEnvironmentVariables($report.policyOverrides[$scope].UserDataDir))}}}
  }
  if($report.resolver.command.hresult -ne 0 -or !$report.resolver.command.value) {$report.notReady+='Native HTTP command resolution unavailable; no registry command substitution'}
  else {
    Observe commandBinding { $words=[DefaultBrowserNative]::Words($report.resolver.command.value);if([Environment]::ExpandEnvironmentVariables($words[0]) -ine $target.path) {$report.notReady+='Native command and executable differ; activation indirection is not assumed safe'};return @{sameTarget=([Environment]::ExpandEnvironmentVariables($words[0]) -ieq $target.path)} }
    Observe associationProfileOverride {ProfileOptions $report.resolver.command.value}
    if($report.associationProfileOverride) {$report.notReady+='Association profile override requires separate ownership contract';Observe associationProfileNamespace {LocalPath ([Environment]::ExpandEnvironmentVariables($report.associationProfileOverride))}}
  }
  $report.targetProcesses=@()
  Observe processInspection {
    $name=[IO.Path]::GetFileName($target.path).Replace("'","''")
    foreach($p in @(Get-CimInstance Win32_Process -Filter "Name='$name'")) {
      if(!$p.ExecutablePath) {throw 'Target-named process image is unreadable; ownership unknown'}
      if($p.ExecutablePath -ine $target.path) {continue}
      $record=@{pid=$p.ProcessId;image=$p.ExecutablePath;inspection='partial'};$report.targetProcesses+=$record
      if($p.CreationDate) {$record.birth=$p.CreationDate.ToUniversalTime().ToString('o')}
      if(!$p.CommandLine -or !$p.CreationDate) {throw 'Target process generation/profile inspection failed'}
      $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ProcessId)"
      if(!$current -or $current.CreationDate -ne $p.CreationDate -or $current.ExecutablePath -ine $p.ExecutablePath -or $current.CommandLine -cne $p.CommandLine) {throw 'Target process generation changed during inspection'}
      $record.profileOverride=ProfileOptions $p.CommandLine;$record.inspection='complete'
    }
    return @{complete=$true}
  }
  if($report.targetProcesses.Count -gt 0) {$report.notReady+='Preexisting target-image processes; no adoption permitted'}
}
$report.routingReadiness='UNMEASURED; no browser execution or profile creation'
} catch { $report.errors+=@{stage='collector';type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult;message=$_.Exception.Message} }
finally { $report | ConvertTo-Json -Depth 12 -Compress }
