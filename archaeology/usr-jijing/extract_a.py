#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阶段A 清单提取脚本 — usr-jijing 平台
只做机械化提取，产出 FACT 级清单（锚点精确到行号）。
"""
import os, re, json, sys, collections

ROOT = r"D:\youren\jiejuefangan\code\usr-jijing"
BACKENDS = ["usr-demeter-all", "usr-demeter-old-framework-back-service", "usr-demeter-old-framework-back-web"]
FRONT = "usr-front"

os.chdir(ROOT)

def files(base, exts, skip_target=True):
    if isinstance(base, str):
        base = [base]
    out = []
    for b in base:
        for dirpath, dirnames, filenames in os.walk(b):
            if skip_target and "target" in dirpath.split(os.sep):
                continue
            if "node_modules" in dirpath.split(os.sep):
                continue
            for f in filenames:
                if any(f.endswith(e) for e in exts):
                    out.append(os.path.join(dirpath, f))
    return out

def rd(p, enc=None):
    for e in (enc, "utf-8", "gbk", "latin-1"):
        try:
            with open(p, "r", encoding=e, errors="replace") as fh:
                return fh.read()
        except Exception:
            continue
    return ""

report = {}

# ============ 1. Controller 清单 ============
print("=" * 60)
print("1. CONTROLLER 清单")
print("=" * 60)
java = files(BACKENDS, [".java"])
ctrl_stats = {"RestController": 0, "Controller": 0, "other": 0}
ctrl_list = []
for p in java:
    s = rd(p)
    if "@RestController" in s:
        ctrl_stats["RestController"] += 1
        cls = re.search(r"public\s+class\s+(\w+)", s)
        cls = cls.group(1) if cls else "?"
        # 类级 RequestMapping
        clsmap = re.search(r"@RequestMapping\s*\(\s*(?:value\s*=\s*)?[\"']([^\"']+)[\"']", s)
        base = clsmap.group(1) if clsmap else ""
        # 方法级 mapping
        methods = []
        for m in re.finditer(r"@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(([^)]*)\)", s):
            kind = m.group(1).upper()
            arg = m.group(2)
            pm = re.search(r"[\"']([^\"']+)[\"']", arg)
            path = pm.group(1) if pm else "/"
            line = s[:m.start()].count("\n") + 1
            methods.append(f"    {kind:6} {path}   (line {line})")
        ctrl_list.append((p, cls, base, methods))
    elif re.search(r"@Controller\b", s) and "ServiceImpl" not in p:
        ctrl_stats["Controller"] += 1

print(f"RestController 类数: {ctrl_stats['RestController']}")
print(f"Controller 类数: {ctrl_stats['Controller']}")
print(f"含方法级 mapping 的 Controller 数: {len(ctrl_list)}")
# 按 web 模块分组
by_web = collections.Counter()
for p, cls, base, m in ctrl_list:
    parts = p.replace("\\", "/").split("/")
    try:
        i = parts.index("usr-demeter-old-framework-back-web")
        by_web[parts[i + 1]] += 1
    except ValueError:
        by_web["usr-demeter-all/..."] += 1
print("按 web 模块分组:", dict(by_web))
print("\n前 15 个 Controller 样例:")
for p, cls, base, methods in ctrl_list[:15]:
    print(f"  {cls}  base={base}  {p}")
    for mm in methods[:3]:
        print(mm)

# ============ 2. 定时任务 ============
print("\n" + "=" * 60)
print("2. 定时任务 (@Scheduled)")
print("=" * 60)
sched = []
for p in java:
    s = rd(p)
    for m in re.finditer(r"@Scheduled\s*\(([^)]*)\)", s):
        line = s[:m.start()].count("\n") + 1
        cls = re.search(r"public\s+class\s+(\w+)", s)
        cls = cls.group(1) if cls else "?"
        cron = re.search(r"cron\s*=\s*\"([^\"]+)\"", m.group(1))
        fd = re.search(r"fixedDelay\s*=\s*(\d+)", m.group(1))
        fr = re.search(r"fixedRate\s*=\s*(\d+)", m.group(1))
        expr = cron.group(1) if cron else (f"fixedDelay={fd.group(1)}ms" if fd else (f"fixedRate={fr.group(1)}ms" if fr else "?"))
        sched.append((cls, line, expr, p))
for cls, line, expr, p in sched:
    print(f"  {cls:35} cron={expr:30} line={line}")
print(f"\n活跃 @Scheduled 总数: {len(sched)}")

# ============ 3. MQ 消费者/生产者 ============
print("\n" + "=" * 60)
print("3. MQ 相关")
print("=" * 60)
mq_cons = []
mq_prod = []
for p in java:
    s = rd(p)
    for m in re.finditer(r"@RocketMQMessageListener\s*\(([^)]*)\)", s):
        line = s[:m.start()].count("\n") + 1
        cls = re.search(r"public\s+class\s+(\w+)", s)
        cls = cls.group(1) if cls else "?"
        topic = re.search(r"topic\s*=\s*\"([^\"]+)\"", m.group(1))
        cons = re.search(r"consumerGroup\s*=\s*\"([^\"]+)\"", m.group(1))
        mq_cons.append((cls, line, topic.group(1) if topic else "?", cons.group(1) if cons else "?", p))
    for m in re.finditer(r"@RabbitListener\s*\(([^)]*)\)|@KafkaListener\s*\(([^)]*)\)", s):
        line = s[:m.start()].count("\n") + 1
        cls = re.search(r"public\s+class\s+(\w+)", s)
        cls = cls.group(1) if cls else "?"
        mq_cons.append((cls, line, m.group(0)[:60], "", p))
    for m in re.finditer(r"\.(convertAndSend|send|sendMessage|syncSend)\s*\(", s):
        line = s[:m.start()].count("\n") + 1
        cls = re.search(r"public\s+class\s+(\w+)", s)
        cls = cls.group(1) if cls else "?"
        mq_prod.append((cls, line, m.group(1), p))
print(f"MQ 消费者类: {len(mq_cons)}")
for c in mq_cons:
    print(f"  {c[0]:35} topic={c[2]:30} group={c[3]:25} line={c[1]}")
print(f"\nMQ 生产者调用点: {len(mq_prod)}")
by_cls = collections.Counter(x[0] for x in mq_prod)
print("  Top 生产者类:", dict(by_cls.most_common(10)))

# ============ 4. 事件监听 ============
print("\n" + "=" * 60)
print("4. 事件监听")
print("=" * 60)
ev_list = []
for p in java:
    s = rd(p)
    for m in re.finditer(r"@EventListener|@TransactionalEventListener|implements\s+ApplicationListener", s):
        line = s[:m.start()].count("\n") + 1
        cls = re.search(r"public\s+class\s+(\w+)", s)
        cls = cls.group(1) if cls else "?"
        ev_list.append((cls, line, m.group(0), p))
print(f"事件监听点: {len(ev_list)}")
for cls, line, kind, p in ev_list:
    print(f"  {cls:35} {kind:35} line={line}")

# ============ 5. AOP 切面 ============
print("\n" + "=" * 60)
print("5. AOP 切面")
print("=" * 60)
aspects = []
for p in java:
    s = rd(p)
    if "@Aspect" in s:
        cls = re.search(r"public\s+class\s+(\w+)", s)
        cls = cls.group(1) if cls else "?"
        advices = []
        for m in re.finditer(r"@(Around|Before|After|AfterReturning|AfterThrowing)\s*\(([^)]*)\)", s):
            line = s[:m.start()].count("\n") + 1
            advices.append((m.group(1), m.group(2), line))
        aspects.append((cls, advices, p))
print(f"@Aspect 类: {len(aspects)}")
for cls, advs, p in aspects:
    print(f"  {cls}  ({len(advs)} advice)")
    for a, pt, ln in advs:
        print(f"      {a:18} {pt:50} line={ln}")

# ============ 6. Filter / Interceptor ============
print("\n" + "=" * 60)
print("6. Filter / Interceptor")
print("=" * 60)
filters, inters = [], []
for p in java:
    s = rd(p)
    for m in re.finditer(r"implements\s+Filter\b|@WebFilter", s):
        line = s[:m.start()].count("\n") + 1
        cls = re.search(r"public\s+class\s+(\w+)", s)
        cls = cls.group(1) if cls else "?"
        filters.append((cls, line, p))
    for m in re.finditer(r"implements\s+HandlerInterceptor|addInterceptors\s*\(", s):
        line = s[:m.start()].count("\n") + 1
        cls = re.search(r"public\s+class\s+(\w+)", s)
        cls = cls.group(1) if cls else "?"
        inters.append((cls, line, m.group(0), p))
print(f"Filter: {len(filters)}")
for c, l, p in filters:
    print(f"  {c:35} line={l}")
print(f"Interceptor: {len(inters)}")
for c, l, k, p in inters:
    print(f"  {c:35} {k:25} line={l}")

# ============ 7. Mapper XML → 表 清单 ============
print("\n" + "=" * 60)
print("7. Mapper XML → 数据表")
print("=" * 60)
xmls = files(BACKENDS, [".xml"])
mapper_xml = [x for x in xmls if "apper" in x.lower() and "Mapper" in x.split("\\")[-1]]
print(f"Mapper XML 总数: {len(mapper_xml)}")
table_ops = {}  # table -> {"read": set(mapper), "write": set(mapper)}
for x in mapper_xml:
    s = rd(x)
    # 表名提取: from/join/into/update 后跟表名
    tbls = set()
    for m in re.finditer(r"\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+`?(\w+)`?", s, re.I):
        t = m.group(1).lower()
        if t not in ("select", "where", "set", "values", "dual", "on", "as", "and", "or", "not", "null"):
            tbls.add(t)
    fname = os.path.basename(x)
    write = bool(re.search(r"<insert|<update|<delete|<select[^>]*resultType", s, re.I))
    has_insert = bool(re.search(r"<insert", s, re.I))
    has_update = bool(re.search(r"<update", s, re.I))
    has_delete = bool(re.search(r"<delete", s, re.I))
    for t in tbls:
        d = table_ops.setdefault(t, {"read": set(), "write": set(), "xml": set()})
        d["xml"].add(fname)
        d["read"].add(fname)
        if has_insert or has_update or has_delete:
            d["write"].add(fname)
print(f"\n从 XML 提取到的表名(粗提取,含 SQL 关键字噪声): {len(table_ops)}")
# 噪声过滤
noise = {"select", "where", "set", "values", "dual", "on", "as", "and", "or", "not", "null",
         "if", "when", "otherwise", "foreach", "where_", "trim", "case", "end", "else",
         "from", "join", "into", "update", "table", "insert", "delete", "resultType",
         "parameterType", "resultMap", "sql", "include", "refid"}
real_tables = {t: v for t, v in table_ops.items() if t not in noise and len(t) > 3}
print(f"过滤后表名: {len(real_tables)}")
# 只列出有写入的表
write_tables = {t: v for t, v in real_tables.items() if v["write"]}
print(f"有写操作的表: {len(write_tables)}")
print("\n有写操作的表(前 40):")
for t, v in sorted(write_tables.items())[:40]:
    print(f"  {t:45} read={len(v['read']):3} write={len(v['write']):3}")

# ============ 8. 实体类 ============
print("\n" + "=" * 60)
print("8. 实体类 (@TableName / @Entity)")
print("=" * 60)
ent_count = 0
ent_list = []
for p in java:
    s = rd(p)
    if "@TableName" in s or "@Entity" in s:
        m = re.search(r"@TableName\s*\(\s*(?:value\s*=\s*)?\"([^\"]+)\"", s)
        if m:
            cls = re.search(r"public\s+class\s+(\w+)", s)
            cls = cls.group(1) if cls else "?"
            ent_list.append((cls, m.group(1), p))
            ent_count += 1
print(f"@TableName 实体: {ent_count}")
for c, t, p in ent_list[:30]:
    print(f"  {c:35} table={t}")

# ============ 9. 配置项 ============
print("\n" + "=" * 60)
print("9. 配置文件")
print("=" * 60)
cfgs = files(BACKENDS, [".yml", ".yaml", ".properties"])
cfgs = [c for c in cfgs if "target" not in c]
print(f"配置文件: {len(cfgs)}")
val_count = 0
for c in cfgs:
    s = rd(c)
    val_count += len(re.findall(r"\$\{[^}]+\}", s))
print(f"${{...}} 占位符总数: {val_count}")

# ============ 10. 前端路由/API ============
print("\n" + "=" * 60)
print("10. 前端")
print("=" * 60)
vue = files(FRONT, [".vue"])
js = files(FRONT, [".js"])
print(f"Vue 文件: {len(vue)}, JS 文件: {len(js)}")
api_files = [j for j in js if re.search(r"/api/", j.replace("\\", "/"))]
print(f"api 目录文件: {len(api_files)}")
for a in api_files[:15]:
    print(f"  {a}")
router_files = [j for j in js if "router" in j.lower()]
print(f"\nrouter 文件: {len(router_files)}")
for r in router_files:
    print(f"  {r}")
# axios/request 调用点
api_calls = 0
for j in js:
    s = rd(j)
    api_calls += len(re.findall(r"(?:axios|request|http)\.(?:get|post|put|delete)\s*\(", s))
print(f"\n前端 API 调用点(axios/request): {api_calls}")

print("\n" + "=" * 60)
print("DONE")
print("=" * 60)
