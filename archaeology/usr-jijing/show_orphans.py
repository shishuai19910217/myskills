import sys, json, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
d = json.load(open(r'D:\owned\ai\myskills\archaeology\usr-jijing\cross_audit.json', encoding='utf-8'))
print('=== 幽灵 A-B (%d) ===' % len(d['only_A']), d['only_A'])
print('=== 孤儿表 B-A (%d) ===' % len(d['only_B']))
idx = {t['table']: t for t in d['tables']}
for t in d['only_B']:
    e = idx.get(t, {})
    print()
    print('[%s]' % t)
    print('   write_xml=%s' % e.get('write_xml'))
    print('   read_xml=%s' % e.get('read_xml'))
    print('   ann_write=%s' % e.get('ann_write'))
    print('   jdb=%s' % e.get('jdb'))
    o = e.get('owners', {})
    print('   controller=%s' % o.get('controller', [])[:5])
    print('   job=%s' % o.get('job', [])[:5])
    print('   listener=%s' % o.get('listener', [])[:5])
    print('   service=%s' % o.get('service', o.get('other', []))[:5])
