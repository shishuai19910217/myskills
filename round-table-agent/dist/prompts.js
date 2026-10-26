/** 始终使用简体中文的硬约束（英文专有名词除外） */
const LANGUAGE_RULE = "始终使用简体中文作答（英文专有名词、引用原文除外），禁止整句使用英文。";
export const GOAL_LABEL = {
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
export function coordinatorSystemPrompt() {
    return COORDINATOR_SYSTEM;
}
// ============ R0 开题 ============
export function coordinatorOpeningUser(params) {
    let base = `用户输入如下（可能是文本/附件/链接内容）：
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
    // 专项追加（仅当非 general 时）：先 hint，再种子维度
    if (params.openingHint)
        base += `\n\n${params.openingHint}`;
    if (params.seedDimensionsText) {
        base += `\n\n已预置的种子维度（已知值得勘探的方向，作为开题参考；请勿重复列出种子本身，应聚焦该信号在文本中的具体证据 + 维度归属 + 修改建议方向）：
${params.seedDimensionsText}`;
    }
    return base;
}
// ============ R1 盘问 ============
export function coordinatorQuestionUser(params) {
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
/** 批量出题：统筹者一次为全部 5 席各产出 1 个盘问问题 */
export function coordinatorBatchQuestionUser(params) {
    const seatList = params.seats
        .map((s, i) => `${i + 1}. seat="${s.id}"（${s.name}，角色：${s.role}，维度：${s.type}）`)
        .join("\n");
    return `议题：${params.topic}
产出目标类型：${GOAL_LABEL[params.goalType]}
勘探范围：${params.scope}
当前边界池：
${params.pool}

当前第 ${params.round} 轮。请为以下全部 ${params.seats.length} 个席位各提出 1 个精准的盘问问题：
${seatList}

要求：
- 每个问题具体、指向可枚举的方面；开放、不暗示答案；
- 明确指向边界池中尚未出现的新角度，不要重复已覆盖维度；
- 问题本身包含足够语境，不要使用"请从你的职责出发"这类空泛措辞；
- 问题正文不超过 80 个汉字，直接提问，禁止复述边界池内容或铺垫"当前已涵盖……"；
- 5 个问题之间角度互不重叠，各席各挖各的维度。
只输出严格 JSON：
{"questions":[{"seat":"forward","question":"问题正文"},{"seat":"reverse","question":"问题正文"},...]}`;
}
// ============ 席位作答 ============
const CONFIDENCE_ANCHOR = `confidence 按客观锚点取值，不要默认报高：
- high：描述具体，能直接举例或在真实文本/事实中验证；
- medium：方向明确，但需要进一步举证或边界尚模糊；
- low：推测性、尚不确定。`;
const TYPE_HINT = {
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
const ENUMERATE_HINT = {
    目标: "本题要枚举方面清单：直接产出一个候选方面（该问题在对象上的具体表现维度）。",
    约束: "本题要枚举方面清单：产出一条以方面为主体的判据边界，说明该方面在什么条件下成立/不成立（形如'X 仅在……条件下才算'），不要只给禁令。",
    反例: "本题要枚举方面清单：先用半句话给出反例，再明确写出它所排除或修正的那个方面（形如'因此 X 不能单独作为判据'），方面必须出现在描述里。",
    前提: "本题要枚举方面清单：写出该隐含假设所指向的、可被观察的具体方面（形如'默认 X 总是……'），不要停留在纯抽象假设。",
};
export function seatSystemPrompt(seat, goalType = "other", opts) {
    const enumerateRule = goalType === "enumerate" ? ENUMERATE_HINT[seat.type] : undefined;
    let prompt = `你是圆桌会议中的「${seat.name}」，负责勘探「${seat.type}」类边界。
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
    // 专项追加（仅当非 general 时）：席位 prompt 主体不变，仅追加专项要求；
    // segmentRange 占位符在阶段2 全部填"全文"，阶段3 分段流水线落地后填真实章节定位
    if (opts?.seatHint) {
        const segmentRange = opts.segmentRange ?? "全文";
        const hint = opts.seatHint.replace(/\{\{segmentRange\}\}/g, segmentRange);
        prompt += `\n\n${hint}`;
    }
    return prompt;
}
// ============ R3 收敛判定 ============
export function coordinatorConvergeUser(params) {
    return `当前边界池：
${params.pool}
历轮新增数：${params.newPerRound.map((n, i) => `第${i + 1}轮+${n}`).join("，")}

请判断：勘探是否已经收敛（即继续盘问几乎不会再有新边界）？
${LANGUAGE_RULE}
先输出 JSON：{"converged":true|false,"reason":"一句话"}，随后另起一行给出结论：收敛 或 继续。`;
}
// ============ R2 裁决 ============
export function coordinatorAdjudicateUser(params) {
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
export function coordinatorSupplementUser(params) {
    return `议题：${params.topic}
当前勘探范围：${params.scope}
用户在收敛后补充了新信息：
-----
${params.supplement}
-----
请把补充信息并入勘探范围（必要时修正边界），输出严格 JSON：
{"scope":"合并后的完整勘探范围","note":"一句话说明补充如何改变勘探方向"}`;
}
// ============ R5 终局（模板驱动：单场会议与分段流水线共用） ============
/** 代码预填后仍由 LLM 填充的占位符形如 {{xxx}}；拆分模式下逐段清单用该标记占位 */
export const SEGMENT_SECTIONS_MARKER = "<!--SEGMENT_SECTIONS-->";
/**
 * 终局/汇总统一提示词：以专项 finalTemplate 为骨架。
 * - params.template 已由编排器完成代码可算占位符的预填（范围/轮数/统计等），
 *   剩余 {{xxx}} 占位符全部由 LLM 依据证据条目填充；
 * - splitMode 下逐段章节由代码生成，模板对应位置已替换为 SEGMENT_SECTIONS_MARKER，
 *   LLM 必须原样保留该标记且不要自行输出逐段清单；
 * - partial（提前汇总）时只能使用已完成段的证据，禁止对未诊断段下判断。
 */
export function coordinatorFinalTemplateUser(params) {
    const itemsText = params.list.length === 0
        ? "（证据清单为空）"
        : params.list
            .map((b) => {
            const seg = b.segment != null ? `【第${b.segment}段】` : "";
            return `- ${b.id} [${b.type}] ${seg}${b.description}（可信度：${b.confidence}；来源：${b.sourceModel}）`;
        })
            .join("\n");
    const split = !!params.splitMode;
    const partial = !!params.partial;
    const sourceBlock = params.sourceText
        ? `待诊断原文（完整全文，以下证据条目均出自它；禁止声称正文未提供/未呈现）：
----- BEGIN SOURCE TEXT -----
${params.sourceText}
----- END SOURCE TEXT -----

`
        : "";
    const seedBlock = params.seedDimensionsText
        ? `本专项的维度编号与官方命名（报告中所有维度名称必须与此逐字一致，禁止自造名称或写「名称以体系表为准」）：
----- BEGIN DIMENSIONS -----
${params.seedDimensionsText}
----- END DIMENSIONS -----

`
        : "";
    return `议题：${params.topic}
产出目标：${params.objective}
${sourceBlock}${seedBlock}${partial ? `本次为【提前汇总】，仅覆盖已完成的 ${params.completed} / ${params.total} 段，结论可能随后续段改变。` : ""}
经裁决保留的证据条目：
${itemsText}

下方是本专项的【报告模板骨架】，部分位置已由系统预填。请严格依据上面的证据条目完成报告：
----- BEGIN TEMPLATE -----
${params.template}
----- END TEMPLATE -----

硬性要求：
1. 输出必须是标准 Markdown（GFM），且只输出最终报告正文，不要代码块围栏包裹整篇、不要前后缀解释、不要重复输出 BEGIN/END TEMPLATE 标记；
2. 完整保留模板的标题层级、表格结构与字段顺序，不得删改已预填内容；把骨架中每一个 {{占位符}} 替换为依据证据得出的实质内容；模板没有的章节不要新增，模板要求的章节不得缺失；
3. 所有结论必须可追溯到证据条目：引用具体证据时在句末用括号标注条目 ID（如（依据 B001、B003））；定位信息（章节/段落）与证据原文片段必须保留，不得泛化；
4. 评分规则：模板中每一个评分项/维度都必须给出具体分数与一句话依据，严禁整项留空、严禁以「证据不足」「正文未呈现」为由拒评——原文已在上方完整提供；某维度在原文中确实缺少对应内容时，按「无此类问题（表现良好）」或中性分处理并注明依据，而不是拒评；只有原文被外部截断、确实无法看到相关段落时，才允许标注「证据不足」；禁止编造原文中不存在的细节；
${split ? `5. 骨架中的 ${SEGMENT_SECTIONS_MARKER} 标记必须【原样、单独成行】保留，该章节由系统另行生成插入；你不要自行输出逐段/逐章清单，也不要删除或改动该标记；` : ""}
${partial ? `${split ? "6" : "5"}. 只能使用已完成段的证据，禁止对未诊断段下任何判断；并在报告开头一句话注明「本报告为提前汇总，仅覆盖前 ${params.completed} / ${params.total} 段」。` : ""}
${split || partial ? "" : "5. "}专项为文本诊断时只诊断不改写：可给出修改方向与建议，但不要直接代写改写后的正文；
6. 占位符全部替换完成后，输出中不得残留任何 {{}} 或未替换的占位符（${SEGMENT_SECTIONS_MARKER} 除外）。
${LANGUAGE_RULE}`;
}
// ============ 用户插话分类 ============
/** 用户插话语义分类（DESIGN.md §8：无法判定时返回 other，由上层询问用户，不擅自处理） */
export function coordinatorClassifyUserTurnUser(params) {
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
