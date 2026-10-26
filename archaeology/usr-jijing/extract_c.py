#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阶段A 汇总: Controller 分组清单 + 定时任务精确锚点 + 表分类"""
import os, re, collections, io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = r"D:\youren\jiejuefangan\code\usr-jijing"
os.chdir(ROOT)
def files(base, exts):
    if isinstance(base, str): base=[base]
    out=[]
    for b in base:
        for dp,dn,fn in os.walk(b):
            if "target" in dp.split(os.sep) or "node_modules" in dp.split(os.sep): continue
            for f in fn:
                if any(f.endswith(e) for e in exts): out.append(os.path.join(dp,f))
    return out
def rd(p):
    for e in ("utf-8","gbk","latin-1"):
        try:
            with open(p,"r",encoding=e,errors="replace") as fh: return fh.read()
        except Exception: continue
    return ""

java = files(["usr-demeter-all","usr-demeter-old-framework-back-service","usr-demeter-old-framework-back-web"],[".java"])

# ---- Controller 清单: 类, 文件, base path, 方法数 ----
ctrls=[]
for p in java:
    s=rd(p)
    if not (re.search(r"@RestController\b",s) or (re.search(r"@Controller\b",s) and "ServiceImpl" not in p)): continue
    cls=os.path.basename(p)[:-5]
    cm=re.search(r'@RequestMapping\s*\(\s*(?:value\s*=\s*)?["\']([^"\']+)["\']',s)
    base=cm.group(1) if cm else ""
    methods=[]
    for m in re.finditer(r'@(Get|Post|Put|Delete|Patch)Mapping\s*\(([^)]*)\)',s):
        pm=re.search(r'["\']([^"\']+)["\']',m.group(2))
        methods.append((m.group(1).upper(), pm.group(1) if pm else ""))
    # 归属
    parts=p.replace("\\","/").split("/")
    if "usr-demeter-old-framework-back-web" in parts:
        i=parts.index("usr-demeter-old-framework-back-web"); grp="old-web/"+parts[i+1]
    elif "usr-demeter-all" in parts:
        # 取 poseidon-service-xxx
        seg=[x for x in parts if x.startswith("poseidon-")]
        grp="new/"+(seg[0] if seg else "?")
    else: grp="?"
    ctrls.append((grp,cls,base,len(methods),p))

grp_count=collections.Counter(c[0] for c in ctrls)
print("=== Controller 按组 ===")
for g,n in sorted(grp_count.items()): print(f"{n:4}  {g}")
print(f"合计 {len(ctrls)}")

# ---- 活跃 @Scheduled ----
print("\n=== 活跃 @Scheduled (排除注释) ===")
for p in java:
    s=rd(p)
    for m in re.finditer(r"([^\n]*)@Scheduled\s*\(([^)]*)\)",s):
        if m.group(1).strip().startswith("//"): continue
        line=s[:m.start()].count("\n")+1
        cls=os.path.basename(p)[:-5]
        cron=re.search(r'cron\s*=\s*"([^"]+)"',m.group(2))
        fd=re.search(r"fixedDelay\s*=\s*(\d+)",m.group(2))
        fr=re.search(r"fixedRate\s*=\s*(\d+)",m.group(2))
        expr=cron.group(1) if cron else (f"fixedDelay={fd.group(1)}" if fd else (f"fixedRate={fr.group(1)}" if fr else "?"))
        print(f"line {line:4}  {expr:25}  {cls}")

# ---- Quartz Job 分组 ----
print("\n=== Quartz Job 类 (93) 按目录分组 ===")
qj=collections.Counter()
qjfiles=[]
for p in java:
    s=rd(p)
    if re.search(r"implements\s+(?:org\.quartz\.)?Job\b|extends\s+QuartzJobBean",s):
        parts=p.replace("\\","/").split("/")
        try:
            i=parts.index("job"); g="/".join(parts[i+1:-1])
        except ValueError: g="?"
        qj[g]+=1
        qjfiles.append((os.path.basename(p)[:-5],p))
for g,n in sorted(qj.items(), key=lambda x:-x[1]): print(f"{n:3}  {g}")

# ---- 写 Controller 全量清单到文件 ----
with open(r"D:\owned\ai\myskills\archaeology\usr-jijing\controllers_full.txt","w",encoding="utf-8") as fh:
    for g,cls,base,nm,p in sorted(ctrls):
        rel=p.replace(ROOT+os.sep,"")
        fh.write(f"{g}\t{cls}\t{base}\t{nm}\t{rel}\n")
with open(r"D:\owned\ai\myskills\archaeology\usr-jijing\quartz_jobs_full.txt","w",encoding="utf-8") as fh:
    for c,p in sorted(qjfiles):
        fh.write(f"{c}\t{p.replace(ROOT+os.sep,'')}\n")
print("\nfull lists written")
