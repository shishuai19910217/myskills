import sys, json, io, re, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
p = r'D:\owned\ai\myskills\archaeology\usr-jijing'
ca = json.load(open(p + r'\cross_audit.json', encoding='utf-8'))

# 业务域规则（按表名前缀/包含）
RULES = [
    ("账号权限", r"^t_user$|^t_role$|^t_pomission$|^t_role_|^t_role_mode$|^t_user_role$|role_menu|menu_auth|_menu$|_menus$"),
    ("代理",    r"^t_iot_agent|^t_agent_"),
    ("商户",    r"^t_merchant_|^t_iot_merchant_(?!equipment_recharge|mall_banner|notice)"),
    ("农户账户", r"^t_iot_consumer"),
    ("设备资产", r"^t_iot_merchant_equipment|^t_iot_equipment|^t_iot_equip_|^t_iot_equip$|^t_iot_merchant_equip_type|^t_iot_merchant_base_equip_type|^t_iot_equip_type|^t_iot_brand$|^t_iot_cooperative_factory|^t_iot_hardware_version|^t_iot_icon$|^t_iot_lora|^t_iot_equip_lora|^t_iot_source_"),
    ("库存出入", r"stock|^t_iot_equip_stock|stockin|stockout"),
    ("SIM卡",   r"sim_card|^t_iot_sim|iccid|imei_sim"),
    ("农场灌溉", r"^t_iot_farm|^t_iot_fertigation|^t_iot_merchant_place|^t_iot_place|waterfert|irrigation"),
    ("计费支付", r"charge_bill|^t_iot_bill|^t_iot_pay|^t_iot_alipay|^t_iot_wx_|^t_iot_wx$|^t_iot_hf_|^t_iot_trans_order|^t_iot_transfer|recharge|^t_iot_b2b|^t_iot_pay_"),
    ("统计报表", r"^t_iot_rpt"),
    ("OTA升级",  r"^t_ota_"),
    ("物联网接入", r"^t_iot_.*(auth|bind|status|gateway|sim|mqtt|lora|device|cctv|signal)"),
    ("通知公告", r"notice|message|feedback|announce"),
    ("监控传感", r"monitor|^t_equip_monitor|worm|cctv|hardware_version"),
    ("定时框架", r"^qrtz_"),
    ("系统基础", r"region|sequence|industry|industr|^t_api$|^t_test|test|information_schema"),
]

buckets = collections.defaultdict(list)
unmatched = []
for t in sorted(ca['B']):
    hit = None
    for name, pat in RULES:
        if re.search(pat, t, re.I):
            hit = name; break
    if hit: buckets[hit].append(t)
    else: unmatched.append(t)

print("=== 业务域 -> 表 数量 ===")
for k, v in sorted(buckets.items(), key=lambda x: -len(x[1])):
    print(f"{len(v):4}  {k}")
print(f"{len(unmatched):4}  未归类")
print()
for k, v in sorted(buckets.items(), key=lambda x: -len(x[1])):
    print(f"\n## {k} ({len(v)})")
    for t in v:
        mark = "A" if t in ca['A'] else "-"
        print(f"  [{mark}] {t}")
if unmatched:
    print(f"\n## 未归类 ({len(unmatched)})")
    for t in unmatched: print(f"  [{'A' if t in ca['A'] else '-'}] {t}")
