param(
  [Parameter(Mandatory = $true)]
  [string]$AccountsAsset,

  [Parameter(Mandatory = $true)]
  [string]$AnchorSnippet,

  [string]$OutFile = "",
  [string]$AdminPath = "/admin/pioneer-credit/",
  [string]$ButtonText = "Pioneer Credit"
)

$ErrorActionPreference = "Stop"
$source = Resolve-Path -LiteralPath $AccountsAsset
if (-not $OutFile) {
  $OutFile = "$AccountsAsset.pioneer-credit"
}

$text = Get-Content -LiteralPath $source -Raw
$button = "e(`"a`",{href:`"$AdminPath`",target:`"_blank`",rel:`"noopener`",class:`"btn btn-secondary`",title:`"Pioneer Credit Guard`"},[E(ee,{name:`"creditCard`",size:`"md`",class:`"mr-1.5`"}),e(`"span`",null,`"$ButtonText`")])"

if ($text.Contains($button)) {
  Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8
  Write-Host "Already patched: $OutFile"
  exit 0
}

if (-not $text.Contains($AnchorSnippet)) {
  throw "Could not find AnchorSnippet in the account page asset. Pass a stable compiled anchor from your current sub admin build."
}

$patched = $text.Replace($AnchorSnippet, "$AnchorSnippet,$button")
Set-Content -LiteralPath $OutFile -Value $patched -Encoding UTF8
Write-Host "Patched asset written to $OutFile"
