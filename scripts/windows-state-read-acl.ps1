$ErrorActionPreference='Stop'
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$request=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$result=@{engine=$PSVersionTable.PSVersion.ToString();securityModule=(Get-Module Microsoft.PowerShell.Security).Version.ToString();errors=@();entries=@()}
function OwnedItem($path) {
  if($path -ine $request.root -and !$path.StartsWith($request.root+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'ACL path outside owned state'}
  $item=Get-Item -LiteralPath $path -Force
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'State ACL must not traverse a reparse item'}
  return $item
}
function Snapshot($path) {
  $item=OwnedItem $path;$acl=Get-Acl -LiteralPath $path
  return @{path=$path;directory=$item.PSIsContainer;sddl=$acl.Sddl;aces=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();mask=[int64]$_.FileSystemRights;inherited=$_.IsInherited;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags} })}
}
try {
  if($request.action -eq 'capture') {
    $result.sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $consumer=Get-CimInstance Win32_Process -Filter "ProcessId=$($request.consumer.pid)"
    if(!$consumer -or $consumer.CreationDate.ToUniversalTime().ToString('o') -cne $request.consumer.started) {throw 'Consumer PID generation changed before ACL capture'}
    $owner=Invoke-CimMethod -InputObject $consumer -MethodName GetOwnerSid
    if($owner.ReturnValue -ne 0 -or $owner.Sid -ne $result.sid) {throw 'ACL caller and actual consumer must have the same SID'}
    $result.consumerSid=$owner.Sid
    foreach($path in $request.paths) {$result.entries+=Snapshot $path}
  } elseif($request.action -eq 'deny') {
    $item=OwnedItem $request.root;$acl=Get-Acl -LiteralPath $request.root
    $sid=[Security.Principal.SecurityIdentifier]::new($request.sid)
    $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]1,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Deny)
    $acl.AddAccessRule($rule);Set-Acl -LiteralPath $request.root -AclObject $acl
  } elseif($request.action -eq 'restore') {
    foreach($entry in $request.before) {
      try {$item=OwnedItem $entry.path;$acl=Get-Acl -LiteralPath $entry.path;$acl.SetSecurityDescriptorSddlForm($entry.sddl);Set-Acl -LiteralPath $entry.path -AclObject $acl}
      catch {$result.errors+=@{stage='restore';path=$entry.path;message=$_.Exception.Message;hresult=$_.Exception.HResult}}
    }
  } else {throw 'Unknown state ACL action'}
} catch {$result.errors+=@{stage=$request.action;message=$_.Exception.Message;hresult=$_.Exception.HResult}}
finally {
  if($request.action -ne 'capture') {foreach($path in $request.paths) {try {$result.entries+=Snapshot $path} catch {$result.errors+=@{stage='readback';path=$path;message=$_.Exception.Message;hresult=$_.Exception.HResult}}}}
  $result | ConvertTo-Json -Depth 8 -Compress
}
