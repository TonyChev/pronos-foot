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
BOOST_PAGE = "https://www.unibet.fr/cotes-boostees"
SITE = "https://www.unibet.fr/paris-football"
UA = "Mozilla/5.0 (pronos-foot)"
# Pages publiques des compétitions (robots.txt n'autorise que ces pages, pas les API du site)
SITE_PATHS = {
    53: "france/ligue-1-mcdonalds", 47: "angleterre/premier-league", 87: "espagne/laliga", 54: "allemagne/bundesliga-1",
    55: "italie/serie-a", 38: "autriche/d1-autriche", 40: "belgique/d1-belgique", 46: "danemark/d1-danemark",
    64: "ecosse/d1-ecosse", 130: "etats-unis/mls", 51: "finlande/d1-finlande", 223: "japon/d1-japon",
    59: "norvege/d1-norvege", 57: "pays-bas/d1-pays-bas", 61: "portugal/liga-portugal", 67: "suede/d1-suede",
    69: "suisse/d1-suisse", 42: "coupes-d-europe/ligue-des-champions",
    73: "coupes-d-europe/ligue-europa", 10216: "coupes-d-europe/ligue-conference",
}
SITE_NEAR = 6      # heures avant le coup d'envoi : relevé à chaque passage
SITE_EVERY = 4     # heures entre deux relevés pour les matchs plus lointains
SITE_PAUSE = 1     # secondes entre deux pages, pour ne pas charger le site
BOOST_TERMS = re.compile(r"\s*\(([\d,.]+)\s*->\s*([\d,.]+)\s*/\s*Mise max (\d+)[^)]*\)")
FOOTBALL_GROUP = 1000093190

# Fenêtre des matchs à venir publiés (l'app n'affiche qu'aujourd'hui et demain,
# heure locale, mais on garde une marge pour les décalages horaires).
WINDOW_BEFORE = timedelta(hours=30)
WINDOW_AFTER = timedelta(days=3)
RESULTS_DAYS = 60
XG_BACKFILL = 400      # matchs anciens dont on récupère les xG à chaque passage
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


def get_html(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=40) as r:
        body = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
    return body.decode("utf8")


def page_state(html):
    """Données embarquées dans une page publique du site Unibet."""
    return json.loads(re.search(r'<script[^>]*id="serverApp-state"[^>]*>(.*?)</script>', html, re.S).group(1))


def get_boosts():
    """Cotes boostées foot du site Unibet France (état embarqué dans la page) ; liste vide si indisponible."""
    try:
        events = page_state(get_html(BOOST_PAGE))["BoostedBets"]["events"]
    except Exception as e:  # noqa: BLE001
        log(f"  cotes boostées indisponibles : {e}")
        return []
    boosts = []
    for e in events:
        if e.get("sportCode") != "FOOT" or not e.get("parsedStart"):
            continue
        for group in e.get("groupedMarkets", []):
            for mk in group.get("markets", []):
                terms = BOOST_TERMS.search(mk.get("description", ""))
                outcome = next((o for o in mk.get("outcomes", []) if not o.get("hidden")), None)
                if not terms or not outcome or mk.get("suspended") or outcome.get("suspended"):
                    continue
                boosts.append({
                    "id": mk["id"], "t": e["parsedStart"],
                    "home": (e.get("opponentA") or {}).get("label") or e.get("description", ""),
                    "away": (e.get("opponentB") or {}).get("label") or "",
                    "text": BOOST_TERMS.sub("", mk["description"]).removeprefix("CB - ").strip(),
                    "before": float(terms.group(1).replace(",", ".")),
                    "after": float(outcome["price"].replace(",", ".")),
                    "max": int(terms.group(3)),
                })
    log(f"Cotes boostées foot : {len(boosts)}")
    return boosts


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
    return {"g": goals, "p": played_ids(d["content"].get("lineup")), "x": team_xg(d)}


def team_xg(d):
    """xG (buts attendus) des 2 équipes : la qualité des occasions, plus stable que le score."""
    try:
        for per in d["content"]["stats"]["Periods"]["All"]["stats"]:
            for st in per.get("stats") or []:
                if st.get("key") == "expected_goals":
                    return [round(float(v), 2) for v in st["stats"]]
    except (KeyError, TypeError, ValueError):
        pass
    return None


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

    # Détails des buts : seulement pour les matchs terminés pas encore en cache,
    # plus un rattrapage progressif des xG des matchs mis en cache avant leur ajout
    todo = [mid for mid in finished if mid not in old_matches]
    todo += [mid for mid in finished if mid in old_matches and "x" not in old_matches[mid]][:XG_BACKFILL]
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
        if old_matches.get(mid, {}).get("o"):
            entry["o"] = old_matches[mid]["o"]
        # xG du match ; null = indisponible chez FotMob (on ne le redemande pas)
        entry["x"] = res.get("x") if "x" in res or mid in fetched else old_matches.get(mid, {}).get("x")
        if entry["x"] is None and "x" not in res and mid not in fetched:
            del entry["x"]
        # La liste des joueurs entrés en jeu ne sert qu'aux paris récents
        if res.get("p") and parse_utc(f["t"]) >= played_limit:
            entry["p"] = res["p"]
        new_cache[mid] = entry
    return teams, new_cache, upcoming, finished


def empty_stats():
    # f2 / a2 : matchs où l'équipe a marqué / encaissé au moins 2 buts (marché « équipe +1,5 »)
    # xf / xa / nx : xG pour et contre, sur les nx matchs où FotMob les fournit
    return {"n": 0, "gf": 0, "ga": 0, "sf": [0] * 6, "sa": [0] * 6, "btts": 0, "o15": 0, "o25": 0, "f2": 0, "a2": 0,
            "xf": 0, "xa": 0, "nx": 0}


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
                if m.get("x"):
                    xo, xp = m["x"] if side == "home" else m["x"][::-1]
                    s["xf"] = round(s["xf"] + xo, 2)
                    s["xa"] = round(s["xa"] + xp, 2)
                    s["nx"] += 1
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


def player_stats():
    """Buts, xG et minutes de chaque joueur dans son championnat, saison en cours uniquement
    (une liste par compétition suivie)."""
    out = read_player_lists([(c, c.get("statUrls") or {}) for c in COMPETITIONS])
    log(f"Stats joueurs : {len(out)} joueurs")
    return out


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


def per90(pos, goals, xg, minutes):
    """Buts attendus par 90 min : moitié buts réels, moitié xG (plus stable), lissés vers la moyenne du poste."""
    s = goals if xg is None else (goals + xg) / 2
    return (s + POS_PRIOR.get(pos, 0.12) * PRIOR_90) / (minutes / 90 + PRIOR_90)


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
        if s and s.get("min"):
            goals, xg, minutes, mp = s.get("g", 0), s.get("xg"), s["min"], s.get("mp") or None
            avg_min = minutes / mp if mp else 75
        else:
            # Hors des championnats suivis : buts de la saison donnés par la compo, minutes estimées
            goals = (p.get("performance") or {}).get("seasonGoals") or 0
            xg, minutes, avg_min, mp = None, 75 * max(1, team_n), 75, None
        if pos is None:
            pos = 3 if goals / max(1, minutes / 90) > 0.25 else 2
        players.append({
            "id": p["id"], "n": p.get("name"), "pos": pos,
            "r": round(per90(pos, goals, xg, minutes), 3),
            "min": round(min(88, max(60, avg_min))),
            "g": goals, "mp": mp,
        })
    players.sort(key=lambda x: -x["r"] * x["min"])
    # Uniquement des joueurs qui ont déjà marqué cette saison
    players = [x for x in players if x["g"] > 0]
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


# ---------------------------------------------------------------- Site Unibet France
# Les cotes de ce site sont celles qu'on peut réellement jouer ; elles diffèrent du flux Kambi

def site_links(comp_id):
    """(chemin, équipe domicile, équipe extérieur) des matchs affichés sur la page d'une compétition."""
    path = SITE_PATHS[comp_id]
    html = get_html(f"{SITE}/{path}")
    links = []
    for href in sorted(set(re.findall(rf'href="(/paris-football/{re.escape(path)}/\d+/[^"]+-vs-[^"]+)"', html))):
        home, away = href.rsplit("/", 1)[1].split("-vs-", 1)
        links.append((href, home.replace("-", " "), away.replace("-", " ")))
    return links


def site_start(state):
    """Coup d'envoi du match d'une page, pour vérifier qu'on a le bon match."""
    if isinstance(state, dict):
        if state.get("parsedStart"):
            return state["parsedStart"]
        state = list(state.values())
    if isinstance(state, list):
        for v in state:
            start = site_start(v)
            if start:
                return start
    return None


def site_markets(state):
    """Marchés du temps réglementaire d'une page de match, par intitulé."""
    markets = {}

    def walk(o):
        if isinstance(o, dict):
            if "outcomes" in o and "description" in o and o.get("period", "90 Mins") == "90 Mins":
                markets.setdefault(o["description"], o)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(state)
    return markets


def site_price(market, label):
    for o in (market or {}).get("outcomes", []):
        if o.get("description", "").replace(",", ".") == label and not o.get("hidden") and not o.get("suspended"):
            return float(o["price"].replace(",", "."))
    return None


def extract_site_odds(markets, home, away):
    odds = {
        "btts": site_price(markets.get("Les 2 équipes marquent"), "Oui"),
        "o15": site_price(markets.get("Plus / Moins 1.5 But(s)"), "Plus 1.5"),
        "o25": site_price(markets.get("Plus / Moins 2.5 But(s)"), "Plus 2.5"),
    }
    for name, market in markets.items():
        team = re.fullmatch(r"Plus / Moins But\(s\) - (.+) 1,5", name)
        if team:
            key = "h15" if similarity(team.group(1), home) >= similarity(team.group(1), away) else "a15"
            odds[key] = site_price(market, "Plus 1.5")
    return {k: v for k, v in odds.items() if v}


def attach_site_scorer_odds(m, market):
    sc = m.get("scorers")
    outcomes = [o for o in (market or {}).get("outcomes", []) if not o.get("hidden") and not o.get("suspended")]
    if not sc or not outcomes:
        return
    for p in sc["h"] + sc["a"]:
        p.pop("kn", None)
        p.pop("o", None)
        hit = next((o for o in outcomes if same_player(p["n"], o["description"].replace(",", " "))), None)
        if hit:
            p["kn"], p["o"] = hit["description"], float(hit["price"].replace(",", "."))


def attach_site_odds(upcoming, teams, now, previous):
    """Remplace les cotes du flux par celles du site ; un match introuvable garde les cotes du flux."""
    links = {}
    done = reused = 0
    for m in upcoming:
        if m["started"] or m["finished"] or m["c"] not in SITE_PATHS:
            continue
        old = previous.get(m["id"], {})
        near = parse_utc(m["t"]) - now <= timedelta(hours=SITE_NEAR)
        fresh = old.get("oddsAt") and now - parse_utc(old["oddsAt"]) < timedelta(hours=SITE_EVERY)
        if fresh and not near:
            m["odds"], m["oddsAt"], m["oddsSrc"] = old["odds"], old["oddsAt"], "site"
            kept = {p["id"]: p for side in ("h", "a") for p in (old.get("scorers") or {}).get(side, [])}
            for p in ((m.get("scorers") or {}).get("h", []) + (m.get("scorers") or {}).get("a", [])):
                p.pop("kn", None)
                p.pop("o", None)
                if kept.get(p["id"], {}).get("o"):
                    p["kn"], p["o"] = kept[p["id"]].get("kn"), kept[p["id"]]["o"]
            reused += 1
            continue
        try:
            if m["c"] not in links:
                links[m["c"]] = site_links(m["c"])
                time.sleep(SITE_PAUSE)
            home, away = teams[m["h"]], teams[m["a"]]
            best = max(links[m["c"]], key=lambda l: similarity(home, l[1]) + similarity(away, l[2]), default=None)
            if not best:
                continue
            sh, sa = similarity(home, best[1]), similarity(away, best[2])
            # Un seul côté reconnu suffit (« Mainz 05 » / « Mayence ») : le coup d'envoi vérifié ensuite tranche
            if not ((min(sh, sa) >= 0.45 and sh + sa >= 1.2) or max(sh, sa) >= 0.9):
                continue
            state = page_state(get_html(f"https://www.unibet.fr{best[0]}"))
            time.sleep(SITE_PAUSE)
            start = site_start(state)
            if not start or abs((parse_utc(start) - parse_utc(m["t"])).total_seconds()) > 3 * 3600:
                continue
            markets = site_markets(state)
        except Exception as e:  # noqa: BLE001
            log(f"  site Unibet indisponible pour {m['id']} : {e}")
            continue
        odds = extract_site_odds(markets, home, away)
        if odds:
            m["odds"], m["oddsAt"], m["oddsSrc"] = odds, now.strftime("%Y-%m-%dT%H:%M:%SZ"), "site"
            attach_site_scorer_odds(m, markets.get("Buteur"))
            done += 1
    log(f"Cotes du site Unibet : {done} matchs relevés, {reused} repris du relevé précédent")


# ---------------------------------------------------------------- main

def regulation_score(m):
    hg = sum(1 for g in m["g"] if g[1])
    return [hg, len(m["g"]) - hg]


def main():
    now = datetime.now(timezone.utc)
    DATA.mkdir(exist_ok=True)
    teams, cache, upcoming, finished = collect_fotmob(now)
    # Cotes Unibet d'avant-match gardées dans le cache : elles serviront à mesurer la fiabilité de l'avis
    previous = {}
    if OUT_FILE.exists():
        previous = {m["id"]: m for m in json.loads(OUT_FILE.read_text()).get("matches", [])}
    prev_odds = {mid: m["odds"] for mid, m in previous.items() if m.get("odds")}
    for mid, odds in prev_odds.items():
        if mid in cache:
            cache[mid]["o"] = odds
    if not cache and not upcoming:
        log("Aucune donnée récupérée : on garde les fichiers existants.")
        sys.exit(1)

    involved = {m["h"] for m in upcoming} | {m["a"] for m in upcoming}
    stats = team_stats(cache, involved)
    attach_scorers(upcoming, stats, now)
    attach_odds(upcoming, teams, now)
    attach_site_odds(upcoming, teams, now, previous)
    # Une fois le match commencé, on fige les dernières cotes d'avant-match (pas les cotes en direct)
    for m in upcoming:
        if m["started"] and m["id"] in prev_odds:
            m["odds"] = prev_odds[m["id"]]
            if previous[m["id"]].get("oddsSrc"):
                m["oddsSrc"] = previous[m["id"]]["oddsSrc"]

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
        "boosts": get_boosts(),
    }
    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    CACHE_FILE.write_text(json.dumps({"matches": cache}, separators=(",", ":")))
    log(f"OK : {len(upcoming)} matchs à venir, {len(cache)} matchs en cache, {len(results)} résultats")


if __name__ == "__main__":
    main()
