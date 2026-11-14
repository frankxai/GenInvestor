"""Freeze the desk into one self-contained HTML file (CSS, JS and data inlined).

    python desk/snapshot.py OUT.html [--data desk/state/desk.json]

The output holds real market data from a live cycle, so it goes to a private
place (a scratch folder or a private artifact), never into web/ or the public site.
"""
import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = "https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700;800&family=Spline+Sans+Mono:wght@400;500;600&display=swap"
CHARTS = "https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"


def build(data_path):
    read = lambda name: open(os.path.join(HERE, name), encoding="utf-8").read()
    data = json.load(open(data_path, encoding="utf-8"))
    payload = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")
    return "\n".join([
        "<title>GenInvestor desk</title>",
        '<meta name="claude:viewport-fit-sides" content="cover">',
        '<link rel="stylesheet" href="%s">' % FONTS,
        "<style>%s</style>" % read("desk.css"),
        '<div class="field" aria-hidden="true"><i></i><i></i><i></i></div>',
        '<main id="app" class="wrap" aria-live="polite"></main>',
        '<script src="%s"></script>' % CHARTS,
        "<script>window.DESK_DATA=%s;</script>" % payload,
        "<script>%s</script>" % read("desk.js"),
    ])


def standalone(body):
    """A complete document for static hosting (the artifact host adds its own wrapper)."""
    return ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            '<meta name="robots" content="noindex">\n</head>\n<body>\n%s\n</body>\n</html>\n' % body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--data", default=os.path.join(HERE, "state", "desk.json"))
    ap.add_argument("--standalone", action="store_true", help="full HTML document for Cloudflare or Vercel static hosting")
    a = ap.parse_args()
    page = build(a.data)
    live = not json.load(open(a.data, encoding="utf-8"))["meta"].get("synthetic")
    repo = os.path.dirname(HERE)
    out = os.path.abspath(a.out)
    if live and out.startswith(repo + os.sep) and not out.startswith(os.path.join(HERE, "state") + os.sep):
        raise SystemExit("refusing: live data may only be written outside the repo or under desk/state")
    if a.standalone:
        if not json.load(open(a.data, encoding="utf-8"))["meta"].get("synthetic"):
            raise SystemExit("refusing: a public build must use synthetic data (desk/sample/desk.json)")
        page = standalone(page)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(page)
    print("snapshot -> %s" % a.out)


if __name__ == "__main__":
    main()
