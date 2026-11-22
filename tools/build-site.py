"""Build the folder (and zip) to upload GetLow to a web server as an
installable, offline app.

    python tools/build-site.py            # without the Parts Express catalogue
    python tools/build-site.py --with-pe  # with it (prices left out: they go stale)

Writes build/getlow/ and build/getlow-site.zip. Upload the folder's contents
(or the zip, then extract it) to the place it will be served from, e.g.
/var/www/html/getlow/ for https://example.com/getlow/. It must be served over
HTTPS to install. Every build gets a version from its contents, so installed
copies offer "Update now" after you upload a changed build.
"""
import hashlib, json, os, re, shutil, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'build', 'getlow')
ZIP = os.path.join(ROOT, 'build', 'getlow-site.zip')

# what the app needs, relative to the project folder
FILES = ['index.html', 'manifest.json', 'LICENSE', 'css/style.css', 'data/catalogue.js', 'data/OPENISD-LICENSE.txt']
DIRS = [('js', '.js'), ('appicons', ''), ('art', '.webp')]  # not icons/: Apache keeps /icons/ for its own
PE = 'data/catalogue-pe.js'

HTACCESS = """# GetLow: always check for a new version of these (the offline copy handles the rest)
<IfModule mod_headers.c>
  <FilesMatch "^(sw\\.js|index\\.html|manifest\\.json)$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
</IfModule>
<IfModule mod_mime.c>
  AddType application/manifest+json .webmanifest
  AddType image/svg+xml .svg
</IfModule>
"""


def remote_scripts(html):
    return re.findall(r'<script src="(https://[^"]+)"', html)


def pe_without_prices(text):
    """The Parts Express catalogue, minus prices."""
    m = re.match(r'(?s)(.*?GL\.catalogueExtra = )(\{.*\})(;\s*)$', text)
    if not m:
        raise SystemExit('Could not read ' + PE)
    data = json.loads(m.group(2))
    for d in data.get('raw', []):
        d.pop('price', None)
    head = re.sub(r' \* (That data has no licence[^\n]*|Specs from the public product pages[^\n]*)\*/',
                  ' * Prices removed for publishing; each driver links back to its product page. */', m.group(1))
    return head + json.dumps(data, separators=(',', ':')) + m.group(3)


def main():
    with_pe = '--with-pe' in sys.argv
    files = list(FILES)
    for d, ext in DIRS:
        for name in sorted(os.listdir(os.path.join(ROOT, d))):
            if name.endswith(ext) and os.path.isfile(os.path.join(ROOT, d, name)):
                files.append(d + '/' + name)
    if with_pe:
        if not os.path.exists(os.path.join(ROOT, PE)):
            raise SystemExit(PE + ' not found: build it with tools/build-pe-extra.py first.')
        files.append(PE)
    assert with_pe or PE not in files

    # empty the folder rather than delete it (it may be open in Explorer)
    if os.path.exists(OUT):
        for name in os.listdir(OUT):
            p = os.path.join(OUT, name)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    h = hashlib.sha256()
    for f in files:
        src, dst = os.path.join(ROOT, f), os.path.join(OUT, f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if f == PE:
            with open(src, encoding='utf-8') as fh:
                text = pe_without_prices(fh.read())
            with open(dst, 'w', encoding='utf-8', newline='\n') as fh:
                fh.write(text)
            h.update(text.encode('utf-8'))
        else:
            shutil.copyfile(src, dst)
            with open(src, 'rb') as fh:
                h.update(fh.read())
    version = h.hexdigest()[:12]

    with open(os.path.join(ROOT, 'index.html'), encoding='utf-8') as fh:
        remote = remote_scripts(fh.read())
    with open(os.path.join(ROOT, 'tools', 'sw-template.js'), encoding='utf-8') as fh:
        sw = fh.read()
    cached = ['./'] + files
    sw = sw.replace('__VERSION__', version).replace('__FILES__', json.dumps(cached, indent=2)).replace('__REMOTE__', json.dumps(remote))
    with open(os.path.join(OUT, 'sw.js'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(sw)
    with open(os.path.join(OUT, '.htaccess'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(HTACCESS)

    if os.path.exists(ZIP):
        os.remove(ZIP)
    with zipfile.ZipFile(ZIP, 'w', zipfile.ZIP_DEFLATED) as z:
        for base, _, names in os.walk(OUT):
            for name in names:
                p = os.path.join(base, name)
                z.write(p, os.path.relpath(p, OUT).replace(os.sep, '/'))
    size = sum(os.path.getsize(os.path.join(b, n)) for b, _, ns in os.walk(OUT) for n in ns)
    print('GetLow ' + version + ': ' + str(len(files) + 2) + ' files, ' + str(round(size / 1024)) + ' KB' +
          (' (with the Parts Express catalogue, no prices)' if with_pe else ' (without the Parts Express catalogue)'))
    print('  folder: ' + OUT)
    print('  zip:    ' + ZIP)


if __name__ == '__main__':
    main()
