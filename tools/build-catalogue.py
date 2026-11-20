"""Build GetLow's driver catalogue from an OpenISD checkout.

OpenISD (https://github.com/Johnlon/openisd, MIT licence) ships a bundled
catalogue of driver and passive-radiator records in packages/ui/public. This
script reads those records and writes data/catalogue.js, a compact file that
GetLow loads on demand (it works from file:// too, unlike fetch()).

    python tools/build-catalogue.py PATH/TO/openisd

Re-run it after pulling a newer OpenISD to refresh the catalogue.
"""
import json, os, re, sys, glob, datetime, shutil

if len(sys.argv) < 2:
    sys.exit(__doc__)
SRC = os.path.abspath(sys.argv[1])
PUB = os.path.join(SRC, 'packages', 'ui', 'public')
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, 'data', 'catalogue.js')


def val(rec, key):
    x = rec.get(key)
    return x.get('value') if isinstance(x, dict) else x


def num(sec, key):
    x = sec.get(key)
    if isinstance(x, dict) and isinstance(x.get('value'), (int, float)) and x.get('state') in ('E', 'C'):
        return x['value']
    return None


def rnd(v, sig=5):
    if v is None:
        return None
    return float('%.*g' % (sig, v))


def index_by_path(name):
    p = os.path.join(PUB, name)
    if not os.path.exists(p):
        return {}
    return {e['path']: e for e in json.load(open(p, encoding='utf-8'))}


woofer_idx = index_by_path('drivers-index.json')
pr_idx = index_by_path('passive-radiators-index.json')

# GetLow param key <- OpenISD field (SI units on both sides)
MAP = {
    'fs': 'Fs_hz', 'qes': 'Qes', 'qms': 'Qms', 'qts': 'Qts', 'vas': 'Vas_m3', 'sd': 'Sd_m2', 're': 'Re_ohm',
    'le': 'Le_H', 'xmax': 'Xmax_m', 'pe': 'Pe_W', 'znom': 'Znom_ohm', 'BL': 'BL_Tm', 'Mms': 'Mms_kg',
    'Cms': 'Cms_m_per_N', 'Rms': 'Rms_kg_per_s', 'dia': 'Outer_m', 'depth': 'Depth_m', 'dvol': 'DVol_m3',
}

drivers, prs = [], []
for f in sorted(glob.glob(os.path.join(PUB, 'drivers', '**', '*.json'), recursive=True)):
    rec = json.load(open(f, encoding='utf-8'))
    path = os.path.relpath(f, os.path.join(PUB, 'drivers')).replace('\\', '/')[:-5]
    specs = rec.get('specs', {})
    brand = val(rec, 'brand') or val(rec, 'manufacturer') or ''
    model = val(rec, 'model') or ''
    desc = val(rec, 'description') or ''
    # some records carry the whole product title as the model: keep the part number
    if len(model) > 24:
        if not desc:
            desc = brand + ' ' + model
        tok = model.split()[0]
        if re.search(r'\d', tok):
            model = tok
    src = val(rec, 'data_sources') or {}
    common = {
        'id': path, 'brand': brand, 'model': model,
        'page': src.get('manufacturer_product_page') or src.get('retailer_product_page'),
        'sheet': src.get('manufacturer_datasheet'),
    }
    if 'woofer' in specs:
        w = specs['woofer']
        p = {k: rnd(num(w, src_key)) for k, src_key in MAP.items()}
        p = {k: v for k, v in p.items() if v is not None}
        if not all(k in p for k in ('fs', 'vas', 'sd', 're')) or not (('qes' in p and 'qms' in p) or 'qts' in p):
            continue                     # not enough to simulate
        idx = woofer_idx.get(path, {})
        d = dict(common, desc=desc, p=p, types=idx.get('chips') or val(rec, 'driver_type') or [],
                 size=idx.get('sizeFromSd_in'), disc=bool(idx.get('discontinued')), dq=bool(idx.get('dq')))
        # dual voice coil: OpenISD's numVC / VCCon, else the description ("Dual 4 Ohm")
        nvc = num(w, 'numVC')
        con = (w.get('VCCon') or {}).get('value')
        # model and a short title only: long marketing text mentions other ranges ("DVC Series")
        text = model + ' ' + (desc if len(desc) <= 160 else '')
        m = re.search(r'\bdvc\b(?!\s+series)|dual voice coil|\b2\s*x\s*\d+(?:\.\d+)?\s*ohm|-d\d|-dv\b|dual\s*\d+(?:\.\d+)?\s*(?:ohm|Ω)', text, re.I)
        pc = re.search(r'dual\s*(\d+(?:\.\d+)?)\s*(?:ohms?|Ω)|(\d+(?:\.\d+)?)\s*(?:ohms?|Ω)\s*per\s*coil|\b2\s*x\s*(\d+(?:\.\d+)?)\s*(?:ohms?|Ω)|-d(\d+(?:\.\d+)?)\b',
                       model + ' ' + desc[:400], re.I)
        # Dayton DVC part numbers end in the per-coil impedance twice: MX12-22, SD215A-88
        dm = re.search(r'-(\d)\1$', model) if brand.lower().startswith('dayton') else None
        if (nvc and nvc >= 2) or m:
            pub = con if con in ('series', 'parallel') else None
            per = float(next(g for g in pc.groups() if g)) if pc else (float(dm.group(1)) if dm else None)
            if not pub and per and p.get('re'):
                r = p['re'] / per
                pub = 'series' if r > 1.4 else 'single' if r > 0.7 else 'parallel'
            d['vc'] = {'coils': 2, 'published': pub or 'series', 'perCoil': per}
        drivers.append({k: v for k, v in d.items() if v not in (None, '', [], False)})
    elif 'passive-radiator' in specs:
        w = specs['passive-radiator']
        p = {k: rnd(num(w, s)) for k, s in
             {'fs': 'Fs_hz', 'qms': 'Qms', 'vas': 'Vas_m3', 'sd': 'Sd_m2', 'xmax': 'Xmax_m', 'Mms': 'Mms_kg',
              'Cms': 'Cms_m_per_N', 'dia': 'Outer_m'}.items()}
        p = {k: v for k, v in p.items() if v is not None}
        if 'sd' not in p or not ('fs' in p or ('Mms' in p and 'Cms' in p)):
            continue
        idx = pr_idx.get(path, {})
        prs.append({k: v for k, v in dict(common, p=p, disc=bool(idx.get('discontinued'))).items() if v not in (None, '', [], False)})

# provenance for the about line
rev = ''
head = os.path.join(SRC, '.git', 'HEAD')
try:
    ref = open(head).read().strip()
    rev = open(os.path.join(SRC, '.git', ref[5:])).read().strip()[:10] if ref.startswith('ref:') else ref[:10]
except OSError:
    pass

cat = {
    'source': 'OpenISD driver catalogue (github.com/Johnlon/openisd, MIT licence)' + (' @ ' + rev if rev else ''),
    'built': datetime.date.today().isoformat(),
    'drivers': drivers, 'prs': prs,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as fh:
    fh.write('/* Generated by tools/build-catalogue.py from the OpenISD catalogue. Do not edit.\n'
             ' * Data: OpenISD contributors, MIT licence (see data/OPENISD-LICENSE.txt). */\n')
    fh.write('window.GL = window.GL || {}; GL.catalogue = ')
    json.dump(cat, fh, ensure_ascii=False, separators=(',', ':'))
    fh.write(';\n')
shutil.copyfile(os.path.join(SRC, 'LICENSE'), os.path.join(HERE, 'data', 'OPENISD-LICENSE.txt'))
print('drivers %d, passive radiators %d, %d KB -> %s' % (len(drivers), len(prs), os.path.getsize(OUT) // 1024, OUT))
