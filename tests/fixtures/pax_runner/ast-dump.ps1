# Reads PowerShell scripts with PowerShell's own parser, for test_pax_runner.py.
# Input: PAX_RUNNER_AST_INPUT, a JSON list of script paths.
# Output: PAX_RUNNER_AST_OUTPUT gets a JSON object keyed by path. Each entry holds the parse
# errors, the param block's text with its attributes, the parameters and their sets, and each
# function's body, string constants and hashtable keys.
$ErrorActionPreference = 'Stop'

function Get-NamedValue {
  param($Attribute, [string]$Name)
  foreach ($argument in $Attribute.NamedArguments) {
    if ($argument.ArgumentName -ne $Name) { continue }
    if ($argument.ExpressionOmitted) { return $true }
    return $argument.Argument.SafeGetValue()
  }
  return $null
}

function Get-ParameterReport {
  param($Parameter)
  $sets = [System.Collections.Generic.List[object]]::new()
  $validateSet = $null
  foreach ($attribute in $Parameter.Attributes) {
    if ($attribute -isnot [System.Management.Automation.Language.AttributeAst]) { continue }
    $typeName = $attribute.TypeName.FullName
    if ($typeName -in 'Parameter', 'ParameterAttribute') {
      $set = Get-NamedValue $attribute 'ParameterSetName'
      if (-not $set) { $set = '__AllParameterSets' }
      $sets.Add([ordered]@{ set = [string]$set; mandatory = [bool](Get-NamedValue $attribute 'Mandatory') })
    } elseif ($typeName -in 'ValidateSet', 'ValidateSetAttribute') {
      $validateSet = @($attribute.PositionalArguments | ForEach-Object { [string]$_.SafeGetValue() })
    }
  }
  return [ordered]@{
    name        = $Parameter.Name.VariablePath.UserPath
    type        = $Parameter.StaticType.Name
    switch      = ($Parameter.StaticType -eq [switch])
    sets        = $sets.ToArray()
    validateSet = $validateSet
  }
}

function Get-FunctionReport {
  param($Function)
  $isString = { $args[0] -is [System.Management.Automation.Language.StringConstantExpressionAst] }
  $isHashtable = { $args[0] -is [System.Management.Automation.Language.HashtableAst] }
  $keys = [System.Collections.Generic.List[string]]::new()
  foreach ($table in $Function.Body.FindAll($isHashtable, $true)) {
    foreach ($pair in $table.KeyValuePairs) {
      try { $keys.Add([string]$pair.Item1.SafeGetValue()) }
      catch { $keys.Add($pair.Item1.Extent.Text) }
    }
  }
  return [ordered]@{
    body          = $Function.Body.Extent.Text
    strings       = @($Function.Body.FindAll($isString, $true) | ForEach-Object { $_.Value })
    hashtableKeys = $keys.ToArray()
  }
}

$report = [ordered]@{}
foreach ($path in @($env:PAX_RUNNER_AST_INPUT | ConvertFrom-Json)) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  $entry = [ordered]@{
    errors     = @($errors | ForEach-Object { '{0}:{1} {2}' -f $_.Extent.StartLineNumber, $_.Extent.StartColumnNumber, $_.Message })
    paramBlock = $null
    params     = @()
    functions  = [ordered]@{}
  }
  $block = $ast.ParamBlock
  if ($block) {
    $start = $block.Extent.StartOffset
    foreach ($attribute in $block.Attributes) { $start = [math]::Min($start, $attribute.Extent.StartOffset) }
    $entry.paramBlock = $block.Extent.StartScriptPosition.GetFullScript().Substring($start, $block.Extent.EndOffset - $start)
    $entry.params = @(foreach ($parameter in $block.Parameters) { Get-ParameterReport $parameter })
  }
  $isFunction = { $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }
  foreach ($function in $ast.FindAll($isFunction, $true)) {
    $entry.functions[$function.Name] = Get-FunctionReport $function
  }
  $report[$path] = $entry
}
$json = ConvertTo-Json -InputObject $report -Depth 10
[System.IO.File]::WriteAllText($env:PAX_RUNNER_AST_OUTPUT, $json, [System.Text.UTF8Encoding]::new($false))
