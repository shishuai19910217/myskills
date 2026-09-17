// 角色显示名与边界类型映射
export const SEAT_LABELS = {
    coordinator: "统筹者",
    forward: "正向勘探者",
    reverse: "反向勘探者",
    counter: "反例猎人",
    assumption: "假设审问者",
    blindspot: "盲区审计员",
};
export const SEAT_BOUNDARY_TYPE = {
    forward: "目标",
    reverse: "约束",
    counter: "反例",
    assumption: "前提",
    blindspot: "盲区",
};
export const COORDINATOR_SYSTEM = `你是"多模型圆桌会议"的统筹者。议题通常是用户对陌生领域提出的、边界不清晰的问题。
你的职责：
1. 复述议题、圈定勘探范围；
2. 按勘探维度【目标→约束→反例→前提→盲区】逐席盘问，向指定席位提出精准、开放、不预设答案的问题；
3. 对边界池中有冲突/重叠的条目裁决（保留 / 合并 / 否决），给出被否理由；
4. 判定勘探是否收敛；
5. 汇总输出【边界约束清单】；
6. 基于清单生成最终解决方案。
原则：你只负责勘探与收敛，不代替其他席位回答；盘问问题不得暗示答案。`;
export function seatSystemPrompt({ label, boundaryType, topic }) {
    const typeHint = boundaryType === "目标"
        ? "你的每条产出应是：一个具体的、可操作的方面/维度（如'对话千人一面'、'动作描写模板化'）。"
        : boundaryType === "约束"
            ? "你的每条产出应是：一条具体的限制/禁区/前提条件（如'不能破坏角色口癖'、'避免高频词互替'）。"
            : boundaryType === "反例"
                ? "你的每条产出应是：一个会击穿已有维度的具体反例场景（如'某人类作家也这么写'）。"
                : boundaryType === "前提"
                    ? "你的每条产出应是：一个隐含的、未被明说的前提（如'默认 AI 生成必然缺个体指纹'）。"
                    : "你的每条产出应是：一个所有人都还没提到的具体方面或维度。";
    return `你是圆桌会议中的「${label}」，负责勘探「${boundaryType}」类边界。
议题：${topic}
规则：
- 每轮只输出 1 条当前最值得补充的「${boundaryType}」边界；确实没有新的时输出 null；
- 不得重复已有边界；
- ${typeHint}
- 只产边界条目，不给出最终方案；描述要具体、可验证，不要抽象定义或空泛哲学；
- 输出严格 JSON（不要 Markdown 代码块）：
  {"boundary":{"type":"${boundaryType}","description":"一句话边界描述","reason":"为什么这是边界","counterExamples":["反例1"]},"confidence":"高"} 
  或 {"boundary":null}`;
}
export function seatUserPrompt(params) {
    const poolText = params.pool.length === 0
        ? "（尚无已确认边界）"
        : params.pool.map((b) => `- [${b.type}] ${b.description}`).join("\n");
    return `议题：${params.topic}
产出目标：${params.objective}
勘探范围：${params.scope}
已有边界清单：
${poolText}

当前第 ${params.round} 轮。
统筹者盘问：${params.question}

请从你的「${params.boundaryType}」视角，围绕产出目标，输出 1 条新的边界（JSON），或 null。`;
}
export function coordinatorOpenUser(input) {
    return `用户输入如下（可能是文本/附件/链接内容）：
-----
${input}
-----
请：
1) 用一句话复述议题（用户真正想问什么）；
2) 识别用户的实际产出目标（如"列出完整维度/方面清单""判断某事是否可行""设计一个方案""诊断问题"）——这是本次会议的验收标准，务必贴近用户原话的意图；
3) 圈定勘探范围（明确"什么是本题边界""什么超出范围"）。
输出 JSON：{"topic":"一句话议题","objective":"产出目标","scope":"勘探范围"}`;
}
export function coordinatorQuestionUser(params) {
    const poolText = params.pool.length === 0
        ? "（尚无已确认边界）"
        : params.pool.map((b) => `- [${b.type}] ${b.description}`).join("\n");
    return `议题：${params.topic}
产出目标：${params.objective}
勘探范围：${params.scope}
已确认边界：
${poolText}

当前第 ${params.round} 轮。请向「${params.seatLabel}」（勘探维度：${params.boundaryType}）提出 1 个精准的盘问问题，帮助它围绕【产出目标】挖出尚未覆盖的「${params.boundaryType}」边界。
要求：问题要具体、指向可枚举的方面，服务于产出目标；开放、不暗示答案；不重复已经覆盖的维度。只输出问题本身。`;
}
export function coordinatorAdjudicateUser(params) {
    const itemsText = params.items
        .map((b) => `- ${b.id} [${b.type}] ${b.description}（提出：${b.proposer}）`)
        .join("\n");
    return `议题：${params.topic}
请审查以下边界条目，对每条裁决：
- 保留（一致）
- 合并（与该条冲突/重叠的条目号）
- 否决（被否理由）
输出 JSON 数组：
[{"id":"B001","verdict":"保留|合并|否决","mergeInto":"B002|""","reason":"理由"}]
只输出 JSON。条目列表：
${itemsText}`;
}
export function coordinatorConvergeUser(params) {
    const poolText = params.pool.length === 0
        ? "（空）"
        : params.pool.map((b) => `- [${b.type}] ${b.description}`).join("\n");
    return `议题：${params.topic}
当前边界池：
${poolText}
最近几轮新增数：${params.recentRounds.map((r) => `第${r.round}轮+${r.newCount}`).join("，")}

请判断：勘探是否已经收敛（即继续盘问几乎不会再有新边界）？
只输出 JSON：{"converged":true|false,"reason":"一句话"}`;
}
export function coordinatorFinalUser(params) {
    const itemsText = params.list
        .map((b) => `- ${b.id} [${b.type}] ${b.description}（${b.status.kind}${b.status.verdict ? "｜裁决:" + b.status.verdict : ""}）`)
        .join("\n");
    return `议题：${params.topic}
产出目标：${params.objective}
勘探范围：${params.scope}
已确认边界约束清单：
${itemsText}

请围绕【产出目标】，基于这份清单，产出最终解决方案。要求：
- 逐条回应每条边界（标注对应边界 ID）；
- 方案可执行、结构清晰，直接服务于用户的产出目标。
输出 Markdown。`;
}
