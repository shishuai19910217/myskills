#!/usr/bin/env pwsh
<#
.SYNOPSIS
  逐章摘要覆盖率机械校验（webnovel-outline-seed 的非模型兜底）。

.DESCRIPTION
  从大纲输出文本中提取所有"第X章"编号，校验：
  1. 编号从 1 开始连续递增，无缺号；
  2. 无重复编号；
  3. 若指定 -Expect N，校验最大章号 === N（三数对齐的机械部分）。

  退出码 0 = 通过；1 = 存在缺章/重章/章数不符。

.EXAMPLE
  pwsh tools/check-chapter-coverage.ps1 -File outline.md -Expect 100
  Get-Content outline.md -Raw | pwsh tools/check-chapter-coverage.ps1 -Expect 20
#>
[CmdletBinding()]
param(
  [string]$File,
  [int]$Expect = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($File) {
  if (-not (Test-Path -LiteralPath $File)) {
    Write-Host "ERROR  文件不存在: $File" -ForegroundColor Red
    exit 1
  }
  $text = Get-Content -LiteralPath $File -Raw
}
else {
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  $text = [Console]::In.ReadToEnd()
}

if ([string]::IsNullOrWhiteSpace($text)) {
  Write-Host "ERROR  输入为空" -ForegroundColor Red
  exit 1
}

# 提取"第X章"编号（仅阿拉伯数字；排除"第X-Y章"合并式写法中的区间，区间本身视为违规另行报告）
$numbers = [regex]::Matches($text, '第\s*(\d+)\s*章') | ForEach-Object { [int]$_.Groups[1].Value }

# 检测合并式摘要（"第1-10章""第1~10章"），这是被明令禁止的写法；
# 但"章数分配表"（第X幕 第X-Y章）是必填合法字段，所在行含"幕"或"分配"字样，予以豁免
$merged = @()
foreach ($line in ($text -split "`n")) {
  if ($line -match '幕|分配') { continue }
  foreach ($m in [regex]::Matches($line, '第\s*\d+\s*[-~—至]\s*\d+\s*章')) {
    $merged += $m.Value
  }
}

# 检测违禁偷懒字样
$lazy = [regex]::Matches($text, '后续同理|以此类推|下同|（略）|【略】') | ForEach-Object { $_.Value }

$errors = [System.Collections.Generic.List[string]]::new()

if ($numbers.Count -eq 0) {
  $errors.Add('未提取到任何"第X章"编号')
}
else {
  $max = ($numbers | Measure-Object -Maximum).Maximum
  $unique = @($numbers | Sort-Object -Unique)

  # 重号检查（卷/阶段组标题可能重复提及章号，只警告不判负——逐章摘要行才计重）
  $dupes = $numbers | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name }

  # 缺号检查：1..max 必须全覆盖
  $set = @{}
  foreach ($n in $unique) { $set[$n] = $true }
  $missing = @()
  for ($i = 1; $i -le $max; $i++) {
    if (-not $set.ContainsKey($i)) { $missing += $i }
  }
  if ($missing.Count -gt 0) {
    $errors.Add("缺章（共 $($missing.Count) 章）：第 $($missing -join '、') 章")
  }

  if ($Expect -gt 0 -and $max -ne $Expect) {
    $errors.Add("章数不符：最大章号 $max，期望 $Expect")
  }

  if ($dupes.Count -gt 0) {
    Write-Host "WARN   存在重复提及的章号（若为卷标题/分配表引用可忽略）：第 $($dupes -join '、') 章" -ForegroundColor Yellow
  }

  Write-Host ("INFO   提取到章号 {0} 个，唯一章号 {1} 个，范围 1..{2}" -f $numbers.Count, $unique.Count, $max)
}

foreach ($m in ($merged | Sort-Object -Unique)) {
  $errors.Add("命中合并式摘要写法：「$m」（禁止用区间代替逐章摘要；章数分配表除外，请人工确认该处是否为分配表）")
}
foreach ($l in ($lazy | Sort-Object -Unique)) {
  $errors.Add("命中违禁偷懒字样：「$l」")
}

if ($errors.Count -eq 0) {
  Write-Host "PASS   逐章覆盖率校验通过" -ForegroundColor Green
  exit 0
}
Write-Host "FAIL   逐章覆盖率校验未通过" -ForegroundColor Red
foreach ($e in $errors) { Write-Host "       - $e" -ForegroundColor Yellow }
exit 1
