import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
export function enabledProviders(cfg) {
    return cfg.providers.filter((p) => !p.disabled);
}
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
let cached = null;
export function loadConfig() {
    if (cached)
        return cached;
    const path = process.env.RTA_CONFIG ?? join(PROJECT_ROOT, "providers.json");
    cached = JSON.parse(readFileSync(path, "utf-8"));
    return cached;
}
export function loadSeats(overrides) {
    const cfg = loadConfig();
    return overrides && overrides.length > 0 ? overrides : cfg.defaultSeats;
}
export function getProvider(id) {
    const cfg = loadConfig();
    const p = cfg.providers.find((x) => x.id === id);
    if (!p)
        throw new Error(`未知 provider: ${id}（可用: ${cfg.providers.map((x) => x.id).join(", ")}）`);
    return p;
}
export function getAuthKey(keyName) {
    const fromEnv = process.env[keyName + "_API_KEY"] ?? process.env[`${keyName}_KEY`];
    if (fromEnv)
        return fromEnv;
    const authFile = process.env.OPENCODE_AUTH_FILE ??
        join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".local", "share", "opencode", "auth.json");
    try {
        const json = JSON.parse(readFileSync(authFile, "utf-8"));
        const entry = json[keyName];
        if (entry?.key)
            return entry.key;
    }
    catch {
        /* fall through */
    }
    throw new Error(`无法为 "${keyName}" 解析 API key。请在环境变量 ${keyName}_API_KEY 中提供，或确保 opencode auth.json 可读。`);
}
