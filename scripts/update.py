#!/usr/bin/env python3
"""Collecte des données pour l'app Pronos Foot.

- Matchs, résultats et minutes des buts : FotMob (API publique non officielle)
- Buteurs : compos probables/officielles, absents, xG et minutes des joueurs (FotMob)
- Cotes Unibet (BTTS, plus de 1,5 / 2,5 buts, buteurs) : Kambi, la plateforme de paris d'Unibet

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
import urllib.parse
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
# Joueurs ayant joué / buteurs des matchs récents : gardés quelques jours pour régler les paris buteur
PLAYED_DAYS = 10
# Compos et buteurs calculés pour les matchs des prochaines 48 h
SCORERS_AHEAD = timedelta(hours=48)


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


def played_ids(lineup):
    """Joueurs entrés en jeu (titulaires + remplaçants entrés), pour rembourser un pari buteur sur un absent."""
    ids = []
    for side in ("homeTeam", "awayTeam"):
        t = (lineup or {}).get(side) or {}
        ids += [p["id"] for p in t.get("starters") or [] if p.get("id")]
        ids += [p["id"] for p in t.get("subs") or [] if p.get("id") and any(
            ev.get("type") == "subIn" for ev in ((p.get("performance") or {}).get("substitutionEvents") or []))]
    return ids


def fetch_goals(match_id):
    """Buts du temps réglementaire : liste de [minute, 1 si domicile sinon 0, id du buteur (0 = contre son camp)],
    plus la liste des joueurs entrés en jeu."""
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
        scorer = 0 if e.get("ownGoal") else (e.get("playerId") or (e.get("player") or {}).get("id") or 0)
        goals.append([minute, 1 if e.get("isHome") else 0, scorer])
    return {"g": goals, "p": played_ids(d["content"].get("lineup"))}


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
        # Classements joueurs de la saison (buts, xG…) : servent au % de chances des buteurs
        comp["statUrls"] = {s.get("name"): s.get("fetchAllUrl")
                            for s in (d.get("stats") or {}).get("players") or [] if s.get("fetchAllUrl")}
        seasons = d.get("allAvailableSeasons") or []
        comp["prevSeason"] = seasons[1] if len(seasons) > 1 and seasons[0] == comp["season"] else None
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
        for i, (mid, res) in enumerate(ex.map(work, todo), 1):
            if res is not None:
                fetched[mid] = res
            if i % 200 == 0:
                log(f"  {i}/{len(todo)}")

    # Cache = uniquement les matchs des saisons en cours (les anciennes disparaissent d'elles-mêmes)
    new_cache = {}
    played_limit = now - timedelta(days=PLAYED_DAYS)
    for mid, f in finished.items():
        res = fetched.get(mid) or old_matches.get(mid)
        if res is None:
            continue
        entry = {**{k: f[k] for k in ("c", "t", "h", "a")}, "g": res["g"]}
        # La liste des joueurs entrés en jeu ne sert qu'aux paris récents
        if res.get("p") and parse_utc(f["t"]) >= played_limit:
            entry["p"] = res["p"]
        new_cache[mid] = entry
    return teams, new_cache, upcoming, finished


def empty_stats():
    # f2 / a2 : matchs où l'équipe a marqué / encaissé au moins 2 buts (marché « équipe +1,5 »)
    return {"n": 0, "gf": 0, "ga": 0, "sf": [0] * 6, "sa": [0] * 6, "btts": 0, "o15": 0, "o25": 0, "f2": 0, "a2": 0}


def team_stats(cache, team_ids):
    stats = {tid: {"all": empty_stats(), "home": empty_stats(), "away": empty_stats()} for tid in team_ids}
    for m in cache.values():
        hg = sum(1 for g in m["g"] if g[1])
        ag = len(m["g"]) - hg
        for side, tid in (("home", m["h"]), ("away", m["a"])):
            if tid not in stats:
                continue
            for key in ("all", side):
                s = stats[tid][key]
                s["n"] += 1
                own, opp = (hg, ag) if side == "home" else (ag, hg)
                s["btts"] += hg > 0 and ag > 0
                s["o15"] += hg + ag >= 2
                s["o25"] += hg + ag >= 3
                s["f2"] += own >= 2
                s["a2"] += opp >= 2
                for minute, is_home, *_ in m["g"]:
                    scored = bool(is_home) == (side == "home")
                    b = bucket(minute)
                    if scored:
                        s["gf"] += 1
                        s["sf"][b] += 1
                    else:
                        s["ga"] += 1
                        s["sa"][b] += 1
    return stats


# ---------------------------------------------------------------- Buteurs

# Taux de buts par 90 min « a priori » selon le poste (0 gardien, 1 défenseur, 2 milieu, 3 attaquant),
# utilisé pour lisser les joueurs qui ont encore peu joué.
POS_PRIOR = {0: 0.0, 1: 0.04, 2: 0.12, 3: 0.35}
PRIOR_90 = 1.5        # poids du a priori : l'équivalent d'un match et demi
PREV_WEIGHT = 0.5     # la saison précédente compte moitié moins que la saison en cours
# Sans compo, on retient les joueurs les plus utilisés de la saison : des titulaires habituels
START_PROB = {"confirmed": 1.0, "predicted": 0.9, None: 0.85}


def prev_season_urls(comp):
    if not comp.get("prevSeason"):
        return {}
    d = get_json(f"{FOTMOB}/leagues?id={comp['id']}&season={urllib.parse.quote(comp['prevSeason'])}")
    return {s.get("name"): s.get("fetchAllUrl") for s in ((d or {}).get("stats") or {}).get("players") or [] if s.get("fetchAllUrl")}


def player_stats():
    """Buts, xG et minutes de chaque joueur dans son championnat (une liste par compétition suivie),
    pour la saison en cours et, en appoint, la saison précédente."""
    with ThreadPoolExecutor(max_workers=6) as ex:
        prev_urls = list(ex.map(prev_season_urls, COMPETITIONS))
    cur = read_player_lists([(c, c.get("statUrls") or {}) for c in COMPETITIONS])
    prev = read_player_lists(list(zip(COMPETITIONS, prev_urls)))
    for pid, p in cur.items():
        if pid in prev:
            p["prev"] = {k: prev[pid].get(k) for k in ("g", "xg", "min")}
    # Joueurs sans minute cette saison (blessés longtemps, recrues) : la saison précédente seule
    for pid, p in prev.items():
        cur.setdefault(pid, {"team": None, "name": p["name"], "min": 0, "mp": 0, "g": 0, "prev": {k: p.get(k) for k in ("g", "xg", "min")}})
    log(f"Stats joueurs : {len(cur)} joueurs (saison précédente : {len(prev)})")
    return cur


def read_player_lists(comps_urls):
    out = {}
    jobs = [(c, name, urls[name]) for c, urls in comps_urls for name in ("goals", "expected_goals") if urls.get(name)]
    with ThreadPoolExecutor(max_workers=6) as ex:
        lists = ex.map(lambda j: (j[:2], get_json(j[2])), jobs)
        for (c, name), d in lists:
            for top in (d or {}).get("TopLists") or []:
                for r in top.get("StatList") or []:
                    pid = r.get("ParticiantId") or r.get("ParticipantId")
                    if not pid:
                        continue
                    p = out.setdefault(pid, {"team": r.get("TeamId"), "name": r.get("ParticipantName")})
                    # On garde la compétition où le joueur a le plus joué (championnat plutôt que coupe d'Europe)
                    mins = r.get("MinutesPlayed") or 0
                    if p.get("c") not in (None, c["id"]) and mins <= p.get("min", 0):
                        continue
                    p.update(c=c["id"], min=mins, mp=r.get("MatchesPlayed") or 0)
                    if name == "goals":
                        p["g"] = r.get("StatValue") or 0
                    else:
                        p["xg"] = r.get("StatValue") or 0
                        p.setdefault("g", r.get("SubStatValue") or 0)
    return out


def per90(pos, goals, xg, minutes, prev=None):
    """Buts attendus par 90 min : moitié buts réels, moitié xG (plus stable), complétés par la saison
    précédente (comptée moitié) et lissés vers la moyenne du poste."""
    s = goals if xg is None else (goals + xg) / 2
    n = minutes / 90
    if prev and prev.get("min"):
        ps = prev.get("g") or 0
        if prev.get("xg") is not None:
            ps = (ps + prev["xg"]) / 2
        s += ps * PREV_WEIGHT
        n += prev["min"] / 90 * PREV_WEIGHT
    return (s + POS_PRIOR.get(pos, 0.12) * PRIOR_90) / (n + PRIOR_90)


def build_scorers(details, side, team_id, pstats, team_n):
    lineup = (details.get("content") or {}).get("lineup") or {}
    kind = lineup.get("lineupType") if lineup.get("lineupType") in ("predicted", "confirmed") else None
    if kind is None and lineup.get("lineupType") == "standard":
        kind = "confirmed"
    t = lineup.get(side) or {}
    out = [{"id": p.get("id"), "n": p.get("name"), "why": (p.get("unavailability") or {}).get("type"),
            "ret": (p.get("unavailability") or {}).get("expectedReturn"),
            "g": (p.get("performance") or {}).get("seasonGoals") or (pstats.get(p.get("id")) or {}).get("g") or 0}
           for p in t.get("unavailable") or []]
    out_ids = {o["id"] for o in out}
    starters = [p for p in t.get("starters") or [] if p.get("id") not in out_ids]
    if not starters:
        # Pas encore de compo : on prend les joueurs les plus utilisés de l'équipe cette saison
        kind = None
        pool = sorted((pid for pid, s in pstats.items() if s.get("team") == team_id and pid not in out_ids and s.get("min")),
                      key=lambda pid: -pstats[pid].get("min", 0))[:11]
        starters = [{"id": pid, "name": pstats[pid]["name"], "usualPlayingPositionId": None} for pid in pool]
    players = []
    for p in starters:
        pos = p.get("usualPlayingPositionId")
        if pos == 0 or p.get("positionId") == 11:
            continue  # gardien
        s = pstats.get(p["id"])
        prev = (s or {}).get("prev")
        if s and (s.get("min") or prev):
            goals, xg, minutes = s.get("g", 0), s.get("xg"), s.get("min") or 0
            avg_min = minutes / s["mp"] if s.get("mp") else 75
        else:
            # Hors des championnats suivis : buts de la saison donnés par la compo, minutes estimées
            goals = (p.get("performance") or {}).get("seasonGoals") or 0
            xg, minutes, avg_min = None, 75 * max(1, team_n), 75
        if pos is None:
            pos = 3 if goals / max(1, minutes / 90) > 0.25 else 2
        players.append({
            "id": p["id"], "n": p.get("name"), "pos": pos,
            "r": round(per90(pos, goals, xg, minutes, prev), 3),
            "min": round(min(88, max(60, avg_min))),
            "st": START_PROB[kind], "g": goals, "xg": None if xg is None else round(xg, 1),
        })
    players.sort(key=lambda x: -x["r"] * x["min"])
    return kind, players[:5], [o for o in out if o["g"]][:5]


def attach_scorers(upcoming, stats, now):
    pstats = player_stats()
    todo = [m for m in upcoming if not m["started"] and parse_utc(m["t"]) <= now + SCORERS_AHEAD]
    with ThreadPoolExecutor(max_workers=6) as ex:
        details = list(ex.map(lambda m: get_json(f"{FOTMOB}/matchDetails?matchId={m['id']}"), todo))
    nb = 0
    for m, d in zip(todo, details):
        if not d:
            continue
        sc = {}
        for side, key, tid in (("homeTeam", "h", m["h"]), ("awayTeam", "a", m["a"])):
            kind, players, out = build_scorers(d, side, tid, pstats, stats[tid]["all"]["n"])
            sc[key], sc[f"{key}Out"] = players, out
            sc["lineup"] = kind
        if sc["h"] or sc["a"]:
            m["scorers"] = sc
            nb += 1
    log(f"Buteurs : {nb}/{len(todo)} matchs")


def name_key(n):
    n = unicodedata.normalize("NFKD", n or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z ]", " ", n).split()


def same_player(a, b):
    ka, kb = name_key(a), name_key(b)
    if not ka or not kb:
        return False
    if ka == kb or " ".join(ka) in " ".join(kb) or " ".join(kb) in " ".join(ka):
        return True
    # Même nom de famille et même initiale (« G. Ramos » / « Gonçalo Ramos »)
    return ka[-1] == kb[-1] and ka[0][0] == kb[0][0]


def attach_scorer_odds(m, offers):
    """Cotes Unibet « buteur à tout moment du match » (marché « To Score »)."""
    sc = m.get("scorers")
    if not sc:
        return
    cotes = []
    for b in offers:
        if (b.get("criterion") or {}).get("englishLabel") != "To Score":
            continue
        for o in b.get("outcomes", []):
            if o.get("odds") and o.get("participant") and o.get("status", "OPEN") == "OPEN":
                cotes.append((o["participant"], o["odds"] / 1000))
    for p in sc["h"] + sc["a"]:
        hit = next(((n, odd) for n, odd in cotes if same_player(p["n"], n)), None)
        if hit:
            p["kn"], p["o"] = hit


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


def extract_odds(offers, home_en, away_en):
    """Cotes Unibet : BTTS, plus de 1,5 / 2,5 buts, et plus de 1,5 buts de chaque équipe."""
    wanted = {
        ("Both Teams To Score", "Yes", None): "btts",
        ("Total Goals", "Over", 1500): "o15",
        ("Total Goals", "Over", 2500): "o25",
        (f"Total Goals by {home_en}", "Over", 1500): "h15",
        (f"Total Goals by {away_en}", "Over", 1500): "a15",
    }
    odds = {}
    for b in offers:
        label = (b.get("criterion") or {}).get("englishLabel", "")
        for o in b.get("outcomes", []):
            k = wanted.get((label, o.get("englishLabel"), o.get("line")))
            if k and o.get("odds") and o.get("status", "OPEN") == "OPEN":
                odds[k] = o["odds"] / 1000
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
            # Noms anglais Kambi, utiles pour reconnaître « Total Goals by <équipe> »
            m["kteams"] = ((ev.get("englishName") or "").split(" - ") + ["", ""])[:2]
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
            m["odds"] = extract_odds(by_event.get(m["kambi"], []), *m["kteams"])
            attach_scorer_odds(m, by_event.get(m["kambi"], []))
    log(f"Cotes : {matched}/{len(upcoming)} matchs associés à Unibet")


# ---------------------------------------------------------------- main

def regulation_score(m):
    hg = sum(1 for g in m["g"] if g[1])
    return [hg, len(m["g"]) - hg]


def main():
    now = datetime.now(timezone.utc)
    DATA.mkdir(exist_ok=True)
    teams, cache, upcoming, finished = collect_fotmob(now)
    if not cache and not upcoming:
        log("Aucune donnée récupérée : on garde les fichiers existants.")
        sys.exit(1)

    involved = {m["h"] for m in upcoming} | {m["a"] for m in upcoming}
    stats = team_stats(cache, involved)
    attach_scorers(upcoming, stats, now)
    attach_odds(upcoming, teams, now)

    # Résultats récents (score à 90 min) pour régler automatiquement les paris
    limit = now - timedelta(days=RESULTS_DAYS)
    results = {mid: regulation_score(m) for mid, m in cache.items() if parse_utc(m["t"]) >= limit}
    # Buteurs (hors contre son camp) et joueurs entrés en jeu des matchs récents : règlement des paris buteur
    scorers = {mid: {"g": sorted({g[2] for g in m["g"] if len(g) > 2 and g[2]}), "p": m["p"]}
               for mid, m in cache.items() if m.get("p")}

    out = {
        "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "competitions": [{k: c[k] for k in ("id", "name", "country", "flag")} | {"season": c.get("season")}
                         for c in COMPETITIONS],
        "matches": sorted(upcoming, key=lambda m: (m["t"], m["c"])),
        "teams": {tid: {"name": teams[tid], "stats": stats[tid]} for tid in involved},
        "results": results,
        "scorers": scorers,
    }
    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    CACHE_FILE.write_text(json.dumps({"matches": cache}, separators=(",", ":")))
    log(f"OK : {len(upcoming)} matchs à venir, {len(cache)} matchs en cache, {len(results)} résultats")


if __name__ == "__main__":
    main()
