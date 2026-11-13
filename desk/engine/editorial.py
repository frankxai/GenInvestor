"""Editor: a deterministic copy check over everything the desk tells its owner
(intelligence brief, strategy, calls, debates). It applies the mechanical part
of the estate's humanizer rules; the judgment part stays with the Claude editing
pass in the trading-desk skill.
"""
import re

# Words the humanizer skill marks as tells wherever they appear (its section 12),
# plus finance hype the desk must never use about a trade.
STOCK_WORDS = ["additionally", "crucial", "delve", "enhance", "garner", "pivotal", "robust", "showcase",
               "tapestry", "testament", "underscore", "vibrant", "landscape", "meticulous", "seamless",
               "unleash", "game-changer", "guaranteed", "can't lose", "sure thing", "to the moon"]
MAX_WORDS = 38
CONTRAST = re.compile(r"\bnot (just|only|merely)\b[^.]*\bbut\b|\bit'?s not\b[^.]*,\s*it'?s\b", re.I)
DASH = re.compile(r"[–—]| -- ")


def texts(obj, path=""):
    """Every string inside the object, with where it came from."""
    if isinstance(obj, str):
        yield path, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("source", "url", "link", "lineage", "icon", "ticket"):
                continue
            yield from texts(v, "%s.%s" % (path, k) if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from texts(v, "%s[%d]" % (path, i))


def check_text(where, text):
    found = []
    if DASH.search(text):
        found.append({"where": where, "rule": "dash", "text": text[:90]})
    low = text.lower()
    for w in STOCK_WORDS:
        if re.search(r"\b%s\b" % re.escape(w), low):
            found.append({"where": where, "rule": "stock word: %s" % w, "text": text[:90]})
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if len(sentence.split()) > MAX_WORDS:
            found.append({"where": where, "rule": "sentence over %d words" % MAX_WORDS, "text": sentence[:90]})
    if CONTRAST.search(text):
        found.append({"where": where, "rule": "not-X-but-Y contrast", "text": text[:90]})
    return found


def review(**docs):
    """{'findings': [...], 'checked': n} across the named documents."""
    findings, checked = [], 0
    for name, doc in docs.items():
        if not doc:
            continue
        for where, text in texts(doc, name):
            checked += 1
            findings.extend(check_text(where, text))
    return {"findings": findings, "checked": checked}
