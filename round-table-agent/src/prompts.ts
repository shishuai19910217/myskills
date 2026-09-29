// 提示词（对应 DESIGN.md §7.2）
import type { BoundaryItem, BoundaryType, GoalType, SeatConfig } from "./types.js";

/** 始终使用简体中文的硬约束（英文专有名词除外） */
const LANGUAGE_RULE = "始终使用简体中文作答（英文专有名词、引用原文除外），禁止整句使用英文。";

export const GOAL_LABEL: Record<GoalType, string> = {
  enumerate: "枚举完整清单（列出全部方面/维度）",
  judge: "判断某事是否成立/可行",
  design: "设计一个可执行方案",
  diagnose: "诊断问题成因",
  other: "其他类型目标",
};

export const COORDINATOR_SYSTEM = `你是"多模型圆桌会议"的统筹者。议题通常是用户对陌生领域提出的、边界不清晰的问题。
你的职责：
1. 复述议题、识别产出目标、圈定勘探范围；
2. 按勘探维度【目标→约束→反例→前提→盲区】逐席盘问，向指定席位提出精准、开放、不预设答案的问题；
3. 对边界池中有冲突/重叠的条目裁决（保留 / 合并 / 否决），给出被否理由；
4. 判定勘探是否收敛；
5. 基于清单生成最终解决方案。
原则：你只负责勘探与收敛，不代替其他席位回答；盘问问题不得暗示答案。
${LANGUAGE_RULE}`;

export function coordinatorSystemPrompt(): string {
  return COORDINATOR_SYSTEM;
}

// ============ R0 开题 ============

export function coordinatorOpeningUser(params: { question: string }): string {
  return `用户输入如下（可能是文本/附件/链接内容）：
-----
${params.question}
-----
请：
1) 用一句话复述议题（用户真正想问什么）；
2) 识别用户的实际产出目标（如"列出完整维度/方面清单""判断某事是否可行""设计一个方案""诊断问题"）——这是本次会议的验收标准，务必贴近用户原话的意图；
3) 判断目标类型 goalType：enumerate（枚举清单）/ judge（判断）/ design（方案）/ diagnose（诊断）/ other；
4) 圈定勘探范围（明确"什么是本题边界""什么超出范围"）。
输出严格 JSON（不要 Markdown 代码块）：
{"topic":"一句话议题","objective":"产出目标","goalType":"enumerate|judge|design|diagnose|other","scope":"勘探范围"}`;
}

// ============ R1 盘问 ============

export function coordinatorQuestionUser(params: {
  round: number;
  seatName: string;
  seatRole: string;
  seatType: BoundaryType;
  topic: string;
  scope: string;
  goalType: GoalType;
  pool: string;
  coordHistory: string[];
}): string {
  return `议题：${params.topic}
产出目标类型：${GOAL_LABEL[params.goalType]}
勘探范围：${params.scope}
当前边界池：
${params.pool}

当前第 ${params.round} 轮。请向「${params.seatName}」（角色：${params.seatRole}，勘探维度：${params.seatType}）提出 1 个精准的盘问问题，
帮助它挖出尚未覆盖的「${params.seatType}」类边界。
要求：
- 问题具体、指向可枚举的方面；开放、不暗示答案；
- 明确指向边界池中尚未出现的新角度，不要重复已覆盖维度；
- 问题本身包含足够语境，不要使用"请从你的职责出发"这类空泛措辞；
- 问题正文不超过 80 个汉字，直接提问，禁止复述边界池内容或铺垫"当前已涵盖……"。
只输出严格 JSON：{"question":"问题正文"}`;
}

// ============ 席位作答 ============

const CONFIDENCE_ANCHOR = `confidence 按客观锚点取值，不要默认报高：
- high：描述具体，能直接举例或在真实文本/事实中验证；
- medium：方向明确，但需要进一步举证或边界尚模糊；
- low：推测性、尚不确定。`;

const TYPE_HINT: Record<BoundaryType, string> = {
  目标: "产出应是：一个具体的、可操作的方面/维度（如'对话千人一面'、'动作描写模板化'）。",
  约束: "产出应是：一条具体的限制/禁区/前提条件（如'不能破坏角色口癖'、'避免高频词互替'）。",
  反例: "产出应是：一个会击穿已有维度的具体反例场景（如'某人类作家也这么写'）。",
  前提: "产出应是：一个隐含的、未被明说的前提（如'默认 AI 生成必然缺个体指纹'）。",
  盲区: "产出应是：一个所有人都还没提到的具体方面或维度。",
};

/**
 * 枚举类题目的角色适配：所有席位最终都服务于"方面清单"，
 * 约束/反例/前提类产出必须显式写回它所限定的那个方面，而不是只给禁令或例子。
 */
const ENUMERATE_HINT: Partial<Record<BoundaryType, string>> = {
  目标: "本题要枚举方面清单：直接产出一个候选方面（该问题在对象上的具体表现维度）。",
  约束: "本题要枚举方面清单：产出一条以方面为主体的判据边界，说明该方面在什么条件下成立/不成立（形如'X 仅在……条件下才算'），不要只给禁令。",
  反例: "本题要枚举方面清单：先用半句话给出反例，再明确写出它所排除或修正的那个方面（形如'因此 X 不能单独作为判据'），方面必须出现在描述里。",
  前提: "本题要枚举方面清单：写出该隐含假设所指向的、可被观察的具体方面（形如'默认 X 总是……'），不要停留在纯抽象假设。",
};

export function seatSystemPrompt(seat: SeatConfig, goalType: GoalType = "other"): string {
  const enumerateRule = goalType === "enumerate" ? ENUMERATE_HINT[seat.type] : undefined;
  return `你是圆桌会议中的「${seat.name}」，负责勘探「${seat.type}」类边界。
规则：
- 每轮只输出 1 条当前最值得补充的「${seat.type}」边界；确实没有新内容时输出 {"description":""}；
- 不得重复已有边界；
- ${enumerateRule ?? TYPE_HINT[seat.type]}
- 只产边界条目，不给出最终方案；描述要具体、可验证，不要抽象定义或空泛哲学；
- 描述正文内如需引用词语，只能使用中文引号「」或“”，严禁使用 ASCII 双引号（"），也不要换行；
- ${CONFIDENCE_ANCHOR}
- ${LANGUAGE_RULE}
- 思考与分析只在内部完成、不要写入回复；最终回复中只包含一个 JSON 对象，不要 Markdown 代码块、不要 Description: 这类标注、不要任何前后缀解释文字：
  {"description":"一句话边界描述","confidence":"high|medium|low"}
confidence 只能取 high / medium / low 三个英文值之一。`;
}

// ============ R3 收敛判定 ============

export function coordinatorConvergeUser(params: {
  rounds: number;
  newPerRound: number[];
  pool: string;
}): string {
  return `当前边界池：
${params.pool}
历轮新增数：${params.newPerRound.map((n, i) => `第${i + 1}轮+${n}`).join("，")}

请判断：勘探是否已经收敛（即继续盘问几乎不会再有新边界）？
${LANGUAGE_RULE}
先输出 JSON：{"converged":true|false,"reason":"一句话"}，随后另起一行给出结论：收敛 或 继续。`;
}

// ============ R2 裁决 ============

export function coordinatorAdjudicateUser(params: {
  items: Pick<BoundaryItem, "id" | "type" | "description">[];
}): string {
  const itemsText = params.items
    .map((b) => `- ${b.id} [${b.type}] ${b.description}`)
    .join("\n");
  return `请审查以下边界条目，对每条裁决：
- 保留（一致、有效）
- 合并（与另一条重叠；mergeInto 填保留目标的条目 id）
- 否决（无效/跑题/无法验证，须给出 reason）
约束：
- 必须对列表中的每一条都给出裁决，不得遗漏；
- mergeInto 仅在 verdict 为"合并"时填写，且目标必须真实存在、目标自身裁决为"保留"；不要形成合并环；
- 无法确定时一律"保留"。
输出严格 JSON 数组（不要 Markdown 代码块、不要输出任何解释文字），示例：
[{"id":"B001","verdict":"保留","mergeInto":"","reason":""},{"id":"B003","verdict":"合并","mergeInto":"B001","reason":"与 B001 重叠"}]
只输出 JSON。条目列表：
${itemsText}`;
}

// ============ R5 补充 ============

export function coordinatorSupplementUser(params: {
  topic: string;
  scope: string;
  supplement: string;
}): string {
  return `议题：${params.topic}
当前勘探范围：${params.scope}
用户在收敛后补充了新信息：
-----
${params.supplement}
-----
请把补充信息并入勘探范围（必要时修正边界），输出严格 JSON：
{"scope":"合并后的完整勘探范围","note":"一句话说明补充如何改变勘探方向"}`;
}

// ============ R5 终局 ============

export function coordinatorFinalUser(params: {
  topic: string;
  objective: string;
  scope: string;
  list: BoundaryItem[];
}): string {
  const itemsText =
    params.list.length === 0
      ? "（清单为空，请直接基于议题与产出目标给出方案）"
      : params.list
          .map(
            (b) =>
              `- ${b.id} [${b.type}] ${b.description}（可信度：${b.confidence}；来源：${b.sourceModel}）`,
          )
          .join("\n");
  return `议题：${params.topic}
产出目标：${params.objective}
勘探范围：${params.scope}
经裁决保留的边界约束清单：
${itemsText}

请围绕【产出目标】，基于这份清单，产出最终解决方案。硬性要求：
1. 输出必须是标准 Markdown（GFM），且只输出 Markdown 正文，不要输出代码块围栏包裹整篇、不要任何前后缀解释；
2. 至少包含以下二级标题（##），并按产出目标取舍增删：
   ## 方案概述（2-4 句话给结论）
   ## 关键结论（用列表给出，每条后用括号标注依据的边界 ID，如（依据 B1、B3））
   ## 落地方案（分步骤或分模块，用编号列表；每步写清「做什么 / 怎么做 / 验收标准」）
   ## 风险与前提（逐条标注对应边界 ID；明确哪些前提不成立会导致方案失效）
   ## 待补充信息（清单信息不足时列出需要用户补充的具体问题；没有则写「无」）
3. 涉及对比/维度对照时使用 Markdown 表格；关键术语可用 **加粗**；
4. 逐条回应每条保留状态的边界（至少在「关键结论」或「风险与前提」中标注其 ID 一次）；
5. 方案必须可执行、可验收，直接服务于用户的产出目标，禁止空话套话；
6. 清单为空时，在「方案概述」中明确说明信息不足，其余章节按需要补充的内容展开。
${LANGUAGE_RULE}`;
}

// ============ 用户插话分类 ============

/** 用户插话语义分类（DESIGN.md §8：无法判定时返回 other，由上层询问用户，不擅自处理） */
export function coordinatorClassifyUserTurnUser(params: { topic: string; content: string }): string {
  return `议题：${params.topic}
用户在会议过程中发送了如下内容：
-----
${params.content}
-----
请判定它属于哪一类：
- new_boundary：内容本身就是一条具体的边界/维度陈述（boundaryType 取 目标|约束|反例|前提|盲区 之一）
- supplement：对议题的补充说明、歧义澄清、反问或范围修正（不是一条具体边界）
- stop：明确要求停止勘探/出结果
- other：语义不明，无法归入以上类别
${LANGUAGE_RULE}
只输出严格 JSON：
{"kind":"new_boundary|supplement|stop|other","boundaryType":"目标|约束|反例|前提|盲区","description":"若为 new_boundary，一句话边界描述，否则空串"}`;
}
