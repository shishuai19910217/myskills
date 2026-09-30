// 运行时路径解析：
// - 普通 node 运行：项目根 = 编译产物 dist 的上一级（providers.json / data 都在项目根）；
// - SEA 单 exe 运行：可写数据全部放在 exe 同目录（exe 内部是只读虚拟文件系统，不能写）。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/** 是否运行在 SEA 单文件可执行程序中 */
export function detectSea(): boolean {
  try {
    // Node v22+ 的 node:sea.isSea 是函数（返回布尔）；旧版本可能是布尔属性。
    // 兼容两种形态：函数则调用，布尔则直接取。
    const require = createRequire(import.meta.url);
    const sea = require("node:sea") as { isSea?: (() => boolean) | boolean };
    const v = sea.isSea;
    return typeof v === "function" ? !!v() : !!v;
  } catch {
    return false;
  }
}

export const IS_SEA = detectSea();

const distDir = fileURLToPath(new URL(".", import.meta.url));

/** 可写数据根目录：SEA 下为 exe 所在目录，否则为项目根 */
export const DATA_ROOT = IS_SEA ? dirname(process.execPath) : join(distDir, "..");

/** providers.json 路径（允许 RTA_CONFIG 覆盖） */
export const CONFIG_PATH = process.env.RTA_CONFIG ?? join(DATA_ROOT, "providers.json");

/** 会议快照/报告目录 */
export const MEETINGS_DIR = join(DATA_ROOT, "data", "meetings");

/** 专项模板配置文件路径（静态只读，随程序发布；node 模式从项目根 data/ 读，SEA 模式由构建脚本内嵌为 asset） */
export const SPECIALTIES_PATH = join(DATA_ROOT, "data", "specialties.json");

/** 首启默认配置：6 个席位全部绑定 free 通道（9r 本地服务），密钥留空由用户在配置页填写 */
const DEFAULT_CONFIG = `{
  "providers": [
    {
      "id": "free",
      "baseURL": "http://localhost:20129/v1",
      "model": "free"
    }
  ],
  "defaultSeats": [
    { "role": "coordinator", "provider": "free" },
    { "role": "forward", "provider": "free" },
    { "role": "reverse", "provider": "free" },
    { "role": "counter", "provider": "free" },
    { "role": "assumption", "provider": "free" },
    { "role": "blindspot", "provider": "free" }
  ],
  "runtime": {
    "maxRounds": 4,
    "extraRounds": 2,
    "convergenceN": 2,
    "convergenceThreshold": 0.34,
    "temperature": 0.4
  }
}
`;

/** SEA 首启：exe 同目录没有 providers.json 时写入默认配置，保证开箱可启动 */
export function ensureDefaultConfig(): void {
  if (!IS_SEA) return;
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, DEFAULT_CONFIG, "utf-8");
    console.log(`首次运行，已在程序同目录生成默认配置：${CONFIG_PATH}`);
    console.log("（默认指向本地 9r 服务 http://localhost:20129，可在页面「模型配置」中修改供应商与密钥）");
  }
}
