param([Parameter(Mandatory)][string]$Source,[switch]$ForceLegacyConsole)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($ForceLegacyConsole) { [Console]::InputEncoding=[Text.Encoding]::GetEncoding(1252); [Console]::OutputEncoding=[Text.Encoding]::GetEncoding(1252) }
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$functions=@($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Read-InstallerProbeRequest','Get-InstallerProbeDirectory')},$true))
if ($functions.Count -ne 2) { throw 'Expected exact production transport/path functions' }
foreach ($function in $functions) { . ([ScriptBlock]::Create($function.Extent.Text)) }
# Execute only the production transport/path functions, never Windows identity, ACL or FileStream probes.
$context=@{transport=@{};directoryChecks=@();probes=@();stage='input';status='running';portableOnly=$true}
$exitCode=0
try {
    $request=Read-InstallerProbeRequest $context
    $context.stage='path-lookup'
    foreach ($directory in $request.directories) { $null=Get-InstallerProbeDirectory $directory $context }
    $context.status='paths-checked'
} catch { $context.status='failed'; $context.failure=@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message;id=$_.FullyQualifiedErrorId;category=[string]$_.CategoryInfo}; $exitCode=1 }
[Console]::Out.WriteLine(($context | ConvertTo-Json -Depth 8 -Compress))
exit $exitCode
