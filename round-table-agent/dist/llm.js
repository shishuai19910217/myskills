import { getProvider, getAuthKey } from "./config.js";
async function requestBody(provider, messages, opts, stream) {
    return {
        model: provider.model,
        messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 2048,
        stream,
    };
}
function endpoint(provider) {
    const base = provider.baseURL.replace(/\/+$/, "");
    return `${base}/chat/completions`;
}
async function headers(provider) {
    const key = getAuthKey(provider.authKeyName);
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
    };
}
/** 非流式对话，返回完整文本 */
export async function chat(providerId, messages, opts = {}) {
    const provider = getProvider(providerId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
    try {
        const res = await fetch(endpoint(provider), {
            method: "POST",
            headers: await headers(provider),
            body: JSON.stringify(await requestBody(provider, messages, opts, false)),
            signal: controller.signal,
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`provider ${providerId} HTTP ${res.status}: ${detail.slice(0, 300)}`);
        }
        const json = (await res.json());
        const msg = json.choices?.[0]?.message;
        if (msg?.content && msg.content.trim())
            return msg.content;
        // 推理型模型（如 aion-labs/aion-3.0）：content 为空时回退到 reasoning 字段
        if (msg?.reasoning && msg.reasoning.trim())
            return msg.reasoning;
        return "";
    }
    finally {
        clearTimeout(timer);
    }
}
/** 流式对话，逐 chunk 回调增量文本 */
export async function chatStream(providerId, messages, onChunk, opts = {}) {
    const provider = getProvider(providerId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);
    try {
        const res = await fetch(endpoint(provider), {
            method: "POST",
            headers: await headers(provider),
            body: JSON.stringify(await requestBody(provider, messages, opts, true)),
            signal: controller.signal,
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
                        const delta = parsed.choices?.[0]?.delta?.content ?? "";
                        const reasoning = parsed.choices?.[0]?.delta?.reasoning ?? parsed.choices?.[0]?.delta?.reasoning_content ?? "";
                        if (delta) {
                            full += delta;
                            onChunk(delta);
                        }
                        else if (reasoning) {
                            full += reasoning;
                            onChunk(reasoning);
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
        clearTimeout(timer);
    }
}
