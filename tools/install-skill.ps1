#!/usr/bin/env pwsh
<#
.SYNOPSIS
  把本仓库中的 Skill 安装到本机 Claude 的 skills 目录（默认全局 ~/.claude/skills）。

.DESCRIPTION
  安装方式：
    - 默认「软链接（SymbolicLink）」：源目录仍在本仓库，改仓库即时全局生效；
    - 创建链接失败（无权限 / 未开开发者模式）时自动回退 Junction；
    - -Copy 用复制安装（把 Skill 交付到不含本仓库的机器时用）。
  目标目录：
    - -Scope User（默认）：$env:USERPROFILE\.claude\skills —— 全局，所有项目可用；
    - -Scope Project    ：<仓库根>\.claude\skills —— 仅本仓库生效；
    - -Target 可显式指定安装目录，覆盖 -Scope。
  Skill 通过「目录下是否存在 SKILL.md」自动发现：round-table-agent、*-workspace、
  tools 这类非 Skill 目录自动跳过。
  前置校验：SKILL.md 存在；frontmatter name 与目录名一致（不一致只告警不阻断）。

.PARAMETER Path
  要安装的 Skill 目录名或绝对路径；省略 = 全部。

.PARAMETER Scope
  User（默认）或 Project。

.PARAMETER Target
  安装目录，显式指定时忽略 -Scope。

.PARAMETER Copy
  复制安装，不建链接。

.PARAMETER Force
  目标已存在且不是指向本仓库的链接时，先删除再安装（默认跳过并告警）。

.PARAMETER Uninstall
  反向操作：删除本仓库的安装项（只删链接/副本，不动仓库文件）。

.PARAMETER List
  只列状态，不做任何修改。

.EXAMPLE
  pwsh tools/install-skill.ps1 -List
  pwsh tools/install-skill.ps1 -Path webnovel-deai-lint
  pwsh tools/install-skill.ps1                      # 安装全部（全局软链接）
  pwsh tools/install-skill.ps1 -Scope Project       # 只装到本仓库 .claude/skills
  pwsh tools/install-skill.ps1 -Uninstall -Path prd-craft

.NOTES
  退出码：0 = 全部成功 / 无变化；1 = 存在失败项。
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string[]]$Path = @(),
  [ValidateSet('User', 'Project')][string]$Scope = 'User',
  [string]$Target,
  [switch]$Copy,
  [switch]$Force,
  [switch]$Uninstall,
  [switch]$List
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$repoRoot = Split-Path -Parent $PSScriptRoot
$script:Failed = 0

function Get-SkillNames {
  Get-ChildItem -LiteralPath $repoRoot -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') } |
    Select-Object -ExpandProperty Name | Sort-Object
}

function Resolve-SkillDir([string]$Name) {
  $inRepo = Join-Path $repoRoot $Name
  if (Test-Path -LiteralPath (Join-Path $inRepo 'SKILL.md')) { return $inRepo }
  if (Test-Path -LiteralPath (Join-Path $Name 'SKILL.md')) { return (Resolve-Path -LiteralPath $Name).Path }
  throw "找不到 Skill：$Name（目录内需有 SKILL.md）"
}

function Get-FrontmatterName([string]$SkillDir) {
  $head = Get-Content -LiteralPath (Join-Path $SkillDir 'SKILL.md') -TotalCount 10
  foreach ($line in $head) {
    if ($line -match '^name:\s*(.+?)\s*$') { return ($Matches[1] -replace '^["'']|["'']$', '') }
  }
  return $null
}

function Get-InstallDir {
  if ($Target) { return $Target }
  if ($Scope -eq 'Project') { return (Join-Path $repoRoot '.claude\skills') }
  return (Join-Path $env:USERPROFILE '.claude\skills')
}

function Get-ItemState([string]$LiteralPath) {
  if (-not (Test-Path -LiteralPath $LiteralPath)) { return [pscustomobject]@{ Exists = $false; IsLink = $false; Target = $null } }
  $item = Get-Item -LiteralPath $LiteralPath -Force
  $isLink = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  $linkTarget = $null
  if ($isLink -and $item.PSObject.Properties['Target'] -and $item.Target) { $linkTarget = @($item.Target)[0] }
  [pscustomobject]@{ Exists = $true; IsLink = $isLink; Target = $linkTarget }
}

function Test-SamePath([string]$A, [string]$B) {
  if (-not $A -or -not $B) { return $false }
  $na = [System.IO.Path]::GetFullPath($A).TrimEnd('\')
  $nb = [System.IO.Path]::GetFullPath($B).TrimEnd('\')
  return $na -eq $nb
}

function Remove-InstallEntry([string]$LiteralPath) {
  $state = Get-ItemState $LiteralPath
  if (-not $state.Exists) { return }
  if ($state.IsLink) {
    # 目录符号链接/Junction 必须只删链接本身：Remove-Item -Recurse 可能误删源目录内容
    [System.IO.Directory]::Delete($LiteralPath, $false)
  }
  else {
    Remove-Item -LiteralPath $LiteralPath -Recurse -Force
  }
}


function New-SkillEntry([string]$SrcDir, [string]$DestPath) {
  if ($Copy) {
    New-Item -ItemType Directory -Path $DestPath -Force | Out-Null
    Copy-Item -Path (Join-Path $SrcDir '*') -Destination $DestPath -Recurse -Force
    return 'Copy'
  }
  try {
    New-Item -ItemType SymbolicLink -Path $DestPath -Target $SrcDir -ErrorAction Stop | Out-Null
    return 'SymbolicLink'
  }
  catch {
    Write-Warning "符号链接失败（$($_.Exception.Message.Trim())），回退 Junction：$DestPath"
    New-Item -ItemType Junction -Path $DestPath -Target $SrcDir -ErrorAction Stop | Out-Null
    return 'Junction'
  }
}

function Test-SameCopy([string]$SrcDir, [string]$DestDir) {
  $destSkill = Join-Path $DestDir 'SKILL.md'
  if (-not (Test-Path -LiteralPath $destSkill)) { return $false }
  $srcSkill = Join-Path $SrcDir 'SKILL.md'
  if ((Get-Item -LiteralPath $destSkill).Length -ne (Get-Item -LiteralPath $srcSkill).Length) { return $false }
  return (Get-FileHash -LiteralPath $destSkill).Hash -eq (Get-FileHash -LiteralPath $srcSkill).Hash
}

function Get-StatusText([string]$Name, [string]$SrcDir, [string]$InstallDir) {
  $dest = Join-Path $InstallDir $Name
  $state = Get-ItemState $dest
  if (-not $state.Exists) { return '未安装' }
  if ($state.IsLink -and (Test-SamePath $state.Target $SrcDir)) { return '已安装（链接 → 本仓库）' }
  if ($state.IsLink) { return "已占用（链接 → $($state.Target)）" }
  if (Test-SameCopy $SrcDir $dest) { return '已安装（副本，内容一致）' }
  if (Test-Path -LiteralPath (Join-Path $dest 'SKILL.md')) { return '已占用（副本，内容不同）' }
  return '已占用（非 Skill 目录）'
}

# ---- 解析待处理 Skill ----
$names = if ($Path.Count -gt 0) { @($Path | ForEach-Object { Split-Path -Leaf (Resolve-SkillDir $_) }) } else { @(Get-SkillNames) }
$installDir = Get-InstallDir

if (-not (Test-Path -LiteralPath $installDir)) {
  if ($List) { Write-Host "安装目录不存在：$installDir" }
  else { New-Item -ItemType Directory -Path $installDir -Force | Out-Null }
}

if ($List) {
  Write-Host "安装目录：$installDir`n"
  foreach ($name in $names) {
    $src = Resolve-SkillDir $name
    Write-Host ("  {0,-32} {1}" -f $name, (Get-StatusText $name $src $installDir))
  }
  exit 0
}

# ---- 安装 / 卸载 ----
foreach ($name in $names) {
  $src = Resolve-SkillDir $name
  $dest = Join-Path $installDir $name
  $fmName = Get-FrontmatterName $src
  if ($fmName -and $fmName -ne $name) {
    Write-Warning "frontmatter name（$fmName）与目录名（$name）不一致；Claude 以目录名注册，建议对齐。"
  }

  $state = Get-ItemState $dest
  $sameLink = $state.Exists -and $state.IsLink -and (Test-SamePath $state.Target $src)

  if ($Uninstall) {
    if (-not $state.Exists) { Write-Host "跳过（未安装）：$name"; continue }
    if ($state.IsLink -and -not $sameLink) {
      Write-Host "跳过（指向别处，不动）：$name → $($state.Target)"
      continue
    }
    if ($PSCmdlet.ShouldProcess($dest, '卸载')) {
      Remove-InstallEntry $dest
      Write-Host "已卸载：$name"
    }
    continue
  }

  if ($sameLink) { Write-Host "已安装，跳过：$name"; continue }

  if ($state.Exists -and -not $state.IsLink -and (Test-SameCopy $src $dest)) {
    Write-Host "已安装（副本，内容一致），跳过：$name"; continue
  }

  if ($state.Exists) {
    if (-not $Force) {
      Write-Host "跳过（目标已存在，加 -Force 覆盖）：$name → $dest"
      continue
    }
    if (-not $PSCmdlet.ShouldProcess($dest, '删除后重新安装')) { continue }
    Remove-InstallEntry $dest
  }

  if (-not $PSCmdlet.ShouldProcess($dest, "安装 $name")) { continue }
  try {
    $how = New-SkillEntry -SrcDir $src -DestPath $dest
    Write-Host "已安装（$how）：$name → $dest"
  }
  catch {
    Write-Host "安装失败：$name —— $($_.Exception.Message.Trim())"
    $script:Failed++
  }
}

exit ([int]($script:Failed -gt 0))

