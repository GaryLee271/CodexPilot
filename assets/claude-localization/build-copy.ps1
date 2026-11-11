param()
$ErrorActionPreference = 'Stop'

$sourceExe = [IO.Path]::GetFullPath($env:CODEX_PLUS_CLAUDE_SOURCE)
$copyExe = [IO.Path]::GetFullPath($env:CODEX_PLUS_CLAUDE_COPY)
$sourceRoot = Split-Path $sourceExe -Parent
$copyRoot = Split-Path $copyExe -Parent
$here = Split-Path $MyInvocation.MyCommand.Path -Parent
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)

function Get-Sha256Hex([string]$path) {
  $stream = $null
  $sha = $null
  try {
    $stream = [IO.File]::OpenRead($path)
    $sha = [Security.Cryptography.SHA256]::Create()
    return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
  } catch {
    throw ('副本校验失败：' + $_.Exception.Message)
  } finally {
    if ($stream) { $stream.Dispose() }
    if ($sha) { $sha.Dispose() }
  }
}

function Find-Ion([string]$root) {
  # 新版程序优先引用归档；保留旧版的散装目录支持。
  foreach ($candidate in @((Join-Path $root 'resources\ion-dist.asar'), (Join-Path $root 'ion-dist.asar'))) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  foreach ($candidate in @((Join-Path $root 'resources\ion-dist'), (Join-Path $root 'ion-dist'))) {
    if (Test-Path -LiteralPath (Join-Path $candidate 'index.html') -PathType Leaf) { return $candidate }
  }
  throw '找不到 Claude 本地界面 ion-dist 或 ion-dist.asar'
}

# Electron fuse 由 Codex Pilot 在复制完成后改写并复核。归档版只在副本里额外关闭
# EmbeddedAsarIntegrityValidation，不改 PE 内嵌 hash；官方安装目录始终只读不改。

function Set-CatalogMeta([string]$html, [string[]]$languages) {
  $catalogs = ($languages | Sort-Object -Unique | ForEach-Object { "${_}:1.1.1" }) -join ','
  $meta = "<meta name=`"i18n-catalogs`" data-i18n-catalogs=`"$catalogs`">"
  if ($html -match '<meta\b[^>]*name=["'']i18n-catalogs["''][^>]*>') {
    return [regex]::Replace($html, '<meta\b[^>]*name=["'']i18n-catalogs["''][^>]*>', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $meta })
  }
  if ($html.Contains('</head>')) { return $html.Replace('</head>', "$meta</head>") }
  throw '本地界面的 HTML 格式已变化'
}

function Get-AsarEntries($node, [string]$prefix, $entries) {
  foreach ($property in $node.files.PSObject.Properties) {
    $name = $prefix + $property.Name
    $meta = $property.Value
    if ($null -ne $meta.files) { Get-AsarEntries $meta ($name + '/') $entries }
    else {
      $entries.Add([pscustomobject]@{ Path = $name; Meta = $meta; OriginalOffset = $meta.offset; OriginalSize = $meta.size; Data = $null })
    }
  }
}

function Read-Asar([string]$path) {
  $stream = [IO.File]::OpenRead($path)
  try {
    $reader = New-Object IO.BinaryReader($stream)
    if ($reader.ReadUInt32() -ne 4) { throw 'ASAR 头格式已变化' }
    $headerSize = $reader.ReadUInt32()
    $payloadSize = $reader.ReadUInt32()
    $jsonSize = $reader.ReadUInt32()
    if ($headerSize -lt 8 -or $payloadSize -ne $headerSize - 4 -or $jsonSize -gt $payloadSize - 4 -or (8L + $headerSize) -gt $stream.Length) { throw 'ASAR 头长度无效' }
    $json = $reader.ReadBytes([int]$jsonSize)
    if ($json.Length -ne $jsonSize) { throw 'ASAR 头已截断' }
    $header = $utf8.GetString($json) | ConvertFrom-Json
    if ($null -eq $header.files) { throw 'ASAR 文件表缺失' }
    $entries = New-Object 'System.Collections.Generic.List[object]'
    Get-AsarEntries $header '' $entries
    return [pscustomobject]@{ Path = $path; Header = $header; Start = 8L + $headerSize; Entries = $entries }
  } finally { $stream.Dispose() }
}

function Get-AsarData($archive, $entry) {
  if ($null -ne $entry.Data) { return ,$entry.Data }
  if ($entry.Meta.unpacked -or $null -ne $entry.Meta.link -or $null -eq $entry.OriginalOffset) { throw ('界面资源不是归档内普通文件：' + $entry.Path) }
  $offset = [long]$entry.OriginalOffset
  $size = [long]$entry.OriginalSize
  $stream = [IO.File]::OpenRead($archive.Path)
  try {
    if ($offset -lt 0 -or $size -lt 0 -or $size -gt [int]::MaxValue -or ($archive.Start + $offset + $size) -gt $stream.Length) { throw 'ASAR 条目范围无效' }
    $null = $stream.Seek($archive.Start + $offset, [IO.SeekOrigin]::Begin)
    $reader = New-Object IO.BinaryReader($stream)
    $data = $reader.ReadBytes([int]$size)
    if ($data.Length -ne $size) { throw 'ASAR 条目已截断' }
    return ,$data
  } finally { $stream.Dispose() }
}

function Set-AsarData($entry, [byte[]]$data) {
  if ($entry.Meta.unpacked -or $null -ne $entry.Meta.link) { throw ('不能改写非归档内普通文件：' + $entry.Path) }
  $blockSize = 4194304
  if ($null -ne $entry.Meta.integrity.blockSize) { $blockSize = [int]$entry.Meta.integrity.blockSize }
  if ($blockSize -le 0) { throw 'ASAR 完整性分块大小无效' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = [BitConverter]::ToString($sha.ComputeHash($data)).Replace('-', '').ToLowerInvariant()
    $blocks = New-Object 'System.Collections.Generic.List[string]'
    for ($offset = 0; $offset -lt $data.Length; $offset += $blockSize) {
      $length = [Math]::Min($blockSize, $data.Length - $offset)
      $blocks.Add([BitConverter]::ToString($sha.ComputeHash($data, $offset, $length)).Replace('-', '').ToLowerInvariant())
    }
    $integrity = [pscustomobject]@{ algorithm = 'SHA256'; hash = $hash; blockSize = $blockSize; blocks = @($blocks.ToArray()) }
    $entry.Meta | Add-Member -NotePropertyName integrity -NotePropertyValue $integrity -Force
    $entry.Meta | Add-Member -NotePropertyName size -NotePropertyValue $data.Length -Force
    $entry.Data = $data
  } finally { $sha.Dispose() }
}

function Add-AsarCatalog($archive, [string]$relative) {
  $path = 'i18n/' + $relative
  $entry = $archive.Entries | Where-Object { $_.Path -ceq $path } | Select-Object -First 1
  if ($null -eq $entry) {
    $node = $archive.Header
    $parts = $path.Split('/')
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
      $property = $node.files.PSObject.Properties[$parts[$i]]
      if ($null -eq $property) {
        $child = [pscustomobject]@{ files = [pscustomobject]@{} }
        $node.files | Add-Member -NotePropertyName $parts[$i] -NotePropertyValue $child
        $node = $child
      } else {
        $node = $property.Value
        if ($null -eq $node.files) { throw 'ASAR 词表路径与文件冲突' }
      }
    }
    $meta = [pscustomobject]@{ size = 0; offset = '0' }
    $node.files | Add-Member -NotePropertyName $parts[-1] -NotePropertyValue $meta
    $entry = [pscustomobject]@{ Path = $path; Meta = $meta; OriginalOffset = $null; OriginalSize = 0; Data = $null }
    $archive.Entries.Add($entry)
  }
  Set-AsarData $entry ([IO.File]::ReadAllBytes((Join-Path $here ('catalogs/' + $relative))))
}

function Write-Asar($archive) {
  $offset = 0L
  foreach ($entry in $archive.Entries) {
    if ($entry.Meta.unpacked -or $null -ne $entry.Meta.link) { continue }
    $entry.Meta | Add-Member -NotePropertyName offset -NotePropertyValue $offset.ToString([Globalization.CultureInfo]::InvariantCulture) -Force
    $offset += [long]$entry.Meta.size
  }
  $json = $utf8.GetBytes(($archive.Header | ConvertTo-Json -Depth 100 -Compress))
  $padding = (4 - ($json.Length % 4)) % 4
  $payloadSize = 4 + $json.Length + $padding
  # 同目录暂存，完整写入后原子替换副本归档；中途失败仍保留原副本归档。
  $temporary = $archive.Path + '.codex-' + [Guid]::NewGuid().ToString('N')
  $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try {
    $writer = New-Object IO.BinaryWriter($stream)
    $writer.Write([uint32]4)
    $writer.Write([uint32]($payloadSize + 4))
    $writer.Write([uint32]$payloadSize)
    $writer.Write([uint32]$json.Length)
    $writer.Write($json)
    if ($padding) { $writer.Write((New-Object byte[] $padding)) }
    foreach ($entry in $archive.Entries) {
      if ($entry.Meta.unpacked -or $null -ne $entry.Meta.link) { continue }
      $writer.Write([byte[]](Get-AsarData $archive $entry))
    }
    $writer.Flush()
    $stream.Flush($true)
  } finally { $stream.Dispose() }
  [IO.File]::Replace($temporary, $archive.Path, $null)
}

function Copy-AsarCatalogs([string]$ion) {
  $archive = Read-Asar $ion
  foreach ($relative in @('zh-Hans.json', 'dynamic/zh-Hans.json', 'zh-Hans.overrides.json')) { Add-AsarCatalog $archive $relative }
  $old = '["en-US","de-DE","fr-FR","ko-KR","ja-JP","es-419","es-ES","it-IT","hi-IN","pt-BR","id-ID"]'
  $new = $old.Substring(0, $old.Length - 1) + ',"zh-Hans"]'
  $languageMatches = 0
  foreach ($entry in $archive.Entries) {
    if ($entry.Path -cnotmatch '^assets/.*\.js$') { continue }
    $text = $utf8.GetString((Get-AsarData $archive $entry))
    if ($text.Contains($old)) { Set-AsarData $entry ($utf8.GetBytes($text.Replace($old, $new))); $languageMatches++ }
    elseif ($text.Contains($new)) { $languageMatches++ }
  }
  if ($languageMatches -eq 0) { throw '本地界面的语言协商格式已变化' }
  $index = $archive.Entries | Where-Object { $_.Path -ceq 'index.html' } | Select-Object -First 1
  if ($null -eq $index) { throw '归档缺少 index.html' }
  $languages = @($archive.Entries | ForEach-Object { if ($_.Path -cmatch '^i18n/([^/.]+)\.json$') { $Matches[1] } })
  $html = Set-CatalogMeta ($utf8.GetString((Get-AsarData $archive $index))) $languages
  Set-AsarData $index ($utf8.GetBytes($html))
  Write-Asar $archive
}

function Copy-Catalogs([string]$ion) {
  if (Test-Path -LiteralPath $ion -PathType Leaf) { Copy-AsarCatalogs $ion; return }
  foreach ($relative in @('zh-Hans.json', 'dynamic\zh-Hans.json', 'zh-Hans.overrides.json')) {
    $source = Join-Path $here (Join-Path 'catalogs' $relative)
    $target = Join-Path $ion (Join-Path 'i18n' $relative)
    New-Item -ItemType Directory -Force (Split-Path $target -Parent) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
  }
  $old = '["en-US","de-DE","fr-FR","ko-KR","ja-JP","es-419","es-ES","it-IT","hi-IN","pt-BR","id-ID"]'
  $new = $old.Substring(0, $old.Length - 1) + ',"zh-Hans"]'
  $languageMatches = 0
  Get-ChildItem -LiteralPath (Join-Path $ion 'assets') -Filter '*.js' -Recurse -File | ForEach-Object {
    $text = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
    if ($text.Contains($old)) { Set-Content -LiteralPath $_.FullName -Value $text.Replace($old, $new) -Encoding UTF8; $languageMatches++ }
    elseif ($text.Contains($new)) { $languageMatches++ }
  }
  if ($languageMatches -eq 0) { throw '本地界面的语言协商格式已变化' }
  $index = Join-Path $ion 'index.html'
  $html = Get-Content -LiteralPath $index -Raw -Encoding UTF8
  $languages = @(Get-ChildItem -LiteralPath (Join-Path $ion 'i18n') -Filter '*.json' -File | ForEach-Object { $_.BaseName } | Where-Object { $_ -notmatch '\.' })
  Set-Content -LiteralPath $index -Value (Set-CatalogMeta $html $languages) -Encoding UTF8
}

function Test-AsarIntegrity($entry, [byte[]]$data) {
  $integrity = $entry.Meta.integrity
  if ($integrity.algorithm -cne 'SHA256' -or [long]$entry.Meta.size -ne $data.Length) { throw ('归档条目完整性格式无效：' + $entry.Path) }
  $blockSize = [int]$integrity.blockSize
  if ($blockSize -le 0) { throw 'ASAR 完整性分块大小无效' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = [BitConverter]::ToString($sha.ComputeHash($data)).Replace('-', '').ToLowerInvariant()
    if ($hash -cne $integrity.hash) { throw ('归档条目完整性校验失败：' + $entry.Path) }
    $blocks = @($integrity.blocks)
    $blockIndex = 0
    for ($offset = 0; $offset -lt $data.Length; $offset += $blockSize) {
      $length = [Math]::Min($blockSize, $data.Length - $offset)
      $hash = [BitConverter]::ToString($sha.ComputeHash($data, $offset, $length)).Replace('-', '').ToLowerInvariant()
      if ($blockIndex -ge $blocks.Count -or $hash -cne $blocks[$blockIndex]) { throw ('归档条目分块校验失败：' + $entry.Path) }
      $blockIndex++
    }
    if ($blockIndex -ne $blocks.Count) { throw ('归档条目分块数量无效：' + $entry.Path) }
  } finally { $sha.Dispose() }
}

function Test-IonCatalogs([string]$ion) {
  if (Test-Path -LiteralPath $ion -PathType Leaf) {
    $archive = Read-Asar $ion
    foreach ($relative in @('i18n/zh-Hans.json', 'i18n/dynamic/zh-Hans.json', 'i18n/zh-Hans.overrides.json', 'index.html')) {
      $entry = $archive.Entries | Where-Object { $_.Path -ceq $relative } | Select-Object -First 1
      if ($null -eq $entry) { throw ('归档缺少中文词表或首页：' + $relative) }
      $data = Get-AsarData $archive $entry
      Test-AsarIntegrity $entry $data
      $text = $utf8.GetString($data)
      if ($relative -ceq 'index.html') {
        if ($text -notmatch '<meta\b[^>]*name=["'']i18n-catalogs["''][^>]*data-i18n-catalogs=["''][^"'']*\bzh-Hans:') { throw '本地界面未注册中文词表' }
      } else { $null = $text | ConvertFrom-Json }
    }
    return
  }
  foreach ($relative in @('i18n\zh-Hans.json', 'i18n\dynamic\zh-Hans.json', 'i18n\zh-Hans.overrides.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ion $relative) -PathType Leaf)) { throw '中文词表缺失' }
  }
  if (-not (Get-Content -LiteralPath (Join-Path $ion 'index.html') -Raw -Encoding UTF8).Contains('zh-Hans:')) { throw '本地界面未注册中文词表' }
}

if (-not (Test-Path -LiteralPath $sourceExe)) { throw "找不到 Claude：$sourceExe" }
if ($args -contains '--check') {
  if (-not (Test-Path -LiteralPath $copyExe)) { throw 'Windows Claude 副本不存在' }
  $sourceAsar = Join-Path $sourceRoot 'resources\app.asar'; $copyAsar = Join-Path $copyRoot 'resources\app.asar'
  if ((Get-Sha256Hex $sourceAsar) -ne (Get-Sha256Hex $copyAsar)) { throw 'app.asar 已被改动' }
  Test-IonCatalogs (Find-Ion $copyRoot)
  Write-Output 'Windows Claude 副本、中文词表与 app.asar 一致性检查通过'; exit 0
}

if (Test-Path -LiteralPath $copyRoot) { throw '构建目标必须是新的暂存目录' }
New-Item -ItemType Directory -Force (Split-Path $copyRoot -Parent) | Out-Null
$null = & robocopy.exe $sourceRoot $copyRoot /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -gt 7) {
  $hint = $(if ($sourceRoot -match '\\WindowsApps\\') { '；商店版（MSIX）Claude 位于受保护的 WindowsApps 目录，请用安装 Claude 的同一账户运行 Codex Pilot，不要以管理员或其他用户身份运行' } else { '' })
  throw "复制 Windows Claude 副本失败（robocopy 退出码：$LASTEXITCODE），可能没有读取 $sourceRoot 的权限或磁盘空间不足$hint"
}
$ion = Find-Ion $copyRoot
Copy-Catalogs $ion
Test-IonCatalogs $ion
Write-Output 'Windows Claude 副本已创建，官方 app.asar 未修改'
