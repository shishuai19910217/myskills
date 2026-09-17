#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Skill 静态检查：frontmatter / 锚点完整性 / 术语冻结 / 结构完整。

.DESCRIPTION
  对给定 Skill 目录（含 SKILL.md）执行四类检查：
  1. frontmatter：name 与目录名一致；description 存在且含约定标记。
  2. 锚点完整性：正文（附录X）引用必须有对应章节；附录与资源型章节必须有正文入点。
  3. 术语冻结：禁词零命中；唯一性模式最多命中一次。
  4. 结构完整：必需章节（## 与 ###）齐全。

  规则来自 tools/lint-config.json；未配置的 Skill 只跑通用检查。
  退出码 0 = 全部通过，1 = 存在失败。

.EXAMPLE
  pwsh tools/lint-skill.ps1
  pwsh tools/lint-skill.ps1 -Path cognitive-prospecting
#>
[CmdletBinding()]
param(
  [string[]]$Path = @(),
  [string]$Config = (Join-Path $PSScriptRoot 'lint-config.json')
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$repoRoot = Split-Path -Parent $PSScriptRoot

if ($Path.Count -eq 0) {
  $Path = Get-ChildItem -LiteralPath $repoRoot -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') } |
    Select-Object -ExpandProperty FullName
}

$rules = @{}
if (Test-Path -LiteralPath $Config) {
  $json = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
  foreach ($prop in $json.PSObject.Properties) { $rules[$prop.Name] = $prop.Value }
}

function Get-LineNumber([string]$Text, [int]$Index) {
  if ($Index -lt 0) { return 0 }
  return ($Text.Substring(0, $Index) -split "`n").Count
}

function Get-AppendixToken([string]$Heading) {
  $m = [regex]::Match($Heading, '^附录([A-Za-z0-9]+)')
  if ($m.Success) { return "附录$($m.Groups[1].Value)" }
  return $null
}

function Get-ResourceToken([string]$Heading) {
  $Heading = $Heading -replace '^§[\d.]+\s*', ''
  if ($Heading -notmatch '工具箱|SSOT|资源池|模型池') { return $null }
  $m = [regex]::Match($Heading, '（([^）]+)）')
  if ($m.Success) {
    $inner = $m.Groups[1].Value
    if ($inner -match '^[A-Za-z0-9 _-]+$') { return $inner }
    return $Heading.Substring(0, $Heading.IndexOf('（'))
  }
  return $Heading
}

$checked = 0
$failed = @()

foreach ($item in $Path) {
  $skillDir = (Resolve-Path -LiteralPath $item).Path
  $skillFile = Join-Path $skillDir 'SKILL.md'
  $skillName = Split-Path $skillDir -Leaf
  $checked++
  $errors = [System.Collections.Generic.List[string]]::new()
  $rule = $rules[$skillName]

  if (-not (Test-Path -LiteralPath $skillFile)) {
    $errors.Add('缺少 SKILL.md')
  }
  else {
    $raw = Get-Content -LiteralPath $skillFile -Raw

    $fm = [regex]::Match($raw, '(?s)\A---\r?\n(.*?)\r?\n---')
    if (-not $fm.Success) {
      $errors.Add('frontmatter：缺失或格式错误（应以 --- 包裹）')
    }
    else {
      $head = $fm.Groups[1].Value
      $nameMatch = [regex]::Match($head, '(?m)^name:\s*(.+?)\s*$')
      if (-not $nameMatch.Success) {
        $errors.Add('frontmatter：缺少 name')
      }
      elseif ($nameMatch.Groups[1].Value -ne $skillName) {
        $errors.Add("frontmatter：name=$($nameMatch.Groups[1].Value) 与目录名 $skillName 不一致")
      }

      if (-not $rule -and $nameMatch.Success) { $rule = $rules[$nameMatch.Groups[1].Value] }

      $descIndex = $head.IndexOf('description:')
      if ($descIndex -lt 0) {
        $errors.Add('frontmatter：缺少 description')
      }
      else {
        $desc = $head.Substring($descIndex)
        if ($desc.Length -lt 60) {
          $errors.Add('frontmatter：description 过短（<60 字符）')
        }
        if ($rule -and $rule.descriptionMarkers) {
          foreach ($marker in $rule.descriptionMarkers) {
            if ($desc -notmatch [regex]::Escape($marker)) {
              $errors.Add("frontmatter：description 缺少约定标记「$marker」")
            }
          }
        }
      }
    }

    $headings = @([regex]::Matches($raw, '(?m)^#{2,3}\s+(.+?)\s*$') | ForEach-Object { $_.Groups[1].Value })
    $appendixHeadings = @{}
    foreach ($h in $headings) {
      $token = Get-AppendixToken $h
      if ($token) { $appendixHeadings[$token] = $h }
    }

    $refs = @([regex]::Matches($raw, '（附录([A-Za-z0-9]+)）') | ForEach-Object { "附录$($_.Groups[1].Value)" } | Sort-Object -Unique)
    foreach ($ref in $refs) {
      if (-not $appendixHeadings.ContainsKey($ref)) {
        $errors.Add("锚点：正文引用「$ref」但无对应章节")
      }
    }
    foreach ($token in $appendixHeadings.Keys) {
      $count = ([regex]::Matches($raw, [regex]::Escape($token))).Count
      if ($count -lt 2) {
        $errors.Add("锚点：章节「$token」未被正文引用")
      }
    }

    foreach ($h in $headings) {
      $token = Get-ResourceToken $h
      if (-not $token) { continue }
      if ($rule -and $rule.exemptResources -and ($rule.exemptResources -contains $token)) { continue }
      $count = ([regex]::Matches($raw, [regex]::Escape($token))).Count
      if ($count -lt 2) {
        $errors.Add("锚点：资源区「$token」缺正文入点")
      }
    }

    if ($rule -and $rule.forbiddenPatterns) {
      foreach ($pattern in $rule.forbiddenPatterns) {
        foreach ($m in [regex]::Matches($raw, $pattern)) {
          $line = Get-LineNumber $raw $m.Index
          $errors.Add("术语：命中禁词 /$pattern/（L$line）")
        }
      }
    }

    if ($rule -and $rule.uniquePatterns) {
      foreach ($pattern in $rule.uniquePatterns) {
        $count = ([regex]::Matches($raw, $pattern)).Count
        if ($count -gt 1) {
          $errors.Add("术语：/$pattern/ 应唯一，实际 $count 次")
        }
      }
    }

    if ($rule -and $rule.requiredHeadings) {
      foreach ($required in $rule.requiredHeadings) {
        $hit = $headings | Where-Object { $_ -like "*$required*" }
        if (-not $hit) {
          $errors.Add("结构：缺少章节「$required」")
        }
      }
    }
  }

  if ($errors.Count -eq 0) {
    Write-Host "PASS  $skillName" -ForegroundColor Green
  }
  else {
    Write-Host "FAIL  $skillName" -ForegroundColor Red
    foreach ($e in $errors) { Write-Host "      - $e" -ForegroundColor Yellow }
    $failed += $skillName
  }
}

Write-Host ""
Write-Host "checked: $checked skill(s), failed: $($failed.Count)"
if ($failed.Count -gt 0) { exit 1 }
exit 0
