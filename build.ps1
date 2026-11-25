# Builds dist\OdooHelper.html: one self-contained file (CSS and app JS inlined) to share with the team.
# Run from this folder:  powershell -ExecutionPolicy Bypass -File build.ps1
$root = $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
$html = [IO.File]::ReadAllText((Join-Path $root 'index.html'), $utf8)

$css = [IO.File]::ReadAllText((Join-Path $root 'css\app.css'), $utf8)
$html = $html.Replace('<link rel="stylesheet" href="css/app.css">', "<style>`n$css`n</style>")

foreach ($m in [regex]::Matches($html, '<script src="(js/[^"]+)"></script>')) {
  $js = [IO.File]::ReadAllText((Join-Path $root ($m.Groups[1].Value -replace '/', '\')), $utf8)
  if ($js -match '</script') { throw "$($m.Groups[1].Value) contains </script>" }
  $html = $html.Replace($m.Value, "<script>`n$js`n</script>")
}

New-Item -ItemType Directory -Force (Join-Path $root 'dist') | Out-Null
$out = Join-Path $root 'dist\OdooHelper.html'
[IO.File]::WriteAllText($out, $html, $utf8)
Write-Host "Built $out ($([math]::Round((Get-Item $out).Length / 1KB)) KB)"

# site\ = exactly the files the GitHub Pages website needs (upload the CONTENTS of this folder).
$site = Join-Path $root 'site'
if (Test-Path $site) { Remove-Item -Recurse -Force $site }
New-Item -ItemType Directory -Force (Join-Path $site 'css'), (Join-Path $site 'js') | Out-Null
Copy-Item (Join-Path $root 'index.html') $site
Copy-Item (Join-Path $root 'css\*.css') (Join-Path $site 'css')
Copy-Item (Join-Path $root 'js\*.js') (Join-Path $site 'js')
Write-Host "Prepared $site for GitHub Pages"
