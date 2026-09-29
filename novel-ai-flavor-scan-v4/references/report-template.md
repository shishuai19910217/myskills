# 报告模板与输出结构（novel-ai-flavor-scan-v4）

> **何时读本文件**：完成扫描、进入"输出报告"阶段时读取。扫描与分析阶段**不需要**本文件。
> 本文件是 SKILL.md §10 的完整展开；SKILL.md 中保留指向本文件的指针。

---

## 一、报告抬头（v4 新增，必填）

```markdown
**扫描类型**：[片段扫描 / 全文扫描]
**输入规模**：N 章 / N 段 / 约 N 字
**检测覆盖率**：M/18 维（置信度已按此下调）
**文本状态判定**：[模型直出 / 疑似人工润色→见 §12.1 退出]
```

---

## 二、Markdown 报告模板

```markdown
# AI 味扫描报告 v4

**总 AI 味指数**：78 / 100
**等级**：高
**置信度**：0.76（覆盖率 18/18）
**扫描类型**：全文扫描 ｜ **类型**：都市网文 ｜ **扫描字数**：12,340

## 元盘问日志
- 正奇：发现套词 43 处，情绪命名 12 处，冗余修饰句占比 17%（>15%，触发 R2 托底）
- 反奇：缺方言、缺脏话、缺身体不适
- 正偶：人物—情节—主题过度同构
- 反偶：缺闲笔、缺未解之谜、缺作者偏置
- 系统耦合：语言层+节奏层+生成层互相强化
- 苏格拉底诘问：排比多可能来自言情类型（对照 L1 已排除单独定性）
- 红队：全知解释可能来自传统章回体；L2 占位区间未实测、不作排除依据
- 整合修正：语言层 90→82（R1 封顶撤销：本维命中 2 观测点），置信度 0.76
- [v4] D17 索引：事实网络表 214 行，异常点 3 处（章3/章17 臂伤矛盾）
- [v4] D18 索引：专名表 87 行，异常点 2 处（"林晚"→"林婉"异写）

## 18 维评分表（五模块之一）
| 维度 | 分数 | 等级 | 状态 |
|---|---|---|---|
| 1 语言 | 82 | 高 | 已检测 |
| 2 节奏 | 72 | 高 | 已检测 |
| 3 叙事 | 75 | 高 | 已检测 |
| ...（D2–D16 略）... | | | |
| **17 跨章事实** | 70 | 高 | 已检测（全文） |
| **18 专名稳定** | 65 | 高 | 已检测（全文） |
> 片段扫描时，未检测维度移入下方"未检测维度表"。

## 未检测维度表 [v4]
| 维度 | 原因 |
|---|---|
| （片段扫描时列出，不计入总分） | |

## Top 10 高风险段落（五模块之二）
1. 第3章第2段：连续"仿佛、缓缓、微微"，情绪直接命名
2. 第17章第4段：[D17] 第3章已断左臂，本章左手完好，无提示
3. 第5章第7段：人物对话同质，无口癖、无权力差（机械 5 模式中命中 3 项）
...

## 修改建议（七切口）（五模块之三）
- 具体：把"城市很大"改为"三号线早高峰，保安用喇叭喊不要挤"
- 矛盾：让主角做一件不道德但合理的事
- 身体：加入疲劳、饥饿、疾病、性欲
- 社会：加入职业、金钱、官僚、劳动细节
- 风险：加入冒犯性观点，但不等于作者认同
- 留白：删掉结尾升华，保留未解之谜
- 偏置：加入作者执念、偏见、危险思想

## 红队备注（五模块之四）
- "排比多"可能来自言情类型套路（L1），不单独定罪
- "全知解释"可能来自传统章回体，需类型判断
- "无脏话"可能因出版审查，不直接等于 AI
- [v4] 第3章臂伤矛盾：先排除连载复述惯例（B009）后再定性
- [v4] L2 排比密度区间为占位值，未本地实测，未单独排除任何信号

## 检测清单（五模块之五 · 五模块全列，此处为压缩示意）
（五模块 = 总分等级置信度 + 18维表 + 高风险段落 + 七切口 + 红队备注，缺一即为输出不合规）
```

---

## 三、JSON 输出结构

```json
{
  "overall_ai_score": 78,
  "grade": "高",
  "confidence": 0.76,
  "coverage": "18/18",
  "scan_mode": "全文扫描",
  "text_state": "模型直出",
  "type": "都市网文",
  "word_count": 12340,
  "meta_interrogation": {
    "zheng_qi": {"signals": ["套词43处", "冗余修饰句17%"], "locations": []},
    "fan_qi": {"missing": ["方言", "脏话"], "type_exemption": []},
    "zheng_ou": {"structures": ["人物-情节-主题同构"], "coupling_score": 0.85},
    "fan_ou": {"missing": ["闲笔", "未解之谜"], "seven_cuts": []},
    "system_coupling": {"graph": [], "loops": [], "leverage": []},
    "socratic": {"boundaries": [], "exemptions": []},
    "red_team": {"attacks": [], "responses": [], "corrections": []},
    "integration": {"adjustments": [], "final_confidence": 0.76}
  },
  "dimensions": {
    "language": 82, "rhythm": 72, "narrative": 75, "voice": 82,
    "character": 70, "social_position": 88, "plot": 76, "scene": 85,
    "emotion": 78, "theme": 80, "world": 74, "author_bias": 86,
    "generation": 80, "reception": 85, "intertext_platform": 72,
    "embodiment_material": 88,
    "cross_chapter_consistency": 70,
    "proper_noun_stability": 65
  },
  "not_detected": [],
  "r1_flags": [{"dimension": "language", "type": "单线索封顶", "note": "已撤销：本维2观测点"}],
  "r2_anchors": [{"anchor": "冗余修饰句>15%", "value": "17%", "source": "B006", "effect": "托底41生效"}],
  "index_logs": {"fact_network_rows": 214, "fact_anomalies": 3, "noun_rows": 87, "noun_anomalies": 2},
  "high_risk_paragraphs": [
    {"chapter": 17, "paragraph": 4, "score": 88,
     "evidence": ["第3章：左臂受伤", "第17章：左手完好"],
     "dimension": "cross_chapter_consistency",
     "suggestion": "补恢复说明或修正其中一处"}
  ],
  "seven_cuts_suggestions": {"concrete": [], "contradiction": [], "body": [], "society": [], "risk": [], "blank": [], "bias": []},
  "red_team_notes": ["排比可能来自类型套路", "L2占位区间未实测不作排除"]
}
```
