function New-StateReadBirthProof($value) {
  $proof=@{rawSerialization=(ConvertTo-Json -InputObject $value -Compress);type='null'}
  if($null -ne $value) {$proof.type=$value.GetType().FullName}
  if($value -is [DateTime]) {$proof.kind=$value.Kind.ToString()}
  if($value -is [DateTimeOffset]) {$proof.offset=$value.Offset.ToString()}
  return $proof
}
function Set-StateReadUtcTicks($value,$proof) {
  if($value -is [DateTimeOffset]) {$instant=$value}
  elseif($value -is [DateTime]) {
    if($value.Kind -eq [DateTimeKind]::Unspecified) {throw 'Unspecified DateTime kind is not a UTC generation proof'}
    if($value.Kind -eq [DateTimeKind]::Local) {
      $clock=[DateTime]::SpecifyKind($value,[DateTimeKind]::Unspecified)
      if([TimeZoneInfo]::Local.IsAmbiguousTime($clock) -or [TimeZoneInfo]::Local.IsInvalidTime($clock)) {throw 'Ambiguous/invalid local generation time'}
    }
    $instant=[DateTimeOffset]::new($value)
  } elseif($value -is [string]) {
    if($value -cnotmatch '\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})\z') {throw 'Generation ISO text requires an explicit timezone and at most7 fractional digits'}
    $instant=[DateTimeOffset]::Parse($value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None)
  } else {throw 'Unrecognized/missing generation timestamp type'}
  $proof.utcTicks=$instant.UtcDateTime.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
  $proof.utcSerialization=$instant.ToUniversalTime().ToString('o',[Globalization.CultureInfo]::InvariantCulture)
}
function Get-StateReadPid($value,$proof) {
  if($null -eq $value) {$proof.pidType='null'} else {$proof.pidType=$value.GetType().FullName}
  if(!($value -is [int] -or $value -is [long] -or $value -is [uint32] -or $value -is [uint64]) -or $value -le 0 -or $value -gt [uint32]::MaxValue) {throw 'Positive exact integral Windows PID required'}
  return [uint32]$value
}
function Assert-StateReadGeneration($requested,$observed,$proof) {
  $proof.match=$false
  $proof.requested=@{pid=$requested.pid;birth=(New-StateReadBirthProof $requested.started)}
  $proof.observed=@{found=($null -ne $observed);pid=$observed.ProcessId;birth=(New-StateReadBirthProof $observed.CreationDate)}
  $failures=@()
  foreach($pair in @(@{value=$requested.started;record=$proof.requested},@{value=$observed.CreationDate;record=$proof.observed})) {
    try {Set-StateReadUtcTicks $pair.value $pair.record.birth} catch {$pair.record.birth.error=$_.Exception.Message;$failures+=$_.Exception.Message}
    try {$null=Get-StateReadPid $pair.record.pid $pair.record} catch {$pair.record.pidError=$_.Exception.Message;$failures+=$_.Exception.Message}
  }
  if($failures.Count -ne 0) {throw ('Invalid consumer generation proof: '+($failures -join '; '))}
  if([uint64]$requested.pid -ne [uint64]$observed.ProcessId -or $proof.requested.birth.utcTicks -cne $proof.observed.birth.utcTicks) {throw 'Consumer PID generation changed before ACL capture'}
  $proof.match=$true
}
