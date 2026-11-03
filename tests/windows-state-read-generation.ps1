param([Parameter(Mandatory=$true)][string]$Helper)
$ErrorActionPreference='Stop'
. $Helper
$passed=0
function Match($pidA,$a,$pidB,$b) {
  $proof=@{};Assert-StateReadGeneration @{pid=$pidA;started=$a} ([pscustomobject]@{ProcessId=$pidB;CreationDate=$b}) $proof
  if(!$proof.match -or $proof.requested.birth.utcTicks -cne $proof.observed.birth.utcTicks) {throw 'Exact generation match missing'}
  if(!$proof.requested.birth.type -or !$proof.observed.birth.rawSerialization) {throw 'Raw comparison evidence missing'}
  $script:passed++;return $proof
}
function Reject($pidA,$a,$pidB,$b) {
  $proof=@{};$rejected=$false
  try {Assert-StateReadGeneration @{pid=$pidA;started=$a} ([pscustomobject]@{ProcessId=$pidB;CreationDate=$b}) $proof} catch {$rejected=$true}
  if(!$rejected -or $proof.match -ne $false -or !$proof.requested.birth.type -or !$proof.observed.birth.type) {throw 'Invalid/different generation was not rejected with partial proof'}
  $script:passed++
}
$text='2026-11-03T06:52:01.4520910Z'
$instant=[DateTimeOffset]::Parse($text,[Globalization.CultureInfo]::InvariantCulture)
$decoded=ConvertFrom-Json -InputObject ('{"started":"'+$text+'"}')
$serializationProof=Match 42 $decoded.started 42 $instant
$null=Match 42 $text 42 $instant.UtcDateTime
$null=Match 42 '2026-11-03T08:52:01.4520910+02:00' 42 $instant
$null=Match 42 $instant 42 ($instant.UtcDateTime.ToLocalTime())
Reject 42 $text 43 $instant
Reject 42 '2026-11-03T08:52:01.4520910+01:00' 42 $instant
Reject 42 $text 42 ($instant.AddTicks(1))
Reject 42 '2026-11-03T06:52:01.4520911Z' 42 $instant
foreach($bad in @('2026-11-03T06:52:01','2026-11-03T06:52:01.45209101Z','not-a-date','2026-11-40T06:52:01Z',[DateTime]::SpecifyKind($instant.DateTime,[DateTimeKind]::Unspecified),@{},$true,123,$null)) {Reject 42 $bad 42 $instant}
foreach($badPid in @(0,-1,42.5,'42',$null)) {Reject $badPid $text 42 $instant}
$proof=@{};$rejected=$false
try {Assert-StateReadGeneration @{pid=42;started=$text} $null $proof} catch {$rejected=$true}
if(!$rejected -or $proof.observed.found -ne $false -or $proof.match -ne $false) {throw 'Missing process was not rejected'}
$passed++
@{passed=$passed;serializationProof=$serializationProof;localTimezone=[TimeZoneInfo]::Local.Id;aclOperations=$false;consumerProcessQueries=$false} | ConvertTo-Json -Depth 8 -Compress
