import io, sys, collections, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
rows = [l.rstrip('\n').split('\t') for l in open(r'D:\owned\ai\myskills\archaeology\usr-jijing\controllers_full.txt', encoding='utf-8')]
c = collections.Counter()
for r in rows:
    g, path = r[0], r[4]
    m = re.search(r'poseidon-service-([a-z0-9]+)', path)
    if g == 'new/poseidon-service' and m:
        c['new/svc-'+m.group(1)] += 1
    elif g == 'new/poseidon-network':
        m2 = re.search(r'poseidon-network-([a-z0-9-]+?)[\\/]', path)
        c['new/net-'+(m2.group(1) if m2 else '?')] += 1
    else:
        c[g] += 1
for k, n in sorted(c.items(), key=lambda x: -x[1]):
    print(f'{n:4}  {k}')
