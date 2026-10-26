#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""表 -> 模块归属; 事件监听/隐藏机制汇总"""
import os, re, collections, io, sys, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = r"D:\youren\jiejuefangan\code\usr-jijing"
os.chdir(ROOT)
def files(base, exts):
    if isinstance(base,str): base=[base]
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
def strip_c(s):
    s=re.sub(r"<!--.*?-->"," ",s,flags=re.S); s=re.sub(r"/\*.*?\*/"," ",s,flags=re.S)
    return re.sub(r"--[^\n]*"," ",s)
SQL_KW={"select","where","set","values","dual","on","as","and","or","not","null","if","when","otherwise",
 "foreach","trim","case","end","else","from","join","into","update","delete","insert","table","using",
 "union","all","exists","in","like","between","left","right","inner","outer","cross","group","order",
 "by","having","limit","offset","create","drop","alter","index","primary","key","foreign","references",
 "default","distinct","information_schema","test"}
TBL=re.compile(r"\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE|TABLE)\s+([`\"]?)(\w+)\1",re.I)

def mod_of(rel):
    p=rel.replace("\\","/").split("/")
    if "usr-demeter-old-framework-back-web" in p:
        i=p.index("usr-demeter-old-framework-back-web"); return "old-web/"+p[i+1]
    if "usr-demeter-old-framework-back-service" in p:
        i=p.index("usr-demeter-old-framework-back-service"); return "old-svc/"+p[i+1]
    if "usr-demeter-all" in p:
        seg=[x for x in p if x.startswith("poseidon-")]
        return "new/"+(seg[0] if seg else "?")
    return "?"

table_mod=collections.defaultdict(lambda: collections.Counter())
xmls=files(["usr-demeter-all","usr-demeter-old-framework-back-service","usr-demeter-old-framework-back-web"],[".xml"])
mxml=[x for x in xmls if re.match(r".*Mapper\.xml$",os.path.basename(x))]
for x in mxml:
    s=strip_c(rd(x))
    for m in TBL.finditer(s):
        t=m.group(2).lower()
        if t in SQL_KW or len(t)<=3: continue
        table_mod[t][mod_of(x)]+=1

print("=== 表 -> 模块 (归属取最多的模块) ===")
tbl_main={}
for t,c in sorted(table_mod.items()):
    tbl_main[t]=c.most_common(1)[0][0]
mm=collections.Counter(tbl_main.values())
for k,n in sorted(mm.items()): print(f"{n:4}  {k}")

# ---- 隐藏机制汇总 ----
java=files(["usr-demeter-all","usr-demeter-old-framework-back-service","usr-demeter-old-framework-back-web"],[".java"])
print("\n=== 隐藏机制计数 ===")
cnt=collections.Counter()
files_hit=collections.defaultdict(set)
for p in java:
    s=rd(p)
    for key,pat in [
        ("@EventListener", r"@EventListener|@TransactionalEventListener"),
        ("@Aspect", r"@Aspect\b"),
        ("@Around", r"@Around\s*\("),
        ("Filter实现", r"implements\s+(?:javax\.servlet\.|jakarta\.servlet\.)?Filter\b|@WebFilter"),
        ("HandlerInterceptor", r"implements\s+HandlerInterceptor|addInterceptors\s*\("),
        ("@Transactional", r"@Transactional\b"),
        ("@Async", r"@Async\b"),
        ("@Retryable", r"@Retryable|RetryTemplate"),
        ("Redis/缓存", r"RedisTemplate|StringRedisTemplate|jedis|JedisPool|@Cacheable"),
        ("反射", r"Class\.forName|Method\.invoke|getDeclaredMethod"),
        ("ControllerAdvice", r"@ControllerAdvice|@RestControllerAdvice"),
        ("Hessian/Feign", r"@HessianService|@FeignClient|FeignClientRegisterConfig"),
        ("全局日志切面注解", r"@com\.dongjun\.iot\.service\.core\.annotation\.logger\.Log|annotation\.logger\.Log\b"),
    ]:
        if re.search(pat,s):
            cnt[key]+=1; files_hit[key].add(p)
for k,n in cnt.most_common(): print(f"{n:4}  {k}  (涉及 {len(files_hit[k])} 文件)")

# ---- @Log 注解使用量(老框架日志切面) ----
logcnt=0
for p in java:
    s=rd(p)
    logcnt+=len(re.findall(r"@Log\b",s))
print(f"\n@Log 注解使用点(老框架 LogAspect 切面): {logcnt}")

# ---- MQ 主题 ----
print("\n=== RocketMQ Topic/SendTo 定义 ===")
topics=set()
for p in java:
    s=rd(p)
    for m in re.finditer(r'TOPIC[A-Z_]*\s*=\s*"([^"]+)"|topic\s*=\s*"([^"]+)"|sendTo\w*\s*\(\s*"([^"]+)"',s):
        v=m.group(1) or m.group(2) or m.group(3)
        if v and len(v)>2: topics.add(v)
print(f"Topic 常量: {len(topics)}")
for t in sorted(topics)[:60]: print("  ",t)

# ---- 表清单输出 ----
with open(r"D:\owned\ai\myskills\archaeology\usr-jijing\table_modules.json","w",encoding="utf-8") as fh:
    json.dump({"tbl_main":tbl_main,
               "tbl_all_mods":{t:dict(c) for t,c in table_mod.items()}}, fh, ensure_ascii=False, indent=1)
print("\nwritten table_modules.json")
