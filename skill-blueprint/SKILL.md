---
name: skill-blueprint
description: >-
  新技能设计蓝图与 SKILL.md 骨架生成器。按「需要新建/升级某个现有技能」的需求，输出技能设计简报、目录结构、触发词规范与 lint 门禁建议，供技能撰写员直接写出可通过静态检查的 SKILL.md。触发词：设计一个新技能 / 新建 Agent Skill / 写 SKILL.md / 技能蓝图 / skill-blueprint。
---

# skill-blueprint — 新技能设计蓝图与 SKILL.md 骨架生成器

> 定位：在 `D:\owned\ai\myskills` 仓库里，把「新建/升级某个现有技能」的需求转化为可直接交付的设计简报与 SKILL.md 骨架；本技能只输出规范与骨架，不写领域业务正文，不执行安装。

## 一、形态与位置（M1）

- **形态**：纯 Agent Skill，无代码（如需脚本，放入 `scripts/` 并在正文引用）。
- **位置**：`D:\owned\ai\myskills\skill-blueprint\SKILL.md`。
- **动机**：仓库内 14 个真技能全部为领域能力，缺一条覆盖「技能自身生命周期管理」的标准化技能；新建技能每轮都要重新摸索规范，且易与已有技能触发词撞车（t2 已暴露 codebase-onboarding 硬碰撞、reading-health-check v1/v2 触发词重叠、novel-ai-flavor-scan v3/v4 路由歧义）。
- **模型**：不限模型（纯规范输出，不依赖特定模型能力）。

## 二、入口与触发词（M2）

**触发词**：
- 设计一个新技能 / 新建 Agent Skill / 升级某个现有技能
- 写 SKILL.md / 技能目录结构 / 技能设计简报
- 技能蓝图 / skill-blueprint / 新技能规范

**不适用 / 边界**：
- ✅ 做：产出技能设计简报、SKILL.md 骨架、目录结构清单、触发词/命名碰撞自查、lint 规则挂钩建议、行为验收案例模板。
- ❌ 不做：不直接安装技能（t7 librarian 负责）；不替代 `tools/lint-skill.ps1` 执行（t5 reviewer 负责）；不写领域业务正文（由后续技能撰写员完成）；不分析任意代码仓库（那是 codebase-onboarding 的职责）。

**与现有技能的区分**（落实 t2 治理精神，避免触发词碰撞）：

| 现有技能 | 职责 | 本技能不做 |
|---|---|---|
| model-selector | 推荐思维模型 | 不推荐模型，只输出技能设计蓝图 |
| round-table-skill | 边界不清晰问题的圆桌勘探 | 不做多席位盘问，只输出设计骨架 |
| correctness-enhanced-reply / verify-before-propose | 高可靠回复与红队自审 | 不做对抗式审查，只做设计规范输出 |
| 各网文技能 | AI味/选题/体检/质检 | 不碰网文内容 |
| codebase-onboarding | 代码库逆向与 onboarding 文档 | 不分析任意代码仓库，只规范技能目录 |

> 路由原则：用户若在「设计新技能」语境下同时提及上述技能的领域词，优先由对应领域技能处理；仅当用户明确要「新建/设计/升级某个 Agent Skill」时，才命中 skill-blueprint。

## 三、设计流程（阶段化）

### S0 需求确认

- Do：复述「新建/升级哪个技能」；确认目标用户、产出物、范围。
- Don't：未确认范围就写正文。

### S1 碰撞自查

- Do：核对名称、触发词与 `docs/skill-inventory.md` 清单及版本治理报告无硬碰撞；参考 t1 盘点与 t2 治理建议。
- Don't：使用与已有技能完全相同的 name 或完全重叠的触发词。

### S2 输出设计简报

- Do：产出目录结构、SKILL.md 骨架、lint 规则挂钩（附录A、附录B）。
- Don't：省略触发词碰撞自查直接进入正文撰写。

### S3 移交撰写

- Do：把简报与骨架交给技能撰写员写 SKILL.md；自跑 `pwsh tools/lint-skill.ps1 -Path <目录名>`。
- Don't：未跑 lint 就移交 t5 验收；交付前必须按（附录A）模板与（附录B）规则各自查一次。

## 四、SKILL.md 编写规范（M4）

- frontmatter：`name=<目录名>`；`description` ≥60 字符且显式包含触发条件。
- 正文中文模块化（M1/M2…）或阶段化（S0/S1…），关键判断用 Do/Don't 表。
- 锚点双向完整：正文 `（附录A）` 引用必须有对应章节；每个附录/资源区章节必须被正文引用（附录A）（附录B）。
- 资源型章节（含 工具箱 / SSOT / 资源池 / 模型池 且带 `（…）` 后缀）必须在正文中至少出现两次。

## 五、质量门禁与 lint（M5）

- 静态检查：`pwsh tools/lint-skill.ps1 -Path <目录名>`，退出码必须为 0。
- 检查项：frontmatter name 一致、description 长度、锚点完整、禁词零命中、唯一模式 ≤1 次、必需章节齐全。
- 失败不进入 t5；通过后移交行为验收（附录A）。

## 六、行为验收案例（M6）

- 触发词正例应命中本技能；反例不得误触到本技能。
- 案例文件：`cases/trigger-cases.yaml`（5 正例 + 5 反例，分别指向 model-selector、round-table-skill、体检器 v2、AI味扫描、codebase-onboarding）。
- 验收通过后，才进入 t6 修复回归复检。

## 七、安装与归档（M7）

- 安装：`pwsh tools/install-skill.ps1 -Path skill-blueprint`；用 `-List` 确认。
- 更新 docs 总览索引；退役/删除/`-Force`/`-Uninstall` 须先报用户确认。
- 归档：将 `SKILL.md`、`设计简报.md`、`scaffold/`、`cases/` 一并归入技能包（附录B）。

## 附录A：SKILL.md 骨架模板

把本章四反引号围栏内的完整骨架（含附录A/附录B/术语表章节）复制到新技能目录下的 `SKILL.md`，把尖括号占位替换为实际内容；复制后的文件必须自带 `## 附录A`/`## 附录B` 章标题，且正文中至少两次引用（附录A）（附录B），才能通过锚点双向检查。

````markdown
---
name: <目录名>
description: <技能定位与触发条件：做什么 + 触发词：…… + 不适用；实际正文必须 ≥60 字符，且显式包含触发条件>
---

# <技能中文名>（<目录名> 骨架）

> 复制本模板为新技能目录下的 SKILL.md，把尖括号占位替换为实际内容；
> frontmatter 的 name 必须与目录名严格一致，description 必须 ≥60 字符。

## 一、形态与位置
- **形态**：<纯 Skill / 含脚本>；**位置**：`D:\owned\ai\myskills\<目录名>\`。
- **动机**：<一句话>；**模型**：<不限模型 或 具体模型>。

## 二、入口与触发词
- **触发词**：<触发词 1> / <触发词 2> …
- **不适用 / 边界**：✅ 做：<范围>；❌ 不做：<排除项>。
- **与现有技能的区分**：<表格列出不做什么>。

## 三、设计流程（阶段化）
### S0 需求确认
- Do：…；Don't：…
### S1 碰撞自查
- Do：…；Don't：…

## 四、SKILL.md 编写规范
- frontmatter 要求；description ≥60 字符；锚点双向完整（附录A）（附录B）。

## 五、质量门禁与 lint
- `pwsh tools/lint-skill.ps1 -Path <目录名>` 退出码 0。

## 六、行为验收案例
- 正例命中、反例不误触；参考 cases/trigger-cases.yaml。

## 七、安装与归档
- `pwsh tools/install-skill.ps1 -Path <目录名>`；退役须先报用户确认。

## 附录A：<附录A章节标题>
<本模板本身即附录A 的实例；至少在正文引用（附录A）两次。>

## 附录B：<附录B章节标题>
```json
{ "<目录名>": { "descriptionMarkers": ["触发"], "requiredHeadings": [], "forbiddenPatterns": [], "uniquePatterns": [] } }
```
<至少在正文引用（附录B）两次。>

## 术语表
- **<术语>**：<定义>。
````

## 附录B：lint 规则挂钩示例

```json
{
  "skill-blueprint": {
    "descriptionMarkers": ["触发", "不适用"],
    "requiredHeadings": [],
    "forbiddenPatterns": [],
    "uniquePatterns": []
  }
}
```

与 `tools/lint-config.json` 格式一致；未配置的技能只跑通用检查（frontmatter name 一致、description ≥60、锚点双向、结构完整）。（附录B）

## 术语表

- **Agent Skill**：以 SKILL.md 为入口、可被 Agent 按触发词加载的可复用指令集。
- **SKILL.md**：技能目录下的顶层说明文件，含 frontmatter 元数据与正文规范。
- **frontmatter**：SKILL.md 顶部 `---` 包裹的元数据（name/description 等）。
- **lint 门禁**：`tools/lint-skill.ps1` 执行的静态质量检查，退出码 0 为通过。
- **行为验收**：用触发词正例/反例验证技能触发边界与流程可执行性。
- **碰撞自查**：在新建技能前，核对 name 与触发词是否与已有技能重叠（参考 t1 盘点、t2 治理报告）。