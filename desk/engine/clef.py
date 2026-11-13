"""News Judge: Cloudflare's Clef decision model reads each candidate's own
headlines and returns probabilities, not prose. It speaks the System One API,
so TypeSafe's Jev can replace it by changing the endpoint and model.

Credentials come from the environment only (CLOUDFLARE_ACCOUNT_ID,
CLOUDFLARE_API_TOKEN). Calls go through an AI Gateway when CF_AIG_GATEWAY is set, are capped per
cycle, and are skipped cleanly when anything is missing. A failure here never
blocks the cycle: the judge is advisory.
"""
import json
import os
import urllib.request

MODEL = "@cf/cloudflare/clef-flash"
SELECTOR = "clef-flash"
GATEWAY = os.environ.get("CF_AIG_GATEWAY", "")  # optional Cloudflare AI Gateway id, for logs and caching
MAX_CALLS = 12
TIMEOUT = 20
URL = "https://api.cloudflare.com/client/v4/accounts/%s/ai/run/%s"

QUESTIONS = {
    "event_risk": {"type": "noul", "instructions": (
        "Within the next three weeks, could the events in these headlines move this stock more than 5% in one "
        "session (earnings, leadership change, legal action, deal, regulation)?")},
    "direction": {"type": "choice", "instructions": "What do these headlines mean for this stock's near-term price?",
                  "criteria": {"bullish": "Clearly positive news for the company",
                               "bearish": "Clearly negative news for the company",
                               "mixed": "Material news pulling both ways",
                               "noise": "Fund flows, listicles or other names; nothing material"}},
    "materiality": {"type": "score", "instructions": "How material is this news to the company's value?",
                    "criteria": ["Irrelevant", "Minor", "Notable", "Major"]},
}


def configured():
    return bool(os.environ.get("CLOUDFLARE_ACCOUNT_ID") and os.environ.get("CLOUDFLARE_API_TOKEN"))


def state_text(sym, items):
    lines = ["%s headlines, newest first:" % sym]
    for n in items[:8]:
        lines.append("- %s: %s. %s" % ((n.get("time") or "")[:10], n.get("title", ""), (n.get("summary") or "")[:200]))
    return "\n".join(lines)


def ask(state, opener=urllib.request.urlopen):
    """One System One call. Returns the parsed answers dict."""
    body = json.dumps({"model": SELECTOR, "state": state, "questions": QUESTIONS}).encode()
    req = urllib.request.Request(URL % (os.environ["CLOUDFLARE_ACCOUNT_ID"], MODEL), data=body, headers={
        "Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"], "Content-Type": "application/json",
        **({"cf-aig-gateway-id": GATEWAY, "cf-aig-metadata": json.dumps({"job": "geninvestor-desk-news-judge"})} if GATEWAY else {})})
    with opener(req, timeout=TIMEOUT) as r:
        payload = json.load(r)
    res = payload.get("result", payload)
    return res.get("answers", res)


def simplify(answers):
    """Keep the numbers the desk uses, whatever extra fields the API returns."""
    def num(v, *keys):
        if isinstance(v, (int, float)):
            return float(v)
        for k in keys:
            if isinstance(v, dict) and isinstance(v.get(k), (int, float)):
                return float(v[k])
        return None
    d = answers.get("direction") or {}
    return {"event_risk": num(answers.get("event_risk"), "noul", "probability", "p"),
            "direction": d.get("choice") if isinstance(d, dict) else d,
            "direction_p": d.get("probabilities") if isinstance(d, dict) else None,
            "materiality": num(answers.get("materiality"), "score", "value")}


def judge(candidates, news_items, opener=urllib.request.urlopen):
    """{symbol: verdict} for up to MAX_CALLS candidates with their own headlines,
    plus a status line for the log."""
    if not configured():
        return {}, "skipped", "Clef not configured (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN unset)"
    out, errors = {}, 0
    for sym in candidates[:MAX_CALLS]:
        mine = [n for n in news_items if n.get("ticker") == sym]
        if not mine:
            continue
        try:
            out[sym] = simplify(ask(state_text(sym, mine), opener))
        except Exception as e:  # advisory agent: record and move on
            errors += 1
            out[sym] = {"error": str(e)[:120]}
    ok = sum(1 for v in out.values() if "error" not in v)
    status = "ok" if ok and not errors else ("degraded" if errors or candidates else "skipped")
    return out, status, "Clef-flash judged %d of %d names%s" % (ok, len(candidates), ", %d errors" % errors if errors else "")
