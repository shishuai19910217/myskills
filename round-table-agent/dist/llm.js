import { getProvider, getAuthKey } from "./config.js";
async function requestBody(provider, messages, opts, stream) {
    return {
        model: opts.model?.trim() || provider.model,
        messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 20480,
        stream,
    };
}
function endpoint(provider) {
    const base = provider.baseURL.replace(/\/+$/, "");
    return `${base}/chat/completions`;
}
async function headers(provider) {
    const key = getAuthKey(provider);
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
    };
}
/** 合并超时信号与外部取消信号 */
function combineSignal(timeoutMs, external) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);
    if (external) {
        if (external.aborted)
            controller.abort(external.reason);
        else
            external.addEventListener("abort", () => controller.abort(external.reason), { once: true });
    }
    return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}
/** 可重试的网络层错误码：连接重置/拒绝/超时、DNS、socket、undici 超时族 */
const RETRYABLE_CODES = new Set([
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "EHOSTUNREACH",
    "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);
/** 打印错误链（undici: TypeError -> cause SystemError），用于日志定位 */
function describeErrorChain(err) {
    const parts = [];
    let cur = err;
    for (let i = 0; i < 3 && cur; i++) {
        const e = cur;
        parts.push(`${e.name ?? "Error"}${e.code ? `[${e.code}]` : ""}: ${String(e.message ?? "").slice(0, 120)}`);
        cur = e.cause;
    }
    return parts.join("  <-  ");
}
/** 瞬时网络故障判定（主动 abort 不算）：
 *  ① cause 带可重试 code；② undici 裸 TypeError: fetch failed（连接未建立/响应前中断，cause 可能无标准 code） */
function retryableNetworkError(err) {
    const e = err;
    if (!e)
        return false;
    if (e.name === "AbortError" || e.code === "ABORT_ERR")
        return false;
    const code = e.cause?.code ?? e.code;
    if (code && RETRYABLE_CODES.has(code))
        return true;
    return e.name === "TypeError" && /fetch failed/i.test(e.message ?? "");
}
/** 可重试的 HTTP 状态：限流/网关错误（4xx 配置类错误不重试） */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 非流式对话，返回完整文本（默认只取 content，不混入 reasoning）。
 *  对瞬时网络错误 / 5xx / 429 自动退避重试 1 次。 */
export async function chat(providerId, messages, opts = {}) {
    const provider = getProvider(providerId);
    const { signal, cancel } = combineSignal(opts.timeoutMs ?? 120_000, opts.signal);
    const maxAttempts = 2;
    try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const res = await fetch(endpoint(provider), {
                    method: "POST",
                    headers: await headers(provider),
                    body: JSON.stringify(await requestBody(provider, messages, opts, false)),
                    signal,
                });
                if (!res.ok) {
                    const detail = await res.text().catch(() => "");
                    if (attempt < maxAttempts && RETRYABLE_STATUS.has(res.status)) {
                        console.warn(`[chat] provider=${providerId} HTTP ${res.status}，第 ${attempt} 次失败，2s 后重试`);
                        await sleep(2_000);
                        continue;
                    }
                    throw new Error(`provider ${providerId} HTTP ${res.status}: ${detail.slice(0, 300)}`);
                }
                const json = (await res.json());
                const msg = json.choices?.[0]?.message;
                if (msg?.content && msg.content.trim())
                    return msg.content;
                if (opts.fallbackReasoning && msg?.reasoning && msg.reasoning.trim())
                    return msg.reasoning;
                return "";
            }
            catch (err) {
                // 网络层失败（fetch failed / ECONNRESET 等）：退避后重试；非瞬时错误直接抛
                if (attempt < maxAttempts && retryableNetworkError(err) && !signal.aborted) {
                    console.warn(`[chat] provider=${providerId} 网络故障，第 ${attempt} 次失败，2s 后重试 | ${describeErrorChain(err)}`);
                    await sleep(2_000);
                    continue;
                }
                if (retryableNetworkError(err)) {
                    throw new Error(`provider ${providerId} 网络连接失败（重试后仍失败）：上游服务不可用或中断了连接。${describeErrorChain(err)}`);
                }
                throw err;
            }
        }
        return "";
    }
    finally {
        cancel();
    }
}
/** 流式对话，逐 chunk 回调增量正文（reasoning 增量被忽略，不混入正文） */
export async function chatStream(providerId, messages, onChunk, opts = {}) {
    const provider = getProvider(providerId);
    const { signal, cancel } = combineSignal(opts.timeoutMs ?? 180_000, opts.signal);
    try {
        const res = await fetch(endpoint(provider), {
            method: "POST",
            headers: await headers(provider),
            body: JSON.stringify(await requestBody(provider, messages, opts, true)),
            signal,
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`provider ${providerId} HTTP ${res.status}: ${detail.slice(0, 300)}`);
        }
        if (!res.body)
            throw new Error(`provider ${providerId} 无响应体`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let full = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let sep = buffer.indexOf("\n\n");
            while (sep >= 0) {
                const raw = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                for (const line of raw.split("\n")) {
                    if (!line.startsWith("data:"))
                        continue;
                    const data = line.slice(5).trim();
                    if (data === "[DONE]")
                        break;
                    try {
                        const parsed = JSON.parse(data);
                        // 只转发正文增量；reasoning / reasoning_content 属于推理链，不进发言
                        const delta = parsed.choices?.[0]?.delta?.content ?? "";
                        if (delta) {
                            full += delta;
                            onChunk(delta);
                        }
                    }
                    catch {
                        /* 忽略解析失败的数据行 */
                    }
                }
                sep = buffer.indexOf("\n\n");
            }
        }
        return full;
    }
    finally {
        cancel();
    }
}
