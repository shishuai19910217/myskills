#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阶段A-2 双入口交叉对账 — usr-jijing
接口侧: Controller/定时任务/事件监听 → Service → Mapper → 表
数据侧: Mapper XML + 注解SQL + 原生SQL → 表
产出: 幽灵写入点(A-B) / 孤儿表(B-A)
"""
import os, re, collections, json

ROOT = r"D:\youren\jiejuefangan\code\usr-jijing"
BACKENDS = ["usr-demeter-all", "usr-demeter-old-framework-back-service", "usr-demeter-old-framework-back-web"]
os.chdir(ROOT)

def files(base, exts):
    if isinstance(base, str): base = [base]
    out = []
    for b in base:
        for dp, dn, fn in os.walk(b):
            if "target" in dp.split(os.sep) or "node_modules" in dp.split(os.sep): continue
            for f in fn:
                if any(f.endswith(e) for e in exts): out.append(os.path.join(dp, f))
    return out

def rd(p):
    for e in ("utf-8", "gbk", "latin-1"):
        try:
            with open(p, "r", encoding=e, errors="replace") as fh: return fh.read()
        except Exception: continue
    return ""

def strip_sql_comments(s):
    s = re.sub(r"<!--.*?-->", " ", s, flags=re.S)
    s = re.sub(r"/\*.*?\*/", " ", s, flags=re.S)
    s = re.sub(r"--[^\n]*", " ", s)
    return s

SQL_KW = {"select","where","set","values","dual","on","as","and","or","not","null","if","when",
 "otherwise","foreach","trim","case","end","else","from","join","into","update","delete","insert",
 "table","using","union","all","exists","in","like","between","left","right","inner","outer","cross",
 "group","order","by","having","limit","offset","create","drop","alter","index","primary","key",
 "foreign","references","default","distinct","where1","only","nowait","wait","skip"}

TBL = re.compile(r"\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE|TABLE)\s+([`\"]?)(\w+)\1", re.I)

java = files(BACKENDS, [".java"])
xmls = files(BACKENDS, [".xml"])
mapper_xml = [x for x in xmls if re.match(r".*Mapper\.xml$", os.path.basename(x))]

file_text = {}
for p in java:
    file_text[p] = rd(p)

print(f"java={len(java)} mapperXml={len(mapper_xml)}")

# ---------- 类名 -> 文件 ----------
sym2file = {}
for p in java:
    base = os.path.basename(p)[:-5]
    if base not in sym2file: sym2file[base] = p

def role(cls, path=""):
    if "Controller" in cls: return "controller"
    if cls.endswith("Mapper") or cls.endswith("Dao"): return "mapper"
    if cls.endswith("ServiceImpl"): return "service"
    if cls.endswith("Service"): return "service"
    if cls.endswith("Listener") or cls.endswith("Handler") or cls.endswith("Event"): return "listener"
    if cls.endswith("Job") or cls.endswith("Task") or cls.endswith("Cron"): return "job"
    return "other"

# ---------- 每个文件引用的类型 ----------
def referenced(s):
    refs = set()
    for m in re.finditer(r"\b([A-Z][A-Za-z0-9_]*)\b", s):
        refs.add(m.group(1))
    return refs

file_refs = {p: referenced(s) for p, s in file_text.items()}

# ---------- Mapper XML -> 表 ----------
table2xml = collections.defaultdict(set)
table_write_xml = collections.defaultdict(set)
table_read_xml = collections.defaultdict(set)
xml2ns = {}
xml2tables = {}
for x in mapper_xml:
    s = strip_sql_comments(rd(x))
    m = re.search(r'<mapper\s+namespace="([^"]+)"', s)
    ns = m.group(1) if m else ""
    xml2ns[x] = ns
    has_wr = bool(re.search(r"<(insert|update|delete)\b", s, re.I))
    tbls = set()
    for mm in TBL.finditer(s):
        t = mm.group(2).lower()
        if t not in SQL_KW and len(t) > 3:
            tbls.add(t)
    xml2tables[x] = tbls
    for t in tbls:
        table2xml[t].add(x)
        (table_write_xml if has_wr else table_read_xml)[t].add(x)

# namespace 短类名 -> xml
ns_short2xml = {}
for x, ns in xml2ns.items():
    if ns: ns_short2xml[ns.split(".")[-1]] = x

# ---------- 注解 SQL ----------
ann_write = collections.defaultdict(set)
ann_read = collections.defaultdict(set)
for p, s in file_text.items():
    if "Mapper" not in os.path.basename(p): continue
    for m in re.finditer(r"@(Select|Update|Insert|Delete)\s*\((.*?)\)\s*(?:public\s+)?[\w<>\[\],\s]+?\s+(\w+)\s*\(", s, re.S):
        body = strip_sql_comments(m.group(2).replace("\\n", " "))
        kindn = m.group(1)
        for mm in TBL.finditer(body):
            t = mm.group(2).lower()
            if t not in SQL_KW and len(t) > 3:
                (ann_write if kindn != "Select" else ann_read)[t].add(os.path.basename(p))

# ---------- Java 内原生 SQL ----------
jdb_write = collections.defaultdict(set)
jdb_read = collections.defaultdict(set)
for p, s in file_text.items():
    if not re.search(r"JdbcTemplate|Statement|createNativeQuery|executeQuery|executeUpdate|execute\s*\(", s):
        continue
    for mm in re.finditer(r"\b(INSERT\s+INTO|UPDATE|SELECT\b[^\"']{0,400}?FROM)\s+([`\"]?)(\w+)\2", s, re.I):
        op, t = mm.group(1).upper(), mm.group(3).lower()
        if t in SQL_KW or len(t) <= 3: continue
        (jdb_write if "SELECT" not in op else jdb_read)[t].add(p)

# ---------- 数据侧 B ----------
B = set(table2xml) | set(ann_write) | set(ann_read) | set(jdb_write) | set(jdb_read)
print(f"数据侧表数 B = {len(B)}")
B_write = set(table_write_xml) | set(ann_write) | set(jdb_write)

# ---------- 接口侧: 静态调用图 ----------
# Controller/Job/Listener 文件 -> 引用的 Service 短类名 -> 引用的 Mapper 短类名 -> 表
def maps_reachable(start_files, max_depth=5):
    """从起始文件出发，沿 类型引用 BFS，收集 mapper 与表。
    关键: Service 接口 → 同时找 ServiceImpl; Mapper 接口 → xml。"""
    visited = set()
    frontier = list(start_files)
    mapper_names = set()
    for _ in range(max_depth):
        nxt = []
        for p in frontier:
            if p in visited: continue
            visited.add(p)
            refs = file_refs.get(p, set())
            for r in refs:
                # 接口 → 实现类 跳转
                impls = [r+"Impl", r+"ServiceImpl"]
                targets = []
                if r in sym2file: targets.append(sym2file[r])
                for im in impls:
                    if im in sym2file: targets.append(sym2file[im])
                # 若 r 本身是接口名去掉 Service 后缀等,尝试 *ServiceImpl
                if r.endswith("Service") and (r+"Impl") in sym2file:
                    pass
                for tf in targets:
                    if tf in visited: continue
                    rn = r if r in sym2file else os.path.basename(tf)[:-5]
                    rl = role(rn)
                    if rl == "mapper":
                        mapper_names.add(r)
                    elif rl in ("service", "listener", "job", "controller"):
                        nxt.append(tf)
        if not nxt: break
        frontier = nxt
    tables = set()
    for mn in mapper_names:
        x = ns_short2xml.get(mn)
        if x: tables |= xml2tables.get(x, set())
        for xp, ns in xml2ns.items():
            if ns.endswith("."+mn): tables |= xml2tables.get(xp, set())
        tables |= set(ann_write.get(mn, ())) | set(ann_read.get(mn, ()))
        # 注解SQL的 key 是文件名(Mapper.java basename) 即 mn+".java"? 检查
    return visited, mapper_names, tables

ctrl_files = [p for p in java if re.search(r"@RestController\b", file_text[p]) or (re.search(r"@Controller\b", file_text[p]) and "ServiceImpl" not in os.path.basename(p))]
job_files = []
for p in java:
    s = file_text[p]
    for m in re.finditer(r"([^\n]*)@Scheduled\s*\(", s):
        if not m.group(1).strip().startswith("//"):
            job_files.append(p); break
listener_files = [p for p in java if re.search(r"@EventListener|@TransactionalEventListener|implements\s+ApplicationListener", file_text[p])]
listener_files = list(dict.fromkeys(listener_files))

print(f"controller={len(ctrl_files)} scheduled={len(job_files)} listener={len(listener_files)}")

A_ctrl, m_ctrl, t_ctrl = maps_reachable(ctrl_files)
A_job, m_job, t_job = maps_reachable(job_files)
A_lst, m_lst, t_lst = maps_reachable(listener_files)

A = t_ctrl | t_job | t_lst
print(f"接口侧表数 A = {len(A)}  (ctrl={len(t_ctrl)} job={len(t_job)} listener={len(t_lst)})")

only_A = sorted(A - B)
only_B = sorted(B - A)
both = sorted(A & B)
print(f"交集 A∩B = {len(both)}")
print(f"幽灵写入点 A-B = {len(only_A)}")
for t in only_A: print("   A-B:", t)
print(f"孤儿表 B-A = {len(only_B)}")

# ---------- 反查: 表 -> 哪些入口 ----------
def owners_for(table):
    own = {"controller": [], "job": [], "listener": [], "other": []}
    xmls_t = table2xml.get(table, set())
    # 反查 mapper 短名
    mapper_shorts = set()
    for x in xmls_t:
        ns = xml2ns.get(x, "")
        if ns: mapper_shorts.add(ns.split(".")[-1])
    mapper_shorts |= set(ann_write.get(table,())) | set(ann_read.get(table,()))
    mapper_shorts |= {os.path.basename(f)[:-5] for f in jdb_write.get(table, set())}
    mapper_shorts |= {os.path.basename(f)[:-5] for f in jdb_read.get(table, set())}
    files_using = [sym2file[m] for m in mapper_shorts if m in sym2file]
    # 向上找谁引用了这些文件/类
    for f in files_using:
        ref = os.path.basename(f)[:-5]
        for p in java:
            if f == p: continue
            if ref in file_refs.get(p, set()):
                rl = role(os.path.basename(p)[:-5])
                bucket = rl if rl in own else "other"
                own[bucket].append(os.path.basename(p)[:-5])
    for k in own: own[k] = sorted(set(own[k]))
    return own

out = []
for t in sorted(B):
    o = owners_for(t)
    out.append({
        "table": t,
        "write_xml": sorted(os.path.basename(x) for x in table_write_xml.get(t, set())),
        "read_xml": sorted(os.path.basename(x) for x in table_read_xml.get(t, set())),
        "ann_write": sorted(ann_write.get(t, set())),
        "jdb": sorted(os.path.basename(x) for x in (jdb_write.get(t,set())|jdb_read.get(t,set()))),
        "owners": o,
        "in_A": t in A,
    })

with open("cross_audit.json", "w", encoding="utf-8") as fh:
    json.dump({"A": sorted(A), "B": sorted(B), "only_A": only_A, "only_B": only_B, "tables": out}, fh, ensure_ascii=False, indent=1)

# ---------- 孤儿表明细 (B-A) ----------
print("\n=== 孤儿表 / 隐藏入口 (B-A) 明细 ===")
for t in only_B:
    o = owners_for(t)
    w = sorted(os.path.basename(x) for x in table_write_xml.get(t, set()))
    print(f"\n[{t}] 写xml={w}")
    print(f"   controller={o['controller'][:6]}")
    print(f"   job={o['job'][:6]}")
    print(f"   listener={o['listener'][:6]}")
    print(f"   service={o['service'][:6] if 'service' in o else o['other'][:6]}")

# ---------- 隐藏入口扫描 ----------
print("\n=== 隐藏入口 (非 HTTP) ===")
hidden = {"scheduled": [], "listener": [], "mq": [], "quartz": []}
for p in java:
    s = file_text[p]
    cls = os.path.basename(p)[:-5]
    for m in re.finditer(r"([^\n]*)@Scheduled\s*\(", s):
        if not m.group(1).strip().startswith("//"):
            cron = re.search(r"cron\s*=\s*\"([^\"]+)\"", m.group(0))
            line = s[:m.start()].count("\n") + 1
            hidden["scheduled"].append((cls, line, cron.group(1) if cron else "", p))
            break
    if re.search(r"@EventListener|@TransactionalEventListener", s):
        hidden["listener"].append((cls, p))
    if re.search(r"extends\s+BaseMQPushConsumer|implements\s+MQListener|@RocketMQMessageListener", s):
        hidden["mq"].append((cls, p))
    if re.search(r"implements\s+Job\b|extends\s+QuartzJobBean", s):
        hidden["quartz"].append((cls, p))

for k, v in hidden.items():
    print(f"{k}: {len(v)}")
print("\nQuartz Job:")
for cls, p in hidden["quartz"]: print("  ", cls, p)
print("\nMQ 消费者:")
for cls, p in hidden["mq"]: print("  ", cls, p)

print("\nDONE")
