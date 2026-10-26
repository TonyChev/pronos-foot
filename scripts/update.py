#!/usr/bin/env python3
"""Collecte des données pour l'app Pronos Foot.

- Matchs, résultats et minutes des buts : FotMob (API publique non officielle)
- Cotes Unibet (BTTS + plus de 2,5 buts) : Kambi, la plateforme de paris d'Unibet

Le script est lancé par une GitHub Action. Il produit :
- data/matches.json : matchs à venir + stats des équipes + cotes + résultats récents
- data/cache.json   : minutes des buts des matchs terminés (évite de tout re-télécharger)

Uniquement la bibliothèque standard Python : aucune dépendance à installer.
"""
import gzip
import json
import re
import sys
import time
import unicodedata
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE_FILE = DATA / "cache.json"
OUT_FILE = DATA / "matches.json"

# Compétitions suivies. Pour en ajouter une : trouver son id FotMob
# (dans l'URL fotmob.com/leagues/<id>/...) et son nom chez Unibet/Kambi.
# kambi = (pays Kambi ou None pour les coupes internationales, regex du nom de la compétition)
COMPETITIONS = [
    {"id": 53, "name": "Ligue 1", "country": "France", "flag": "🇫🇷", "kambi": ("france", r"^Ligue 1$")},
    {"id": 47, "name": "Premier League", "country": "Angleterre", "flag": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "kambi": ("england", r"^Premier League$")},
    {"id": 87, "name": "LaLiga", "country": "Espagne", "flag": "🇪🇸", "kambi": ("spain", r"^La Liga$")},
    {"id": 54, "name": "Bundesliga", "country": "Allemagne", "flag": "🇩🇪", "kambi": ("germany", r"^Bundesliga$")},
    {"id": 55, "name": "Serie A", "country": "Italie", "flag": "🇮🇹", "kambi": ("italy", r"^Serie A$")},
    {"id": 38, "name": "Bundesliga", "country": "Autriche", "flag": "🇦🇹", "kambi": ("austria", r"^Bundesliga$")},
    {"id": 40, "name": "Pro League", "country": "Belgique", "flag": "🇧🇪", "kambi": ("belgium", r"Pro League")},
    {"id": 46, "name": "Superliga", "country": "Danemark", "flag": "🇩🇰", "kambi": ("denmark", r"^Superligaen$|^Superliga$")},
    {"id": 64, "name": "Premiership", "country": "Écosse", "flag": "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "kambi": ("scotland", r"Premiership")},
    {"id": 130, "name": "MLS", "country": "États-Unis", "flag": "🇺🇸", "kambi": ("usa", r"^MLS$")},
    {"id": 51, "name": "Veikkausliiga", "country": "Finlande", "flag": "🇫🇮", "kambi": ("finland", r"^Veikkausliiga$")},
    {"id": 215, "name": "Besta deild karla", "country": "Islande", "flag": "🇮🇸", "kambi": ("iceland", r"Besta|rvalsdeild")},
    {"id": 223, "name": "J1 League", "country": "Japon", "flag": "🇯🇵", "kambi": ("japan", r"^J1")},
    {"id": 59, "name": "Eliteserien", "country": "Norvège", "flag": "🇳🇴", "kambi": ("norway", r"^Eliteserien$")},
    {"id": 57, "name": "Eredivisie", "country": "Pays-Bas", "flag": "🇳🇱", "kambi": ("netherlands", r"^Eredivisie$")},
    {"id": 61, "name": "Liga Portugal", "country": "Portugal", "flag": "🇵🇹", "kambi": ("portugal", r"^Primeira Liga$|^Liga Portugal")},
    {"id": 67, "name": "Allsvenskan", "country": "Suède", "flag": "🇸🇪", "kambi": ("sweden", r"^Allsvenskan$")},
    {"id": 69, "name": "Super League", "country": "Suisse", "flag": "🇨🇭", "kambi": ("switzerland", r"^Super League$")},
    {"id": 42, "name": "Ligue des champions", "country": "Europe", "flag": "🇪🇺", "kambi": (None, r"^Champions League$")},
    {"id": 73, "name": "Ligue Europa", "country": "Europe", "flag": "🇪🇺", "kambi": (None, r"^Europa League$")},
    {"id": 10216, "name": "Ligue Conférence", "country": "Europe", "flag": "🇪🇺", "kambi": (None, r"^Conference League$")},
]

FOTMOB = "https://www.fotmob.com/api/data"
KAMBI = "https://eu-offering-api.kambicdn.com/offering/v2018/ub"
KAMBI_PARAMS = "lang=fr_FR&market=FR"
FOOTBALL_GROUP = 1000093190

# Fenêtre des matchs à venir publiés (l'app n'affiche qu'aujourd'hui et demain,
# heure locale, mais on garde une marge pour les décalages horaires).
WINDOW_BEFORE = timedelta(hours=30)
WINDOW_AFTER = timedelta(days=3)
RESULTS_DAYS = 60


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get_json(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (pronos-foot)",
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
            })
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return json.loads(body)
        except Exception as e:  # noqa: BLE001
            if attempt == retries - 1:
                log(f"  échec {url}: {e}")
                return None
            time.sleep(2 * (attempt + 1))


def parse_utc(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---------------------------------------------------------------- FotMob

def bucket(minute):
    """Créneau de 15 min façon Sofascore : 0-15, 15-30, 30-45(+), 45-60, 60-75, 75-90(+)."""
    return min(5, max(0, (minute - 1) // 15))


def fetch_goals(match_id):
    """Buts du temps réglementaire : liste de [minute, 1 si domicile sinon 0]."""
    d = get_json(f"{FOTMOB}/matchDetails?matchId={match_id}")
    if not d:
        return None
    try:
        events = d["content"]["matchFacts"]["events"]["events"] or []
    except (KeyError, TypeError):
        return None
    goals = []
    for e in events:
        if e.get("type") != "Goal" or e.get("isPenaltyShootoutEvent"):
            continue
        minute = e.get("time") or 0
        # Prolongations (91' à 120') exclues : les paris BTTS / +2,5 se règlent sur 90 min.
        if minute > 90:
            continue
        goals.append([minute, 1 if e.get("isHome") else 0])
    return goals


def collect_fotmob(now):
    cache = {}
    if CACHE_FILE.exists():
        cache = json.loads(CACHE_FILE.read_text())
    old_matches = cache.get("matches", {})

    teams = {}       # id -> nom
    finished = {}    # match id -> infos (sans les buts)
    upcoming = []

    for comp in COMPETITIONS:
        d = get_json(f"{FOTMOB}/leagues?id={comp['id']}")
        if not d:
            log(f"[{comp['name']}] indisponible")
            continue
        comp["season"] = d.get("details", {}).get("selectedSeason")
        matches = (d.get("fixtures") or {}).get("allMatches") or []
        nb_up = 0
        for m in matches:
            st = m.get("status") or {}
            if st.get("cancelled") or st.get("awarded") or not st.get("utcTime"):
                continue
            h, a = m["home"], m["away"]
            teams[h["id"]] = h["name"]
            teams[a["id"]] = a["name"]
            ko = parse_utc(st["utcTime"])
            if st.get("finished"):
                finished[m["id"]] = {"c": comp["id"], "t": st["utcTime"], "h": h["id"], "a": a["id"],
                                     "s": st.get("scoreStr")}
            if now - WINDOW_BEFORE <= ko <= now + WINDOW_AFTER:
                # Matchs du jour déjà joués inclus aussi, pour afficher leur score
                nb_up += 1
                upcoming.append({
                    "id": m["id"], "c": comp["id"], "t": st["utcTime"],
                    "h": h["id"], "a": a["id"],
                    "started": bool(st.get("started")),
                    "finished": bool(st.get("finished")),
                    "live": (st.get("liveTime") or {}).get("short"),
                    "score": st.get("scoreStr") if st.get("started") else None,
                })
        log(f"[{comp['country']} - {comp['name']}] {comp['season']} : "
            f"{sum(1 for f in finished.values() if f['c'] == comp['id'])} terminés, {nb_up} à venir")

    # Détails des buts : seulement pour les matchs terminés pas encore en cache
    todo = [mid for mid in finished if mid not in old_matches]
    log(f"Détails à télécharger : {len(todo)} matchs")
    fetched = {}

    def work(mid):
        return mid, fetch_goals(mid)

    with ThreadPoolExecutor(max_workers=6) as ex:
        for i, (mid, goals) in enumerate(ex.map(work, todo), 1):
            if goals is not None:
                fetched[mid] = goals
            if i % 200 == 0:
                log(f"  {i}/{len(todo)}")

    # Cache = uniquement les matchs des saisons en cours (les anciennes disparaissent d'elles-mêmes)
    new_cache = {}
    for mid, f in finished.items():
        goals = fetched.get(mid, old_matches.get(mid, {}).get("g"))
        if goals is None:
            continue
        new_cache[mid] = {**{k: f[k] for k in ("c", "t", "h", "a")}, "g": goals}
    return teams, new_cache, upcoming, finished


def empty_stats():
    return {"n": 0, "gf": 0, "ga": 0, "sf": [0] * 6, "sa": [0] * 6, "btts": 0, "o25": 0}


def team_stats(cache, team_ids):
    stats = {tid: {"all": empty_stats(), "home": empty_stats(), "away": empty_stats()} for tid in team_ids}
    for m in cache.values():
        hg = sum(1 for _, home in m["g"] if home)
        ag = len(m["g"]) - hg
        for side, tid in (("home", m["h"]), ("away", m["a"])):
            if tid not in stats:
                continue
            for key in ("all", side):
                s = stats[tid][key]
                s["n"] += 1
                s["btts"] += hg > 0 and ag > 0
                s["o25"] += hg + ag >= 3
                for minute, is_home in m["g"]:
                    scored = bool(is_home) == (side == "home")
                    b = bucket(minute)
                    if scored:
                        s["gf"] += 1
                        s["sf"][b] += 1
                    else:
                        s["ga"] += 1
                        s["sa"][b] += 1
    return stats


# ---------------------------------------------------------------- Kambi (Unibet)

def find_kambi_groups():
    tree = get_json(f"{KAMBI}/group/{FOOTBALL_GROUP}.json?{KAMBI_PARAMS}&depth=3")
    if not tree:
        return {}
    top = tree["group"].get("groups", [])
    found = {}
    for comp in COMPETITIONS:
        country, pattern = comp["kambi"]
        rx = re.compile(pattern, re.I)
        pool = top
        if country:
            parent = next((g for g in top if g.get("termKey") == country), None)
            pool = parent.get("groups", []) if parent else []
        for g in pool:
            if rx.search(g.get("englishName", "")) and "(W)" not in g.get("englishName", ""):
                found[comp["id"]] = "/".join(filter(None, [country, g["termKey"]]))
                break
    return found


STOPWORDS = {"fc", "cf", "ac", "as", "sc", "afc", "club", "de", "the", "sv", "fk", "if", "bk", "ik", "ff",
             "cd", "ud", "rc", "ssc", "us", "vfb", "vfl", "tsg", "1", "sk", "kv", "krc", "rsc", "real", "sporting",
             "calcio", "olympique", "stade", "united", "city"}
ALIASES = {"psg": "paris saint germain", "man utd": "manchester united", "man city": "manchester city",
           "wolves": "wolverhampton", "spurs": "tottenham", "inter": "internazionale", "gladbach": "monchengladbach",
           "fc kobenhavn": "copenhagen", "fc copenhagen": "copenhagen", "fc copenhague": "copenhagen",
           "ob": "odense", "hearts": "heart of midlothian"}


def norm(name):
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    n = ALIASES.get(n.strip(), n)
    return " ".join(t for t in n.split() if t not in STOPWORDS) or n.strip()


def similarity(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0
    if a == b or a in b or b in a:
        return 1.0
    ta, tb = set(a.split()), set(b.split())
    overlap = len(ta & tb) / min(len(ta), len(tb))
    return max(SequenceMatcher(None, a, b).ratio(), overlap)


def extract_odds(offers):
    odds = {}
    for b in offers:
        label = (b.get("criterion") or {}).get("englishLabel", "")
        if label == "Both Teams To Score":
            for o in b.get("outcomes", []):
                if o.get("englishLabel") == "Yes" and o.get("odds") and o.get("status", "OPEN") == "OPEN":
                    odds["btts"] = o["odds"] / 1000
        elif label == "Total Goals":
            for o in b.get("outcomes", []):
                if o.get("englishLabel") == "Over" and o.get("line") == 2500 and o.get("odds") \
                        and o.get("status", "OPEN") == "OPEN":
                    odds["o25"] = o["odds"] / 1000
    return odds


def attach_odds(upcoming, teams, now):
    groups = find_kambi_groups()
    log(f"Kambi : {len(groups)}/{len(COMPETITIONS)} compétitions trouvées")
    matched = 0
    for comp_id, path in groups.items():
        lv = get_json(f"{KAMBI}/listView/football/{path}.json?{KAMBI_PARAMS}&useCombined=true")
        events = [e["event"] for e in (lv or {}).get("events", [])
                  if e.get("event", {}).get("start")]
        ours = [m for m in upcoming if m["c"] == comp_id and "kambi" not in m and not m["finished"]]
        pairs = []
        for m in ours:
            ko = parse_utc(m["t"])
            for ev in events:
                if abs((parse_utc(ev["start"]) - ko).total_seconds()) > 3 * 3600:
                    continue
                en = (ev.get("englishName") or "").split(" - ")
                en_h, en_a = (en + ["", ""])[:2] if len(en) == 2 else ("", "")
                sh = max(similarity(teams[m["h"]], ev.get("homeName", "")), similarity(teams[m["h"]], en_h))
                sa = max(similarity(teams[m["a"]], ev.get("awayName", "")), similarity(teams[m["a"]], en_a))
                same_time = parse_utc(ev["start"]) == ko
                # Un seul côté reconnu suffit si l'heure est identique (ex. « OB » vs « Odense BK »)
                if (min(sh, sa) >= 0.45 and sh + sa >= 1.2) or (same_time and max(sh, sa) >= 0.9):
                    pairs.append((sh + sa, m, ev))
        used = set()
        for _, m, ev in sorted(pairs, key=lambda p: -p[0]):
            if "kambi" in m or ev["id"] in used:
                continue
            m["kambi"] = ev["id"]
            used.add(ev["id"])
            matched += 1

    # Un appel par match : les appels groupés de Kambi tronquent la liste des marchés
    ids = [m["kambi"] for m in upcoming if "kambi" in m]
    with ThreadPoolExecutor(max_workers=6) as ex:
        offers = ex.map(lambda i: (get_json(f"{KAMBI}/betoffer/event/{i}.json?{KAMBI_PARAMS}") or {})
                        .get("betOffers", []), ids)
        by_event = dict(zip(ids, offers))
    for m in upcoming:
        if "kambi" in m:
            m["odds"] = extract_odds(by_event.get(m["kambi"], []))
    log(f"Cotes : {matched}/{len(upcoming)} matchs associés à Unibet")


# ---------------------------------------------------------------- main

def regulation_score(m):
    hg = sum(1 for _, home in m["g"] if home)
    return [hg, len(m["g"]) - hg]


def main():
    now = datetime.now(timezone.utc)
    DATA.mkdir(exist_ok=True)
    teams, cache, upcoming, finished = collect_fotmob(now)
    if not cache and not upcoming:
        log("Aucune donnée récupérée : on garde les fichiers existants.")
        sys.exit(1)

    attach_odds(upcoming, teams, now)

    involved = {m["h"] for m in upcoming} | {m["a"] for m in upcoming}
    stats = team_stats(cache, involved)

    # Résultats récents (score à 90 min) pour régler automatiquement les paris
    limit = now - timedelta(days=RESULTS_DAYS)
    results = {mid: regulation_score(m) for mid, m in cache.items() if parse_utc(m["t"]) >= limit}

    out = {
        "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "competitions": [{k: c[k] for k in ("id", "name", "country", "flag")} | {"season": c.get("season")}
                         for c in COMPETITIONS],
        "matches": sorted(upcoming, key=lambda m: (m["t"], m["c"])),
        "teams": {tid: {"name": teams[tid], "stats": stats[tid]} for tid in involved},
        "results": results,
    }
    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    CACHE_FILE.write_text(json.dumps({"matches": cache}, separators=(",", ":")))
    log(f"OK : {len(upcoming)} matchs à venir, {len(cache)} matchs en cache, {len(results)} résultats")


if __name__ == "__main__":
    main()
