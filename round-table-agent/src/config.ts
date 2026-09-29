import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoundaryType, SeatConfig, SeatRole } from "./types.js";
import { CONFIG_PATH, ensureDefaultConfig } from "./runtime-paths.js";

export interface ProviderConfig {
  id: string;
  baseURL: string;
  model: string;
  /** 旧方式：环境变量/opencode 中的 key 名（缺省取 id） */
  authKeyName?: string;
  /** 页面直接填写的 API Key（优先于环境变量） */
  apiKey?: string;
  disabled?: boolean;
}

/** 带归一化 enabled 标记的 provider（experiment 等模块使用） */
export interface ResolvedProvider extends ProviderConfig {
  enabled: boolean;
}

export interface SeatConfigFile {
  role: string;
  provider: string;
  /** 席位级模型覆盖；缺省则跟随 provider.model */
  model?: string;
}

/** 页面可编辑的席位绑定（统筹者 + 五席） */
export interface SeatAssignment {
  role: string;
  provider: string;
  /** 空串/缺省表示跟随 provider 默认模型 */
  model?: string;
}

interface RuntimeFile {
  maxRounds?: number;
  extraRounds?: number;
  convergenceN?: number;
  convergenceWindowN?: number;
  convergenceThreshold?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface RuntimeConfig {
  coordinatorProvider: string;
  /** 统筹者模型覆盖；缺省跟随 provider.model */
  coordinatorModel?: string;
  maxRounds: number;
  /** 收敛后用户补充触发的追加轮数 */
  extraRounds: number;
  convergenceWindowN: number;
  /**
   * 收敛判据：最近 N 轮每轮的「新增条数/席位数」比率上限。
   * 取值 <1 按比率解释（缺省 0.34，即 5 席中平均至多约 1.7 条新增）；
   * 取值 >=1 按旧版「绝对条数」解释，运行时自动换算为比率。
   */
  convergenceThreshold: number;
}

interface AppConfigFile {
  providers: ProviderConfig[];
  defaultSeats: SeatConfigFile[];
  runtime?: RuntimeFile;
}

let cached: AppConfigFile | null = null;

export function configPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): AppConfigFile {
  if (cached) return cached;
  ensureDefaultConfig(); // SEA 首启自动生成默认配置；普通 node 运行为 no-op
  cached = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as AppConfigFile;
  return cached;
}

/** 配置写回后强制下次重新读盘 */
export function reloadConfig(): AppConfigFile {
  cached = null;
  return loadConfig();
}

export function enabledProviders(cfg: AppConfigFile): ProviderConfig[] {
  return cfg.providers.filter((p) => !p.disabled);
}

/** 全部 provider，附归一化 enabled 字段 */
export const providers: ResolvedProvider[] = loadConfig().providers.map((p) => ({
  ...p,
  enabled: !p.disabled,
}));

const SEAT_META: Record<
  Exclude<SeatRole, "coordinator">,
  { name: string; type: BoundaryType }
> = {
  forward: { name: "正向勘探者", type: "目标" },
  reverse: { name: "反向勘探者", type: "约束" },
  counter: { name: "反例猎人", type: "反例" },
  assumption: { name: "假设审问者", type: "前提" },
  blindspot: { name: "盲区审计员", type: "盲区" },
};

function providerModel(providerId: string): string {
  return loadConfig().providers.find((p) => p.id === providerId)?.model ?? providerId;
}

/** 统筹者绑定的 provider：取 defaultSeats 中 coordinator，否则取首个启用 provider */
function resolveCoordinatorProvider(cfg: AppConfigFile): string {
  const explicit = cfg.defaultSeats.find((s) => s.role === "coordinator")?.provider;
  if (explicit) return explicit;
  return enabledProviders(cfg)[0]?.id ?? cfg.providers[0]?.id ?? "";
}

/** 勘探席配置（id/名称/绑定边界类型/provider/模型），按固定五席顺序生成 */
function resolveSeatConfigs(cfg: AppConfigFile): SeatConfig[] {
  const providerOf = new Map(cfg.defaultSeats.map((s) => [s.role, s]));
  return (Object.keys(SEAT_META) as Exclude<SeatRole, "coordinator">[]).map((id) => {
    const bound = providerOf.get(id);
    const provider = bound?.provider ?? enabledProviders(cfg)[0]?.id ?? "";
    return {
      id,
      role: id,
      name: SEAT_META[id].name,
      type: SEAT_META[id].type,
      provider,
      model: bound?.model?.trim() || providerModel(provider),
    };
  });
}

function resolveRuntime(cfg: AppConfigFile): RuntimeConfig {
  const r = cfg.runtime ?? {};
  const coordSeat = cfg.defaultSeats.find((s) => s.role === "coordinator");
  return {
    coordinatorProvider: resolveCoordinatorProvider(cfg),
    coordinatorModel: coordSeat?.model?.trim() || undefined,
    maxRounds: r.maxRounds ?? 4,
    extraRounds: r.extraRounds ?? 2,
    convergenceWindowN: r.convergenceWindowN ?? r.convergenceN ?? 2,
    convergenceThreshold: r.convergenceThreshold ?? 0.34,
  };
}

/** 勘探席配置（启动快照，供 experiment 等离线脚本使用） */
export const seatConfigs: SeatConfig[] = resolveSeatConfigs(loadConfig());

export const runtime: RuntimeConfig = resolveRuntime(loadConfig());

/** 动态读取当前勘探席配置（页面改配置后无需重启即生效） */
export function getSeatConfigs(): SeatConfig[] {
  return resolveSeatConfigs(loadConfig());
}

/** 动态读取当前运行参数（含统筹者 provider/模型覆盖） */
export function getRuntime(): RuntimeConfig {
  return resolveRuntime(loadConfig());
}

/** 页面读取席位绑定（统筹者 + 五席），供配置面板回显 */
export function getSeatAssignments(): SeatAssignment[] {
  const cfg = loadConfig();
  const byRole = new Map(cfg.defaultSeats.map((s) => [s.role, s]));
  const roles: string[] = ["coordinator", ...(Object.keys(SEAT_META) as string[])];
  return roles.map((role) => {
    const bound = byRole.get(role);
    const provider = bound?.provider ?? (role === "coordinator" ? resolveCoordinatorProvider(cfg) : enabledProviders(cfg)[0]?.id ?? "");
    return { role, provider, model: bound?.model ?? "" };
  });
}

/**
 * 页面写回席位绑定：更新 defaultSeats（保留其它未知 role 条目），落盘 providers.json 并刷新缓存。
 * 仅对新创建的会议生效；已在运行的会议沿用启动时快照。
 */
export function saveSeatAssignments(assignments: SeatAssignment[]): void {
  const cfg = loadConfig();
  const incoming = new Map(assignments.map((a) => [a.role, a]));
  const nextSeats: SeatConfigFile[] = cfg.defaultSeats
    // 保留不在本次提交范围内的 role 条目
    .filter((s) => !incoming.has(s.role))
    .map((s) => ({ ...s }));
  for (const a of assignments) {
    if (!a.provider) continue;
    const model = a.model?.trim();
    nextSeats.push(model ? { role: a.role, provider: a.provider, model } : { role: a.role, provider: a.provider });
  }
  const next: AppConfigFile = { ...cfg, defaultSeats: nextSeats };
  writeConfig(next);
}

/** 页面提交的供应商接入信息 */
export interface ProviderInput {
  id: string;
  baseURL: string;
  model: string;
  /** 空串表示“不修改已有密钥”（新增时则不设置密钥） */
  apiKey?: string;
  disabled?: boolean;
}

/** 页面回显用：不回传明文密钥，仅告知是否已配置 */
export interface ProviderView {
  id: string;
  baseURL: string;
  model: string;
  disabled: boolean;
  hasApiKey: boolean;
}

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const SEAT_ROLES = ["coordinator", ...Object.keys(SEAT_META)];

export function getProviderViews(): ProviderView[] {
  return loadConfig().providers.map((p) => ({
    id: p.id,
    baseURL: p.baseURL,
    model: p.model,
    disabled: !!p.disabled,
    hasApiKey: !!(p.apiKey?.trim() || hasExternalKey(p)),
  }));
}

function hasExternalKey(p: ProviderConfig): boolean {
  const name = p.authKeyName || p.id;
  return !!(process.env[name + "_API_KEY"] ?? process.env[`${name}_KEY`]);
}

/**
 * 页面全量写回供应商接入信息与席位绑定。
 * apiKey 为占位空串时保留原密钥不变；席位引用到被删除/停用的供应商时回退到首个启用供应商。
 */
export function saveProvidersAndSeats(inputs: ProviderInput[], assignments: SeatAssignment[]): void {
  const cfg = loadConfig();
  const oldById = new Map(cfg.providers.map((p) => [p.id, p]));

  // 校验
  if (inputs.length === 0) throw new Error("至少需要一个供应商");
  const idSet = new Set<string>();
  for (const inp of inputs) {
    const id = inp.id?.trim();
    const baseURL = inp.baseURL?.trim();
    const model = inp.model?.trim();
    if (!id || !PROVIDER_ID_RE.test(id)) throw new Error(`非法供应商 id："${inp.id}"（仅限字母数字、下划线、短横线）`);
    if (idSet.has(id)) throw new Error(`供应商 id 重复：${id}`);
    idSet.add(id);
    if (!baseURL) throw new Error(`供应商 ${id} 缺少 baseURL`);
    try {
      new URL(baseURL);
    } catch {
      throw new Error(`供应商 ${id} 的 baseURL 不是合法地址：${baseURL}`);
    }
    if (!model) throw new Error(`供应商 ${id} 缺少模型名`);
  }

  const providers: ProviderConfig[] = inputs.map((inp) => {
    const id = inp.id.trim();
    const old = oldById.get(id);
    const p: ProviderConfig = {
      id,
      baseURL: inp.baseURL.trim().replace(/\/+$/, ""),
      model: inp.model.trim(),
    };
    if (inp.disabled) p.disabled = true;
    if (old?.authKeyName && old.authKeyName !== id) p.authKeyName = old.authKeyName; // 保留环境变量密钥名
    const key = inp.apiKey?.trim();
    if (key) p.apiKey = key;
    else if (old?.apiKey?.trim()) p.apiKey = old.apiKey; // 空串=保留原密钥
    return p;
  });

  const enabledIds = providers.filter((p) => !p.disabled).map((p) => p.id);
  const fallback = enabledIds[0];
  if (!fallback) throw new Error("至少需要一个启用的供应商");

  const assignmentByRole = new Map(assignments.map((a) => [a.role, a]));
  const nextSeats: SeatConfigFile[] = [];
  for (const role of SEAT_ROLES) {
    const a = assignmentByRole.get(role);
    let providerId = a?.provider?.trim() || "";
    const target = providers.find((p) => p.id === providerId);
    if (!target || target.disabled) providerId = fallback; // 删除或停用 → 回退首个启用
    const model = a?.model?.trim();
    nextSeats.push(model ? { role, provider: providerId, model } : { role, provider: providerId });
  }

  writeConfig({ ...cfg, providers, defaultSeats: nextSeats });
}

function writeConfig(next: AppConfigFile): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
  reloadConfig();
}

export function getProvider(id: string): ProviderConfig {
  const cfg = loadConfig();
  const p = cfg.providers.find((x) => x.id === id);
  if (!p) throw new Error(`未知 provider: ${id}（可用: ${cfg.providers.map((x) => x.id).join(", ")}）`);
  return p;
}

export function getAuthKey(provider: Pick<ProviderConfig, "authKeyName" | "id" | "apiKey">): string {
  // 页面内联配置的密钥优先
  if (provider.apiKey?.trim()) return provider.apiKey.trim();

  const keyName = provider.authKeyName || provider.id;
  const fromEnv = process.env[keyName + "_API_KEY"] ?? process.env[`${keyName}_KEY`];
  if (fromEnv) return fromEnv;

  const authFile =
    process.env.OPENCODE_AUTH_FILE ??
    join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".local", "share", "opencode", "auth.json");

  try {
    const json = JSON.parse(readFileSync(authFile, "utf-8")) as Record<string, { key?: string }>;
    const entry = json[keyName];
    if (entry?.key) return entry.key;
  } catch {
    /* fall through */
  }

  throw new Error(`无法为 "${keyName}" 解析 API key。请在模型配置中填写 API Key，或设置环境变量 ${keyName}_API_KEY。`);
}
