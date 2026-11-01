#!/usr/bin/env python3
"""Assemble Mon IPTV TV en un seul fichier HTML autonome (MonIPTVTV-autonome.html).

La version installable (PWA) est servie en https : Chrome y bloque les flux en http.
Le fichier autonome, ouvert directement depuis le téléphone, n'a pas cette restriction.
Usage : python3 tools/build-standalone.py   (depuis la racine du dépôt)
"""
import base64
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'MonIPTVTV-autonome.html'
MODULES = ['catalog', 'm3u', 'store']  # modules importés par app.js


def read(rel):
    return (ROOT / rel).read_text(encoding='utf-8')


def wrap_module(name):
    code = read(f'js/{name}.js')
    names = re.findall(r'^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)', code, re.M)
    code = re.sub(r'^export\s+', '', code, flags=re.M)
    return f"const __mod_{name} = (() => {{\n{code}\nreturn {{ {', '.join(names)} }};\n}})();\n"


def translate_imports(code):
    def named(m):
        return f"const {{ {m.group(1).strip()} }} = __mod_{m.group(2)};"

    def star(m):
        return f"const {m.group(1)} = __mod_{m.group(2)};"

    code = re.sub(r"^import\s*\{([^}]*)\}\s*from\s*'\./(\w+)\.js';", named, code, flags=re.M)
    code = re.sub(r"^import\s*\*\s*as\s+(\w+)\s+from\s*'\./(\w+)\.js';", star, code, flags=re.M)
    assert not re.search(r"^import ", code, re.M), 'import non traduit'
    return code


def must_replace(text, old, new):
    assert text.count(old) == 1, f'motif introuvable ou multiple : {old[:60]}'
    return text.replace(old, new)


def main():
    icon = 'data:image/png;base64,' + base64.b64encode((ROOT / 'icons/icon-192.png').read_bytes()).decode()

    app = translate_imports(read('js/app.js'))
    # Pas de service worker ni d'installation dans un fichier ouvert localement.
    app = must_replace(app, "'serviceWorker' in navigator && location.protocol !== 'file:'", 'false')
    js = ''.join(wrap_module(m) for m in MODULES) + app

    html = read('index.html')
    html = must_replace(html, '<link rel="stylesheet" href="css/style.css">', '<style>\n' + read('css/style.css') + '</style>')
    html = must_replace(html, '<script type="module" src="js/app.js"></script>', '')
    html = must_replace(html, '<link rel="manifest" href="manifest.webmanifest">\n', '')
    html = re.sub(r'\s*<link rel="apple-touch-icon"[^>]*>', '', html)
    html = html.replace('href="icons/icon-192.png"', f'href="{icon}"').replace('src="icons/icon-192.png"', f'src="{icon}"')
    html = must_replace(html, '<title>Mon IPTV TV</title>', '<title>Mon IPTV TV (fichier)</title>')
    html = must_replace(html, '</body>', f'<script type="module">\n{js}\n</script>\n</body>')
    OUT.write_text(html, encoding='utf-8')
    for ref in re.findall(r'(?:src|href)="((?:icons|js|css)/[^"]*)"', html):
        raise SystemExit(f'référence à un fichier externe restante : {ref}')
    print(f'{OUT.name} : {OUT.stat().st_size // 1024} Ko')


if __name__ == '__main__':
    main()
