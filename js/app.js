import { initStore, store, onBets, onTransactions, onUser, isConfigured } from "./store.js?v=202610301513";

// Marchés suivis. h15 / a15 = « plus de 1,5 buts » de l'équipe à domicile / à l'extérieur.
const MATCH_MARKETS = ["btts", "o15", "o25"];
const TEAM_MARKETS = ["h15", "a15"];
const ALL_MARKETS = [...MATCH_MARKETS, ...TEAM_MARKETS];
const MARKETS = { btts: "Les 2 équipes marquent", o15: "Plus de 1,5 buts", o25: "Plus de 2,5 buts" };
const SHORT = { btts: "BTTS", o15: "+1,5 buts", o25: "+2,5 buts" };
// Paris buteur : clé « sc:<id du joueur FotMob> », le nom du joueur est gardé dans la sélection
const isScorer = (k) => String(k).startsWith("sc:");
const scorerId = (k) => Number(String(k).slice(3));
// Cotes boostées : clé « cb:<id Unibet> », texte du pari gardé dans la sélection, réglées à la main
const isBoost = (k) => String(k).startsWith("cb:");
const marketLabel = (k, home, away, name) => (isBoost(k) ? name : isScorer(k) ? `${name || "Joueur"} buteur`
  : MARKETS[k] ?? `${k === "h15" ? home : away} : plus de 1,5 buts`);
const shortLabel = (k, home, away) => SHORT[k] ?? `${k === "h15" ? home : away} +1,5`;
const KAMBI = "https://eu-offering-api.kambicdn.com/offering/v2018/ub";
const STATUS_LABEL = { won: "Gagné", lost: "Perdu", pending: "En cours", void: "Remboursé" };
const TX_LABEL = { deposit: "Crédit", withdraw: "Retrait", adjust: "Correction du solde" };

const state = {
  data: null,
  day: 0,
  comp: "all",
  closed: new Set(),       // matchs repliés (tous dépliés par défaut)
  mode: {},                // match id -> "all" | "ha"
  slip: new Map(),         // match id -> Set(marchés)
  slipOdds: null,          // cote totale saisie à la main
  slipStake: "",
  bets: [],
  transactions: [],
  view: "matches",
  betFilter: "pending",
  combos: [],
  combosOpen: false,       // bloc des combinés suggérés replié par défaut
  reliability: null,       // résultat de « Fiabilité de mes avis », calculé à la demande
  user: null,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const teamLogo = (id) => `https://images.fotmob.com/image_resources/logo/teamlogo/${id}_small.png`;
const compLogo = (id) => `https://images.fotmob.com/image_resources/logo/leaguelogo/${id}.png`;
const fmtOdds = (o) => (o ? Number(o).toFixed(2) : "–");
const fmtEur = (v) => `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const pct = (a, n) => (n ? Math.round((a / n) * 100) : 0);
const parseNum = (v) => parseFloat(String(v).replace(",", "."));
const localDay = (d) => d.toLocaleDateString("sv-SE"); // AAAA-MM-JJ, heure locale
const fmtTime = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const fmtDate = (iso) => new Date(iso).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2500);
}

const matchById = (id) => state.data?.matches.find((m) => m.id === id);
const team = (id) => state.data.teams[id];
const comp = (id) => state.data.competitions.find((c) => c.id === id);

// ================================================================ Matchs

function dayMatches() {
  const target = new Date();
  target.setDate(target.getDate() + state.day);
  const key = localDay(target);
  return state.data.matches.filter((m) => localDay(new Date(m.t)) === key);
}

function renderMatches() {
  renderCombos();
  renderBoosts();
  const all = dayMatches();
  const order = state.data.competitions.map((c) => c.id);
  const present = order.filter((id) => all.some((m) => m.c === id));
  if (state.comp !== "all" && !present.includes(state.comp)) state.comp = "all";

  $("#comp-filter").innerHTML = [
    `<button class="chip ${state.comp === "all" ? "active" : ""}" data-comp="all">Toutes (${all.length})</button>`,
    ...present.map((id) => {
      const c = comp(id);
      const n = all.filter((m) => m.c === id).length;
      return `<button class="chip ${state.comp === id ? "active" : ""}" data-comp="${id}">${c.flag} ${esc(c.name)} (${n})</button>`;
    }),
  ].join("");

  // Ordre chronologique, toutes compétitions mélangées ; les matchs commencés ou terminés passent en fin de liste
  const past = (m) => m.started || m.finished || new Date(m.t) <= Date.now();
  const shown = all
    .filter((m) => state.comp === "all" || state.comp === m.c)
    .sort((x, y) => past(x) - past(y) || new Date(x.t) - new Date(y.t) || order.indexOf(x.c) - order.indexOf(y.c));
  if (!shown.length) {
    $("#matches").innerHTML = `<p class="empty">Aucun match ${state.day ? "demain" : "aujourd'hui"} dans tes compétitions.</p>`;
    return;
  }
  $("#matches").innerHTML = shown.map(matchCard).join("");
}

// ================================================================ Combinés suggérés

// Suggestions : paris simples ou combinés (autant de matchs que nécessaire) dont la cote totale est proche de 2.
// Avec une cote de 2, un pari gagné rembourse un pari perdu : on cherche ceux qui ont le plus de chances de passer.
const TARGET_ODDS = [1.8, 2.3];
const MAX_LEGS = 6;
const MIN_SUGGESTION = 0.45;   // en dessous, le pari perd plus souvent qu'il ne gagne

// Toutes les sélections jouables d'un match : marchés de buts et buteurs, avec mes chances et la cote Unibet
function matchLegs(m) {
  const est = estimate(m);
  if (!est) return [];
  const home = team(m.h).name, away = team(m.a).name;
  const legs = ALL_MARKETS.filter((k) => m.odds?.[k] > 1 && !doubtful(m, est, k))
    .map((k) => ({ m, k, p: est[k], odds: m.odds[k], label: shortLabel(k, home, away) }));
  for (const side of ["h", "a"]) {
    for (const p of m.scorers?.[side] || []) {
      const prob = scorerProb(m, side, p);
      if (p.o > 1 && p.g > 0 && prob >= SCORER_MIN) legs.push({ m, k: `sc:${p.id}`, p: prob, odds: p.o, label: `${p.n} buteur` });
    }
  }
  return legs;
}

function renderCombos() {
  const days = [0, 1].map((d) => { const x = new Date(); x.setDate(x.getDate() + d); return localDay(x); });
  // Matchs déjà joués dans un pari en cours : on ne les repropose pas
  const taken = new Set(state.bets.filter((b) => betStatus(b) === "pending").flatMap((b) => b.selections.map((s) => s.matchId)));
  const matches = state.data.matches
    .filter((m) => !m.started && !m.finished && new Date(m.t) > Date.now() && days.includes(localDay(new Date(m.t))) && !taken.has(m.id));
  // « Coût » d'une sélection : chances perdues pour chaque point de cote gagné (plus c'est bas, mieux c'est).
  // On garde les 2 meilleures sélections de chaque match, puis les 24 meilleures en tout.
  const cost = (l) => -Math.log(l.p) / Math.log(l.odds);
  const cands = matches.flatMap((m) => matchLegs(m).filter((l) => l.odds > 1.03).sort((x, y) => cost(x) - cost(y)).slice(0, 2))
    .sort((x, y) => cost(x) - cost(y)).slice(0, 24);
  // Recherche de toutes les combinaisons (un seul pari par match) dont la cote totale tombe près de 2
  const found = [];
  const explore = (start, legs, odds, p) => {
    if (odds >= TARGET_ODDS[0] && odds <= TARGET_ODDS[1] && p >= MIN_SUGGESTION) found.push({ legs: [...legs], odds, p });
    if (legs.length === MAX_LEGS || odds >= TARGET_ODDS[1]) return;
    for (let i = start; i < cands.length; i++) {
      const l = cands[i];
      if (legs.some((x) => x.m.id === l.m.id) || odds * l.odds > TARGET_ODDS[1] || p * l.p < MIN_SUGGESTION) continue;
      legs.push(l);
      explore(i + 1, legs, odds * l.odds, p * l.p);
      legs.pop();
    }
  };
  explore(0, [], 1, 1);
  // Les plus sûres d'abord ; chaque match n'apparaît que dans une seule suggestion
  const used = new Set();
  state.combos = [];
  for (const c of found.sort((x, y) => y.p - x.p || Math.abs(x.odds - 2) - Math.abs(y.odds - 2))) {
    if (c.legs.some((l) => used.has(l.m.id))) continue;
    c.legs.forEach((l) => used.add(l.m.id));
    c.legs.sort((x, y) => new Date(x.m.t) - new Date(y.m.t));
    state.combos.push(c);
    if (state.combos.length === 4) break;
  }
  // Plus rien à suggérer (tout est déjà parié, ou rien d'assez sûr) : le bloc disparaît
  if (!state.combos.length) { $("#combos").innerHTML = ""; return; }
  const dayLabel = (iso) => (localDay(new Date(iso)) === days[0] ? "Auj." : "Demain");
  $("#combos").innerHTML = `<details class="card combos" ${state.combosOpen ? "open" : ""}>
    <summary><h2>Mes paris suggérés (${state.combos.length})</h2></summary>
    <p class="hint">Paris simples ou combinés d'aujourd'hui et de demain dont la cote totale est proche de 2 (entre 1,80 et 2,30) :
      un pari gagné compense un pari perdu. Classés par chances de passer. Marchés de buts et buteurs, sans les paris
      sur lesquels Unibet est bien moins confiant que moi ; les matchs déjà dans un pari en cours sont exclus.</p>
    ${state.combos.length ? state.combos.map((c, i) => `<div class="combo">
      <div class="combo-title">${c.legs.length > 1 ? `Combiné × ${c.legs.length}` : "Pari simple"}</div>
      ${c.legs.map((l) => `<div class="combo-leg">
        <span class="muted small">${dayLabel(l.m.t)} ${fmtTime(l.m.t)} · ${comp(l.m.c).flag} ${esc(comp(l.m.c).name)}</span>
        <span><b>${esc(team(l.m.h).name)} – ${esc(team(l.m.a).name)}</b></span>
        <span>${esc(l.label)} · ${pctSpan(Math.round(l.p * 100))} · cote ${fmtOdds(l.odds)}</span>
      </div>`).join("")}
      <div class="combo-foot">
        <span>${c.legs.length > 1 ? "Tout passe" : "Passe"} : ${pctSpan(Math.round(c.p * 100))} · cote ≈ <b>${fmtOdds(c.odds)}</b></span>
        <button class="chip active" data-combo="${i}">Au bulletin</button>
      </div>
    </div>`).join("") : ""}
  </details>`;
}

// Valeur d'une cote boostée : la marge d'Unibet s'accumule à chaque condition du pari et pèse plus sur un joueur.
// Les combinaisons sur un seul match ont leur propre marge : 0,78 à 0,83 relevé sur « Résultat et les deux équipes marquent »
const BOOST_MARGIN = 0.95;
const BOOST_SAME_MATCH = 0.8;
const BOOST_PLAYER_MARGIN = 0.85;
const BOOST_GOOD = 0.08;

function boostValue(b) {
  const each = b.text.match(/chacun des (\d+)/i);
  const legs = each ? Number(each[1]) : 1 + (b.text.match(/\bet\b/gi) || []).length;
  const player = /\b[A-ZÀ-Ý]\.\s?[A-ZÀ-Ý]/.test(b.text);
  const sameMatch = legs > 1 && b.away && !each;
  const p = (sameMatch ? BOOST_SAME_MATCH : BOOST_MARGIN ** (player ? legs - 1 : legs) * (player ? BOOST_PLAYER_MARGIN : 1)) / b.before;
  const edge = b.after * p - 1;
  return { p, edge, level: edge >= BOOST_GOOD ? "yes" : "maybe" };
}

const BOOST_LABEL = { yes: "Intéressant", maybe: "Correct" };

function renderBoosts() {
  const now = Date.now();
  const taken = new Set(state.bets.flatMap((b) => b.selections.map((s) => s.matchId)));
  const boosts = (state.data?.boosts || []).filter((b) => new Date(b.t) > now && !taken.has(`cb:${b.id}`))
    .map((b) => ({ ...b, ...boostValue(b) })).filter((b) => b.edge >= 0).sort((x, y) => y.edge - x.edge);
  if (!boosts.length) { $("#boosts").innerHTML = ""; return; }
  $("#boosts").innerHTML = `<details class="card combos boosts" ${state.boostsOpen ? "open" : ""}>
    <summary><h2>Cotes boostées Unibet (${boosts.length})</h2></summary>
    <p class="hint">Seules les offres à valeur positive sont affichées. Valeur estimée d'après le boost et la marge habituelle d'Unibet, sans analyse du match.
      Le règlement se fait à la main dans Mes paris.</p>
    ${boosts.map((b) => `<div class="combo">
      <div class="combo-title"><span class="dot ${b.level}"></span> ${BOOST_LABEL[b.level]}</div>
      <div class="combo-leg">
        <span class="muted small">${localDay(new Date(b.t)) === localDay(new Date()) ? "Auj." : "Demain"} ${fmtTime(b.t)}</span>
        <span><b>${esc(b.home)}${b.away ? ` – ${esc(b.away)}` : ""}</b></span>
        <span>${esc(b.text)}</span>
      </div>
      <div class="combo-foot">
        <span>${fmtOdds(b.before)} → <b>${fmtOdds(b.after)}</b> · chances ≈ ${Math.round(b.p * 100)} % · valeur +${Math.round(b.edge * 100)} %</span>
        <button class="chip active" data-boost="${b.id}">J'ai parié</button>
      </div>
    </div>`).join("")}
  </details>`;
}

async function saveBoost(id) {
  const b = state.data.boosts.find((x) => String(x.id) === id);
  const stake = parseNum(prompt(`Mise sur cette cote boostée à ${fmtOdds(b.after)} (max ${b.max} €) :`) ?? "");
  if (!(stake > 0)) return;
  try {
    await store.add({
      odds: b.after, stake, manual: null,
      selections: [{
        matchId: `cb:${b.id}`, kickoff: b.t, home: b.home, away: b.away,
        markets: [{ k: `cb:${b.id}`, name: b.text, odds: b.after }], score: null,
      }],
    });
    renderMatches();
    toast("Pari enregistré ✔");
  } catch (e) {
    console.error(e);
    toast(`Erreur d'enregistrement (${e.code || e.message})`);
  }
}

function matchCard(m) {
  const h = team(m.h), a = team(m.a);
  const c = comp(m.c);
  const open = !state.closed.has(m.id);
  const [hs, as] = (m.score || "").split(" - ");
  let ko = `<div class="kickoff">${fmtTime(m.t)}</div>`;
  if (m.finished) ko = `<div class="kickoff">Fin</div>`;
  else if (m.started) ko = `<div class="kickoff live">${esc(m.live || "En cours")}</div>`;
  const picked = state.slip.get(m.id) || new Set();
  const locked = m.started || m.finished;
  // Même chiffre que dans « Mon avis » : mes chances estimées (à défaut, la fréquence observée)
  const est = estimate(m);
  const hint = (k) => {
    if (est) return Math.round(est[k] * 100);
    const n = h.stats.all.n + a.stats.all.n;
    return n ? Math.round(freq(m, k) * 100) : null;
  };
  const oddBtn = (k) => {
    const o = m.odds?.[k];
    const p = hint(k);
    return `<button class="odd ${picked.has(k) ? "picked" : ""}" data-pick="${k}" data-id="${m.id}" ${!o || locked ? "disabled" : ""}
      title="${esc(marketLabel(k, h.name, a.name))} — mes chances estimées : ${p ?? "–"}%">
      <span class="odd-label">${esc(shortLabel(k, h.name, a.name))}</span>
      <span class="odd-foot">${p === null ? "<span></span>" : pctSpan(p, "pct")}<b>${fmtOdds(o)}</b></span></button>`;
  };
  return `<article class="match ${open ? "open" : ""}" data-match="${m.id}">
    <div class="match-comp"><img src="${compLogo(m.c)}" alt="" loading="lazy">${c.flag} ${esc(c.name)} <span class="muted">· ${esc(c.country)}</span></div>
    <button class="match-head" data-toggle="${m.id}" aria-expanded="${open}">
      ${ko}
      <div class="teams">
        <span class="team home"><img src="${teamLogo(m.h)}" alt="" loading="lazy"><span class="name">${esc(h.name)}</span></span>
        <span class="score">${m.score ? `${esc(hs)}<i>-</i>${esc(as)}` : "<i>–</i>"}</span>
        <span class="team away"><img src="${teamLogo(m.a)}" alt="" loading="lazy"><span class="name">${esc(a.name)}</span></span>
      </div>
      <span class="chev">▾</span>
    </button>
    <div class="odds-row">${MATCH_MARKETS.map(oddBtn).join("")}</div>
    <div class="odds-row team">${TEAM_MARKETS.map(oddBtn).join("")}</div>
    ${locked ? "" : verdictHTML(m)}
    ${open && !locked ? scorersHTML(m, picked) : ""}
    ${open ? distHTML(m) : ""}
  </article>`;
}

// 50 % ou plus en vert, moins de 50 % en rouge
const pctSpan = (p, cls = "") => `<span class="pill ${cls} ${p >= 50 ? "good" : "bad"}">${p}%</span>`;

// ================================================================ Mon avis (modèle statistique)

const poisson = (lambda, k) => {
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return (Math.exp(-lambda) * lambda ** k) / f;
};

// Moyenne domicile (ou extérieur) lissée vers la moyenne générale de l'équipe :
// avec peu de matchs à domicile, on se fie davantage à l'ensemble de la saison.
const PRIOR = 3;
const rate = (split, all, key) => (all.n ? (split[key] + (all[key] / all.n) * PRIOR) / (split.n + PRIOR) : 0);
// Même calcul sur les xG (qualité des occasions), quand FotMob les fournit pour au moins 3 matchs
const xrate = (split, all, key) => (all.nx >= 3 ? (split[key] + (all[key] / all.nx) * PRIOR) / (split.nx + PRIOR) : null);
// Buts attendus : moitié buts réels, moitié xG (testé sur les matchs de la saison : légèrement plus fiable)
const blend = (split, all, g, x) => {
  const xr = xrate(split, all, x);
  return xr === null ? rate(split, all, g) : (rate(split, all, g) + xr) / 2;
};

// Fréquence observée cette saison. Pour « équipe +1,5 », on croise l'attaque de l'équipe
// (matchs où elle a marqué 2 buts ou plus) avec la défense adverse (matchs où l'adversaire en a encaissé 2 ou plus).
function freq(m, k) { return freqStats(team(m.h).stats.all, team(m.a).stats.all, k); }

function freqStats(H, A, k) {
  const n = H.n + A.n;
  if (!n) return 0;
  if (k === "h15") return (H.f2 + A.a2) / n;
  if (k === "a15") return (A.f2 + H.a2) / n;
  return (H[k] + A[k]) / n;
}

const atMost = (lambda, k) => [...Array(k + 1).keys()].reduce((s, i) => s + poisson(lambda, i), 0);

function estimate(m) { return estimateFrom(team(m.h).stats, team(m.a).stats, m.odds); }

// Estimation à partir des stats des 2 équipes (saison, domicile, extérieur) et des cotes Unibet éventuelles.
// Sert aussi à rejouer mes avis sur les matchs passés (rubrique « Fiabilité de mes avis »).
function estimateFrom(H, A, odds) {
  if (H.all.n < 4 || A.all.n < 4) return null;
  // Buts attendus : attaque de l'un croisée avec la défense de l'autre (loi de Poisson)
  const lh = (blend(H.home, H.all, "gf", "xf") + blend(A.away, A.all, "ga", "xa")) / 2;
  const la = (blend(A.away, A.all, "gf", "xf") + blend(H.home, H.all, "ga", "xa")) / 2;
  const model = {
    btts: (1 - Math.exp(-lh)) * (1 - Math.exp(-la)),
    o15: 1 - atMost(lh + la, 1),
    o25: 1 - atMost(lh + la, 2),
    h15: 1 - atMost(lh, 1),
    a15: 1 - atMost(la, 1),
  };
  // Mélange avec les fréquences réellement observées cette saison, puis recalage sur les résultats réels.
  // Enfin, moitié mes stats, moitié l'avis d'Unibet (sa cote sans sa marge) : le bookmaker sait des choses
  // que les stats ignorent (compos, forme, enjeu, météo), et les deux avis réunis se trompent moins souvent.
  const est = { lh, la, stats: {} };
  for (const k of ALL_MARKETS) {
    est.stats[k] = calibrate(k, 0.6 * model[k] + 0.4 * freqStats(H.all, A.all, k));
    const u = unibetProb(odds?.[k]);
    est[k] = u === null ? est.stats[k] : (est.stats[k] + u) / 2;
  }
  return est;
}

// Recalage mesuré sur ~1 700 matchs de la saison (chaque match estimé avec les seuls matchs joués avant lui) :
// le calcul brut était trop optimiste de 3 à 7 points. Ex. un « +1,5 buts » annoncé à 89 % ne passait que 85 % du temps.
const CALIBRATION = { btts: [0.19, 0.545], o15: [0.716, 0.562], o25: [0.256, 0.494], h15: [0.184, 0.875], a15: [-0.161, 0.683] };
function calibrate(k, p) {
  const [a, b] = CALIBRATION[k];
  const q = Math.min(0.99, Math.max(0.01, p));
  return 1 / (1 + Math.exp(-(a + b * Math.log(q / (1 - q)))));
}

// Chances selon Unibet : inverse de la cote, moins la marge du bookmaker (~5 %)
const UNIBET_MARGIN = 0.95;
const unibetProb = (odds) => (odds > 1 ? UNIBET_MARGIN / odds : null);
// Garde-fou : si mes stats sont nettement plus optimistes qu'Unibet, je ne conseille pas le pari
const doubtful = (m, est, k) => doubtfulOdds(m.odds, est, k);
const doubtfulOdds = (odds, est, k) => {
  const u = unibetProb(odds?.[k]);
  return u !== null && est.stats[k] - u > 0.08;
};

// L'avis ne regarde que la probabilité : en combiné, une cote basse sur un match reste utile.
// « +1,5 buts » passe naturellement plus souvent : ses seuils sont donc plus exigeants.
const THRESHOLDS = { o15: [0.84, 0.8] };
const DEFAULT_THRESHOLDS = [0.68, 0.63];
const YES = (k) => (THRESHOLDS[k] || DEFAULT_THRESHOLDS)[0];
const MAYBE = (k) => (THRESHOLDS[k] || DEFAULT_THRESHOLDS)[1];
const level = (p, k) => (p >= YES(k) ? "yes" : p >= MAYBE(k) ? "maybe" : "no");
// Niveau final d'un marché sur un match : un pari douteux (Unibet bien moins confiant) passe au mieux en « jouable »
const marketLevel = (m, est, k) => {
  const lv = level(est[k], k);
  return lv === "yes" && doubtful(m, est, k) ? "maybe" : lv;
};
// Marge au-dessus du seuil « je miserais » : sert à choisir le marché le plus convaincant
// (un marché douteux passe derrière les autres)
const margin = (est, k, m) => est[k] - YES(k) - (m && doubtful(m, est, k) ? 1 : 0);

function verdictHTML(m) {
  const est = estimate(m);
  if (!est) {
    return `<div class="verdict no"><b>Mon avis : je ne miserais pas</b><span>Pas assez de matchs joués cette saison pour juger.</span></div>`;
  }
  const home = team(m.h).name, away = team(m.a).name;
  const best = [...ALL_MARKETS].sort((x, y) => margin(est, y, m) - margin(est, x, m))[0];
  const lv = marketLevel(m, est, best);
  const name = esc(shortLabel(best, home, away));
  const title = {
    yes: `je miserais sur « ${name} »`,
    maybe: `jouable sur « ${name} », sans plus`,
    no: "je ne miserais pas",
  }[lv];
  const line = (k) => {
    const p = Math.round(est[k] * 100);
    const o = m.odds?.[k];
    const tag = `<i class="dot ${marketLevel(m, est, k)}"></i>`;
    const warn = doubtful(m, est, k) && level(est[k], k) !== "no"
      ? ` <span class="warn">⚠ Unibet moins confiant (${Math.round(unibetProb(o) * 100)}% contre ${Math.round(est.stats[k] * 100)}% pour mes stats)</span>` : "";
    return `<span>${tag} ${esc(shortLabel(k, home, away))} : ${pctSpan(p)}${o ? ` · cote ${fmtOdds(o)}` : ""}${warn}</span>`;
  };
  return `<div class="verdict ${lv}">
    <b>Mon avis : ${title}</b>
    ${ALL_MARKETS.map(line).join("")}
    <span class="muted">Buts attendus : ${est.lh.toFixed(1).replace(".", ",")} – ${est.la.toFixed(1).replace(".", ",")} · avis statistique, pas une garantie</span>
  </div>`;
}

// ================================================================ Buteurs

const scorerOf = (m, k) => [...(m.scorers?.h || []), ...(m.scorers?.a || [])].find((p) => p.id === scorerId(k));

// Chances qu'un joueur marque pendant le temps réglementaire (loi de Poisson), en le supposant titulaire :
// ses buts attendus par 90 min cette saison (buts réels + xG, calculés par le script de collecte)
// × son temps de jeu habituel, corrigés par les buts attendus de son équipe dans CE match
// (attaque croisée avec la défense adverse) rapportés à sa moyenne de la saison.
// Le lissage vers la moyenne du poste tire les meilleurs buteurs vers le bas : recalage de 1,1.
const SCORER_CALIBRATION = 1.1;
const SCORER_MIN = 0.25;  // en dessous de 25 % de chances, le joueur n'est pas proposé
function scorerProb(m, side, p) {
  const s = team(side === "h" ? m.h : m.a).stats.all;
  const avg = s.n ? s.gf / s.n : 0;
  const est = estimate(m);
  const adj = est && avg ? Math.min(1.6, Math.max(0.6, (side === "h" ? est.lh : est.la) / avg)) : 1;
  return 1 - Math.exp(-p.r * (p.min / 90) * adj * SCORER_CALIBRATION);
}

const WHY = { injury: "blessé", suspension: "suspendu", international: "en sélection" };

function scorersHTML(m, picked) {
  const sc = m.scorers;
  if (!sc || !(sc.h.length || sc.a.length)) return "";
  const side = (key, teamId) => {
    // 3 joueurs maximum, ayant déjà marqué cette saison et avec au moins 25 % de chances
    const players = sc[key].map((p) => ({ ...p, prob: scorerProb(m, key, p) }))
      .filter((p) => p.g > 0 && p.prob >= SCORER_MIN)
      .sort((x, y) => y.prob - x.prob).slice(0, 3);
    const out = sc[`${key}Out`] || [];
    const goalsLine = (p) => `${p.g} but${p.g > 1 ? "s" : ""}${p.mp ? ` en ${p.mp} match${p.mp > 1 ? "s" : ""}` : ""}`;
    return `<div class="sc-team"><img class="logo" src="${teamLogo(teamId)}" alt=""><span>${esc(team(teamId).name)}</span></div>
      ${players.length ? "" : `<p class="sc-out">Aucun joueur à 25 % de chances ou plus.</p>`}
      <div class="odds-row sc">${players.map((p) => {
        const k = `sc:${p.id}`;
        const pr = Math.round(p.prob * 100);
        // ★ : la cote Unibet paie nettement plus que ce que mes chances justifient
        // (pas sur les outsiders, où l'estimation est trop incertaine)
        const value = p.o && p.prob >= 0.2 && p.prob * p.o >= 1.2;
        const title = `${p.n} : ${goalsLine(p)} cette saison — mes chances : ${pr}%${p.o ? ` — Unibet : ${Math.round(100 / p.o)}%` : " — pas de cote Unibet"}`;
        return `<button class="odd sc-row ${picked.has(k) ? "picked" : ""}" data-pick="${k}" data-id="${m.id}" ${p.o ? "" : "disabled"} title="${esc(title)}">
          <span class="odd-label">${esc(p.n)}<small>${goalsLine(p)}</small></span>
          ${pctSpan(pr, "pct")}<b>${value ? `<i class="value">★</i>` : ""}${fmtOdds(p.o)}</b></button>`;
      }).join("")}</div>
      ${out.length ? `<p class="sc-out">Absents : ${out.map((o) => `${esc(o.n)} (${WHY[o.why] || "absent"}, ${o.g} but${o.g > 1 ? "s" : ""})`).join(" · ")}</p>` : ""}`;
  };
  return `<div class="scorers">
    <h3>Buteurs</h3>
    ${side("h", m.h)}${side("a", m.a)}
  </div>`;
}

function cellsHTML(values) {
  const max = Math.max(...values, 1);
  const cell = (v) => `<div class="cell ${v ? "" : "zero"}" style="--r:${(v / max).toFixed(2)}">${v}</div>`;
  return `<div class="cells">${values.slice(0, 3).map(cell).join("")}<div class="gap"></div>${values.slice(3).map(cell).join("")}</div>`;
}

function distRow(teamId, kind, total, values) {
  return `<div class="dist-row ${kind}">
    <div class="dist-label"><img class="logo" src="${teamLogo(teamId)}" alt=""><span>${kind === "scored" ? "Marqué" : "Concédé"}</span></div>
    <div class="dist-total ${kind}">${total}</div>
    ${cellsHTML(values)}
  </div>`;
}

function distHTML(m) {
  const mode = state.mode[m.id] || "all";
  const H = team(m.h), A = team(m.a);
  const hs = mode === "all" ? H.stats.all : H.stats.home;
  const as = mode === "all" ? A.stats.all : A.stats.away;
  const c = comp(m.c);
  const label = (n, where) => `${n} match${n > 1 ? "s" : ""}${where}`;
  const note = mode === "all"
    ? `Répartition des buts ${esc(H.name)} (${label(hs.n, "")}) et ${esc(A.name)} (${label(as.n, "")}), championnat et coupes d'Europe, saison ${esc(c.season || "")}.`
    : `Répartition des buts ${esc(H.name)} (${label(hs.n, " à domicile")}) et ${esc(A.name)} (${label(as.n, " à l'extérieur")}), saison ${esc(c.season || "")}.`;
  const kpi = (id, name, s) => `<div class="t"><img class="logo" src="${teamLogo(id)}" alt=""><span>${esc(name)}</span></div>
    <div class="v">${s.n ? ((s.gf + s.ga) / s.n).toFixed(1).replace(".", ",") : "–"}</div>
    ${["btts", "o15", "o25", "f2"].map((k) => `<div class="v">${s.n ? pctSpan(pct(s[k], s.n)) : "–"}</div>`).join("")}`;
  return `<div class="dist">
    <h3>Répartition des buts</h3>
    <div class="seg">
      <button data-mode="all" data-id="${m.id}" class="${mode === "all" ? "active" : ""}">Tout</button>
      <button data-mode="ha" data-id="${m.id}" class="${mode === "ha" ? "active" : ""}">À domicile/à l'extérieur</button>
    </div>
    <div class="dist-block">${distRow(m.h, "scored", hs.gf, hs.sf)}${distRow(m.a, "conceded", as.ga, as.sa)}</div>
    <div class="dist-block">${distRow(m.a, "scored", as.gf, as.sf)}${distRow(m.h, "conceded", hs.ga, hs.sa)}</div>
    <div class="axis">${["00'", "15'", "30'", "45'", "60'", "75'", "90'"].map((t, i) => `<span style="left:${(i / 6) * 100}%">${t}</span>`).join("")}</div>
    <p class="dist-note">${note}</p>
    <div class="kpis">
      <div class="h" style="text-align:left">Ses matchs</div><div class="h">Buts/m</div><div class="h">BTTS</div><div class="h">Match +1,5</div><div class="h">Match +2,5</div><div class="h">A marqué 2+</div>
      ${kpi(m.h, H.name, hs)}${kpi(m.a, A.name, as)}
    </div>
    <p class="dist-note">Part des matchs de chaque équipe cette saison${mode === "all" ? "" : " (à domicile pour la 1ʳᵉ, à l'extérieur pour la 2ᵉ)"} :
      « Match +1,5 » = au moins 2 buts dans le match, les 2 équipes confondues ; « A marqué 2+ » = l'équipe elle-même a marqué au moins 2 buts.
      Les % des cotes et de « Mon avis » sont mes chances estimées pour ce match précis (moitié mes stats, moitié la cote Unibet).</p>
  </div>`;
}

function renderUpdated() {
  const g = new Date(state.data.generatedAt);
  const min = Math.round((Date.now() - g) / 60000);
  const ago = min < 60 ? `${min} min` : `${Math.round(min / 60)} h`;
  $("#updated").textContent = `Données mises à jour il y a ${ago} · cotes Unibet · touche un match pour replier ses stats`;
}

// ================================================================ Cotes en direct (Kambi / Unibet)

function extractOdds(offers, [homeEn = "", awayEn = ""] = []) {
  const wanted = {
    "Both Teams To Score|Yes|": "btts",
    "Total Goals|Over|1500": "o15",
    "Total Goals|Over|2500": "o25",
    [`Total Goals by ${homeEn}|Over|1500`]: "h15",
    [`Total Goals by ${awayEn}|Over|1500`]: "a15",
  };
  const odds = {};
  for (const b of offers) {
    for (const o of b.outcomes || []) {
      if (!o.odds || (o.status && o.status !== "OPEN")) continue;
      const k = wanted[`${b.criterion?.englishLabel}|${o.englishLabel}|${o.line ?? ""}`];
      if (k) odds[k] = o.odds / 1000;
    }
  }
  return odds;
}

function refreshScorerOdds(m, offers) {
  const cotes = new Map();
  for (const b of offers) {
    if (b.criterion?.englishLabel !== "To Score") continue;
    for (const o of b.outcomes || []) if (o.participant && o.odds && (!o.status || o.status === "OPEN")) cotes.set(o.participant, o.odds / 1000);
  }
  for (const p of [...(m.scorers?.h || []), ...(m.scorers?.a || [])]) if (p.kn && cotes.has(p.kn)) p.o = cotes.get(p.kn);
}

async function refreshOdds() {
  const btn = $("#refresh-odds");
  const todo = dayMatches().filter((m) => m.kambi && !m.started);
  if (!todo.length) return toast("Aucune cote à actualiser");
  btn.disabled = true;
  let ok = 0;
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift();
      try {
        const r = await fetch(`${KAMBI}/betoffer/event/${m.kambi}.json?lang=fr_FR&market=FR`);
        if (!r.ok) continue;
        const offers = (await r.json()).betOffers || [];
        const odds = extractOdds(offers, m.kteams);
        if (Object.keys(odds).length) { m.odds = odds; ok++; }
        refreshScorerOdds(m, offers);
      } catch { /* réseau : on garde l'ancienne cote */ }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  btn.disabled = false;
  renderMatches();
  toast(`Cotes actualisées (${ok}/${todo.length} matchs)`);
}

// ================================================================ Bulletin

function slipSelections() {
  return [...state.slip.entries()].map(([id, set]) => {
    const m = matchById(id);
    return { m, markets: [...set].map((k) => {
      if (!isScorer(k)) return { k, odds: m.odds?.[k] ?? null };
      const p = scorerOf(m, k);
      return { k, odds: p?.o ?? null, name: p?.n ?? "Joueur" };
    }) };
  }).filter((s) => s.m);
}

function suggestedOdds(sels) {
  let total = 1;
  for (const s of sels) for (const mk of s.markets) total *= mk.odds || 1;
  return Math.round(total * 100) / 100;
}

function renderSlip() {
  const sels = slipSelections();
  const count = sels.reduce((n, s) => n + s.markets.length, 0);
  renderSlipBar(sels, count);
  const view = $("#view-slip");
  if (!count) {
    if ($("#slip-sheet").open) $("#slip-sheet").close();
    view.innerHTML = `<p class="empty">Ton bulletin est vide.<br>Dans l'onglet <b>Matchs</b>, touche une cote
      (les 2 marquent, +1,5 buts, +2,5 buts, +1,5 buts d'une équipe ou un buteur) pour l'ajouter.</p>`;
    return;
  }
  const suggested = suggestedOdds(sels);
  const oddsVal = state.slipOdds ?? suggested;
  const stake = parseNum(state.slipStake);
  const gain = parseNum(oddsVal) * stake;
  const sameMatch = sels.some((s) => s.markets.length > 1);
  const needLogin = isConfigured && !state.user;
  const bal = balance();
  view.innerHTML = `<div class="card">
    <h2>${count > 1 ? `Combiné · ${count} sélections` : "Pari simple"}</h2>
    ${sels.map(({ m, markets }) => `<div class="sel">
      <div>
        <div class="sel-title">${esc(team(m.h).name)} – ${esc(team(m.a).name)}</div>
        <div class="muted small">${comp(m.c).flag} ${esc(comp(m.c).name)} · ${fmtDate(m.t)} ${fmtTime(m.t)}</div>
        <div class="sel-markets">${markets.map((mk) => `<span class="tag">${esc(marketLabel(mk.k, team(m.h).name, team(m.a).name, mk.name))} <b>${fmtOdds(mk.odds)}</b>
          <button data-unpick="${mk.k}" data-id="${m.id}" aria-label="Retirer">✕</button></span>`).join("")}</div>
      </div>
    </div>`).join("")}
  </div>
  <div class="card">
    <div class="grid2">
      <label class="field">Cote totale Unibet
        <input id="slip-odds" inputmode="decimal" value="${esc(String(oddsVal).replace(".", ","))}">
      </label>
      <label class="field">Mise (€)
        <input id="slip-stake" inputmode="decimal" placeholder="ex. 5" value="${esc(state.slipStake)}">
      </label>
    </div>
    <p class="hint">Solde disponible : <b class="${bal < 0 ? "neg" : ""}">${fmtEur(bal)}</b>
      <span id="stake-warn" class="neg" ${stake > bal ? "" : "hidden"}> · mise supérieure à ton solde</span></p>
    <p class="hint">Cote calculée : ${String(suggested).replace(".", ",")}. Corrige-la avec la cote exacte affichée par Unibet${sameMatch ? " (2 paris sur un même match = « Bet Builder » : la cote réelle est différente du produit)" : ""}.</p>
    <div class="summary-line"><span>Gain potentiel</span><b id="slip-gain">${Number.isFinite(gain) ? fmtEur(gain) : "–"}</b></div>
    ${needLogin ? `<button class="btn" data-login>Se connecter pour enregistrer</button>`
      : `<button class="btn" id="save-bet">Enregistrer mon pari</button>`}
    <button class="btn secondary" id="clear-slip" style="margin-top:8px">Vider le bulletin</button>
  </div>`;
}

// Barre flottante sur l'onglet Matchs : dès qu'une cote est choisie, propose de créer le pari
function renderSlipBar(sels = slipSelections(), count = sels.reduce((n, s) => n + s.markets.length, 0)) {
  const bar = $("#slip-bar");
  bar.hidden = !count || state.view !== "matches";
  if (bar.hidden) return;
  const odds = state.slipOdds ?? suggestedOdds(sels);
  bar.innerHTML = `<div><b>${count} sélection${count > 1 ? "s" : ""}</b><span>cote ${esc(String(odds).replace(".", ","))}</span></div>
    <button class="btn" data-open-slip>${count > 1 ? "Créer le combiné" : "Créer le pari"}</button>`;
}

async function saveBet() {
  const sels = slipSelections();
  const odds = parseNum($("#slip-odds").value);
  const stake = parseNum($("#slip-stake").value);
  if (!(odds > 1)) return toast("Indique la cote totale");
  if (!(stake > 0)) return toast("Indique ta mise");
  if (stake > balance() && !confirm(`Ta mise (${fmtEur(stake)}) dépasse ton solde (${fmtEur(balance())}). Enregistrer quand même ?`)) return;
  const bet = {
    odds, stake, manual: null,
    selections: sels.map(({ m, markets }) => ({
      matchId: m.id, compId: m.c, kickoff: m.t,
      home: team(m.h).name, away: team(m.a).name, homeId: m.h, awayId: m.a,
      markets, score: null,
    })),
  };
  const btn = $("#save-bet");
  btn.disabled = true;
  try {
    await store.add(bet);
    state.slip.clear();
    state.slipOdds = null;
    state.slipStake = "";
    renderSlip();
    renderMatches();
    toast("Pari enregistré ✔");
  } catch (e) {
    console.error(e);
    toast(`Erreur d'enregistrement (${e.code || e.message})`);
    btn.disabled = false;
  }
}

// ================================================================ Mes paris

const marketWon = (k, [hg, ag]) => ({
  btts: hg > 0 && ag > 0, o15: hg + ag >= 2, o25: hg + ag >= 3, h15: hg >= 2, a15: ag >= 2,
})[k];

function selectionScore(sel) {
  return sel.score || state.data?.results?.[sel.matchId] || null;
}

// Pari buteur : gagné s'il a marqué (hors contre son camp), remboursé s'il n'est pas entré en jeu
const scorerResult = (info, id) => (!info ? null : info.g.includes(id) ? "won" : info.p.length && !info.p.includes(id) ? "void" : "lost");

// "won" | "lost" | "void" | null (pas encore connu)
function marketResult(sel, mk) {
  if (isScorer(mk.k)) {
    const id = scorerId(mk.k);
    return sel.scr?.[id] ?? scorerResult(state.data?.scorers?.[sel.matchId], id);
  }
  const sc = selectionScore(sel);
  return sc ? (marketWon(mk.k, sc) ? "won" : "lost") : null;
}

const combine = (st) => (st.includes("lost") ? "lost" : st.some((s) => s === null || s === "pending") ? "pending"
  : st.every((s) => s === "void") ? "void" : "won");

function selectionStatus(sel) {
  return combine(sel.markets.map((mk) => marketResult(sel, mk)));
}

function betStatus(bet) {
  if (bet.manual) return bet.manual;
  return combine(bet.selections.map(selectionStatus));
}

// Une sélection remboursée (buteur non entré en jeu) sort du combiné : sa cote est retirée du total
function effOdds(b) {
  let odds = b.odds;
  if (b.manual) return odds;
  for (const s of b.selections) for (const mk of s.markets) if (mk.odds > 1 && marketResult(s, mk) === "void") odds /= mk.odds;
  return odds;
}

// Recopie le score final dans le pari : il reste réglé même après la sortie du match des données.
function persistScores(bets) {
  if (!state.data) return;
  for (const bet of bets) {
    let changed = false;
    const selections = bet.selections.map((s) => {
      const r = !s.score && state.data.results[s.matchId];
      if (r) { changed = true; s = { ...s, score: r }; }
      // Résultat des paris buteur, figé lui aussi
      const info = state.data.scorers?.[s.matchId];
      const ids = s.markets.filter((mk) => isScorer(mk.k)).map((mk) => scorerId(mk.k));
      if (info && ids.length && !s.scr) {
        changed = true;
        s = { ...s, scr: Object.fromEntries(ids.map((id) => [id, scorerResult(info, id)])) };
      }
      return s;
    });
    if (changed) store.update(bet.id, { selections }).catch(console.error);
  }
}

function renderBets() {
  const view = $("#view-bets");
  if (isConfigured && !state.user) {
    view.innerHTML = `<div class="card"><h2>Mes paris</h2>
      <p>Connecte-toi avec ton compte Google pour retrouver tes paris sur ton téléphone et ton PC.</p>
      <button class="btn" data-login>Se connecter avec Google</button></div>`;
    return;
  }
  const bets = state.bets.map((b) => ({ ...b, status: betStatus(b) }));
  const settled = bets.filter((b) => b.status !== "pending");
  const won = settled.filter((b) => b.status === "won");
  const lost = settled.filter((b) => b.status === "lost");
  const staked = settled.reduce((s, b) => s + b.stake, 0);
  const returned = settled.reduce((s, b) => s + betReturn(b), 0);
  const profit = returned - staked;
  const pending = bets.filter((b) => b.status === "pending");
  const sign = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
  // Évolution du portefeuille : résultat des paris réglés rapporté à l'argent que tu y as mis
  // (crédits − retraits ± corrections). Ex. 1,10 € → 1,22 € = +10,9 %.
  const w = wallet();
  const capital = w.deposits - w.withdrawals + w.adjust;
  const growth = capital > 0 ? (w.result / capital) * 100 : null;

  // Les paris en cours d'abord, puis les terminés (du plus récent au plus ancien)
  const list = bets.filter((b) => state.betFilter === "all" || (state.betFilter === "pending" ? b.status === "pending" : b.status !== "pending"))
    .sort((x, y) => (x.status !== "pending") - (y.status !== "pending"));

  view.innerHTML = `${!isConfigured ? `<div class="card small">⚠️ <b>Mode démo</b> : la synchronisation Firebase n'est pas encore configurée, tes paris seront perdus au rechargement de la page (voir README).</div>` : ""}
  <div class="card">
    <h2>Bilan</h2>
    <div class="stats-grid">
      <div class="stat"><b>${won.length} / ${won.length + lost.length}</b><span>paris gagnés</span></div>
      <div class="stat"><b>${pct(won.length, won.length + lost.length)}%</b><span>réussite</span></div>
      <div class="stat"><b class="${sign(profit)}">${profit > 0 ? "+" : ""}${fmtEur(profit)}</b><span>bénéfice</span></div>
      <div class="stat"><b>${fmtEur(staked)}</b><span>misé (réglés)</span></div>
      <div class="stat"><b class="${sign(profit)}">${staked ? `${profit > 0 ? "+" : ""}${Math.round((profit / staked) * 100)}%` : "–"}</b><span>ROI (sur les mises)</span></div>
      <div class="stat"><b class="${sign(growth ?? 0)}">${growth === null ? "–" : `${growth > 0 ? "+" : ""}${growth.toFixed(1).replace(".", ",")}%`}</b><span>évolution du portefeuille</span></div>
      <div class="stat wide"><b>${pending.length}</b><span>en cours · ${fmtEur(pending.reduce((s, b) => s + b.stake, 0))}</span></div>
    </div>
  </div>
  <div class="days">
    ${[["pending", "En cours"], ["settled", "Terminés"], ["all", "Tous"]].map(([k, l]) =>
      `<button class="chip-day ${state.betFilter === k ? "active" : ""}" data-bet-filter="${k}">${l}</button>`).join("")}
  </div>
  ${list.length ? list.map(betCard).join("") : `<p class="empty">Aucun pari ${state.betFilter === "pending" ? "en cours" : state.betFilter === "settled" ? "terminé" : ""}.</p>`}`;
}

function betCard(b) {
  const n = b.selections.length;
  const gain = betReturn(b);
  return `<div class="card">
    <div class="bet-head">
      <div><b>${n > 1 ? `Combiné × ${n}` : "Simple"}</b> <span class="muted small">· ${new Date(b.createdAt).toLocaleDateString("fr-FR")}</span></div>
      <span class="status ${b.status}">${STATUS_LABEL[b.status]}</span>
    </div>
    ${b.selections.map((s) => {
      const sc = selectionScore(s);
      return `<div class="sel"><div>
        <div class="sel-title">${esc(s.home)}${s.away ? ` – ${esc(s.away)}` : ""} ${sc ? `<span class="muted">(${sc[0]}-${sc[1]})</span>` : ""}</div>
        <div class="muted small">${fmtDate(s.kickoff)} ${fmtTime(s.kickoff)}</div>
        <div class="sel-markets">${s.markets.map((mk) => {
          const r = marketResult(s, mk);
          const [cls, icon] = { won: ["win", "✓"], lost: ["lose", "✗"], void: ["void", "↺"] }[r] || ["", "⏳"];
          return `<span class="tag ${cls}">${icon} ${esc(marketLabel(mk.k, s.home, s.away, mk.name))}${r === "void" ? " (remboursé)" : ""}${mk.odds ? ` · ${fmtOdds(mk.odds)}` : ""}</span>`;
        }).join("")}</div>
      </div></div>`;
    }).join("")}
    <div class="bet-foot">
      <span>Cote <b>${fmtOdds(b.odds)}</b> · Mise <b>${fmtEur(b.stake)}</b> · ${b.status === "pending" ? `Gain pot. <b>${fmtEur(b.stake * b.odds)}</b>` : `Retour <b>${fmtEur(gain)}</b>`}</span>
    </div>
    <div class="bet-foot">
      <select data-manual="${b.id}" aria-label="Statut">
        <option value="">${b.selections.some((s) => s.markets.some((mk) => isBoost(mk.k))) ? "À régler à la main" : "Statut automatique"}</option>
        ${["won", "lost", "void"].map((s) => `<option value="${s}" ${b.manual === s ? "selected" : ""}>Forcer : ${STATUS_LABEL[s]}</option>`).join("")}
      </select>
      <button class="link-btn" data-delete="${b.id}">Supprimer</button>
    </div>
  </div>`;
}

// ================================================================ Portefeuille et profil

const betReturn = (b) => (b.status === "won" ? b.stake * effOdds(b) : b.status === "void" ? b.stake : 0);

function wallet() {
  const sum = (type) => state.transactions.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);
  const bets = state.bets.map((b) => ({ ...b, status: betStatus(b) }));
  const staked = bets.reduce((s, b) => s + b.stake, 0);
  const returned = bets.reduce((s, b) => s + betReturn(b), 0);
  const pendingStake = bets.filter((b) => b.status === "pending").reduce((s, b) => s + b.stake, 0);
  const deposits = sum("deposit"), withdrawals = sum("withdraw"), adjust = sum("adjust");
  return {
    deposits, withdrawals, adjust, pendingStake,
    result: returned - (staked - pendingStake),   // gains/pertes des paris réglés
    balance: deposits - withdrawals + adjust - staked + returned,
  };
}
const balance = () => wallet().balance;

function renderWallet() {
  const box = $("#user-box");
  if (isConfigured && !state.user) { box.innerHTML = ""; return; }
  const b = balance();
  box.innerHTML = `<button class="wallet ${b < 0 ? "neg" : ""}" data-view="profile" title="Mon profil et mon portefeuille">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7l12-4v4"/><circle cx="16.5" cy="13.5" r="1.2" fill="currentColor"/></svg>
    ${fmtEur(b)}</button>`;
}

function renderProfile() {
  const view = $("#view-profile");
  const w = wallet();
  const u = state.user;
  const sign = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
  const plus = (v) => `${v > 0 ? "+" : ""}${fmtEur(v)}`;
  view.innerHTML = `<div class="card profile-head">
    ${u?.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : ""}
    <div><b>${esc(u?.displayName || "Mode démo")}</b><div class="muted small">${esc(u?.email || "Paris non sauvegardés")}</div></div>
    ${u ? `<button class="link-btn" data-logout>Se déconnecter</button>` : ""}
  </div>
  <div class="card">
    <h2>Mon portefeuille</h2>
    <div class="wallet-balance ${w.balance < 0 ? "neg" : ""}">${fmtEur(w.balance)}</div>
    <div class="stats-grid">
      <div class="stat"><b>${fmtEur(w.deposits)}</b><span>crédité</span></div>
      <div class="stat"><b>${fmtEur(w.withdrawals)}</b><span>retiré</span></div>
      <div class="stat"><b class="${sign(w.result)}">${plus(w.result)}</b><span>résultat des paris</span></div>
    </div>
    <p class="hint">Solde = crédits − retraits − mises + gains${w.adjust ? ` (dont ${plus(w.adjust)} de corrections)` : ""}.
      ${w.pendingStake ? `${fmtEur(w.pendingStake)} actuellement en jeu.` : ""}</p>
    <label class="field" style="margin-top:12px">Montant (€)
      <input id="tx-amount" inputmode="decimal" placeholder="ex. 50">
    </label>
    <div class="grid2" style="margin-top:10px">
      <button class="btn" data-tx="deposit">Créditer</button>
      <button class="btn dark" data-tx="withdraw">Retirer</button>
    </div>
    <button class="btn secondary" data-tx="adjust" style="margin-top:8px">Corriger le solde</button>
  </div>
  <div class="card">
    <h2>Historique des crédits et retraits</h2>
    ${state.transactions.length ? state.transactions.map((t) => `<div class="tx">
      <div><b>${TX_LABEL[t.type]}</b><div class="muted small">${new Date(t.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })} · ${new Date(t.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</div></div>
      <b class="${t.type === "withdraw" || t.amount < 0 ? "neg" : "pos"}">${t.type === "withdraw" ? "−" : t.amount > 0 ? "+" : "−"}${fmtEur(Math.abs(t.amount))}</b>
      <button class="rm" data-tx-delete="${t.id}" aria-label="Supprimer">✕</button>
    </div>`).join("") : `<p class="muted small">Aucun mouvement pour l'instant. Commence par créditer ton portefeuille.</p>`}
  </div>
  ${ownerToolsHTML()}`;
}

async function addTransaction(type) {
  const amount = parseNum($("#tx-amount").value);
  if (type === "adjust") {
    if (!Number.isFinite(amount)) return toast("Indique le solde souhaité");
    const delta = Math.round((amount - balance()) * 100) / 100;
    if (!delta) return toast("Le solde est déjà à ce montant");
    await store.addTransaction({ type, amount: delta });
    return toast(`Solde corrigé à ${fmtEur(amount)}`);
  }
  if (!(amount > 0)) return toast("Indique un montant");
  if (type === "withdraw" && amount > balance() && !confirm("Ce retrait dépasse ton solde. Continuer ?")) return;
  await store.addTransaction({ type, amount });
  toast(type === "deposit" ? `${fmtEur(amount)} crédités` : `${fmtEur(amount)} retirés`);
}

function renderAccount() { renderWallet(); renderProfile(); }

// ================================================================ Retours pour Claude (profil du propriétaire)

const OWNER = "anthony.chev@gmail.com";
const isOwner = () => !isConfigured || state.user?.email === OWNER;

function ownerToolsHTML() {
  if (!isOwner()) return "";
  return `<div class="card">
    <h2>Fiabilité de mes avis</h2>
    <p class="hint">Je rejoue mes avis sur tous les matchs terminés de la saison, chacun avec les seuls matchs joués avant lui,
      et je compare mes chances annoncées aux vrais résultats.</p>
    <div id="reliability">${state.reliability ? reliabilityHTML(state.reliability) : `<button class="btn secondary" data-reliability>Calculer la fiabilité</button>`}</div>
  </div>
  <div class="card">
    <h2>Retours pour Claude</h2>
    <p class="hint">Copie tous tes paris (cotes, mises, sélections, résultats) puis colle-les dans ta conversation avec Claude
      en écrivant « fais le bilan ».</p>
    <button class="btn" data-export-bets>Copier mes paris pour Claude</button>
    <textarea id="export-box" class="export-box" readonly hidden></textarea>
  </div>`;
}

const emptyReplayStats = () => ({ n: 0, gf: 0, ga: 0, btts: 0, o15: 0, o25: 0, f2: 0, a2: 0, xf: 0, xa: 0, nx: 0 });

async function computeReliability() {
  const r = await fetch(`data/cache.json?t=${Date.now()}`);
  const matches = Object.values((await r.json()).matches).sort((x, y) => (x.t < y.t ? -1 : 1));
  const stats = new Map();
  const get = (id) => {
    if (!stats.has(id)) stats.set(id, { all: emptyReplayStats(), home: emptyReplayStats(), away: emptyReplayStats() });
    return stats.get(id);
  };
  const blank = () => ({ n: 0, won: 0, sumP: 0 });
  const season = Object.fromEntries(ALL_MARKETS.map((k) => [k, blank()]));
  const withOdds = Object.fromEntries(ALL_MARKETS.map((k) => [k, blank()]));
  // Paris simples à cote proche de 2 que j'aurais suggérés (cotes Unibet d'avant-match connues)
  const singles = { ...blank(), staked: 0, returned: 0 };
  let replayed = 0, oddsMatches = 0;
  for (const m of matches) {
    const hg = m.g.filter((g) => g[1]).length, ag = m.g.length - hg;
    const H = get(m.h), A = get(m.a);
    const est = estimateFrom(H, A, m.o);
    if (est) {
      replayed++;
      if (m.o) oddsMatches++;
      for (const k of ALL_MARKETS) {
        const won = marketWon(k, [hg, ag]);
        if (level(est[k], k) === "yes" && !doubtfulOdds(m.o, est, k)) {
          for (const bucket of m.o ? [season[k], withOdds[k]] : [season[k]]) { bucket.n++; bucket.won += won; bucket.sumP += est[k]; }
        }
        const o = m.o?.[k];
        if (o >= TARGET_ODDS[0] && o <= TARGET_ODDS[1] && est[k] >= 0.5 && !doubtfulOdds(m.o, est, k)) {
          singles.n++; singles.won += won; singles.sumP += est[k]; singles.staked += 1; singles.returned += won ? o : 0;
        }
      }
    }
    for (const [side, s, own, opp, x] of [["home", H, hg, ag, m.x], ["away", A, ag, hg, m.x && [m.x[1], m.x[0]]]]) {
      for (const st of [s.all, s[side]]) {
        st.n++; st.gf += own; st.ga += opp; st.btts += hg > 0 && ag > 0; st.o15 += hg + ag >= 2; st.o25 += hg + ag >= 3;
        st.f2 += own >= 2; st.a2 += opp >= 2;
        if (x) { st.xf += x[0]; st.xa += x[1]; st.nx++; }
      }
    }
  }
  return { season, withOdds, singles, replayed, oddsMatches, total: matches.length, at: Date.now() };
}

function reliabilityHTML(r) {
  const names = { btts: "BTTS", o15: "+1,5 buts", o25: "+2,5 buts", h15: "Domicile +1,5", a15: "Extérieur +1,5" };
  const rows = (src) => ALL_MARKETS.map((k) => {
    const b = src[k];
    return `<div class="t">${names[k]}</div><div class="v">${b.n}</div>
      <div class="v">${b.n ? `${Math.round((b.sumP / b.n) * 100)}%` : "–"}</div>
      <div class="v">${b.n ? pctSpan(Math.round((b.won / b.n) * 100)) : "–"}</div>`;
  }).join("");
  const table = (src) => `<div class="rel-table"><div class="h" style="text-align:left">« Je miserais »</div><div class="h">Paris</div><div class="h">Annoncé</div><div class="h">Réel</div>${rows(src)}</div>`;
  const s = r.singles;
  const roi = s.staked ? ((s.returned - s.staked) / s.staked) * 100 : null;
  return `<p class="small"><b>Toute la saison</b> · ${r.replayed} matchs rejoués (mes stats seules : les cotes d'avant-match n'étaient pas encore enregistrées)</p>
    ${table(r.season)}
    <p class="small" style="margin-top:14px"><b>Avec la cote Unibet d'avant-match</b> · ${r.oddsMatches} matchs depuis le 29 octobre (le vrai test de l'app actuelle)</p>
    ${r.oddsMatches ? table(r.withOdds) : `<p class="muted small">Pas encore de match terminé avec sa cote enregistrée.</p>`}
    <p class="small" style="margin-top:14px"><b>Paris simples à cote proche de 2</b> (comme mes suggestions) :
      ${s.n ? `${s.n} paris, ${pctSpan(Math.round((s.won / s.n) * 100))} gagnés pour ${Math.round((s.sumP / s.n) * 100)}% annoncés ·
        <b class="${roi >= 0 ? "pos" : "neg"}">${roi >= 0 ? "+" : ""}${Math.round(roi)}%</b> de rentabilité` : "pas encore assez de matchs avec cote."}</p>
    <p class="hint">« Annoncé » = mes chances moyennes, « Réel » = part des paris gagnés. Les deux doivent être proches.
      Les buteurs ne sont pas encore rejoués. Calculé le ${new Date(r.at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}.</p>
    <button class="link-btn" data-reliability>Recalculer</button>`;
}

// Export texte de tous les paris, à coller dans la conversation avec Claude
function exportBets() {
  const lines = state.bets.map((b) => {
    const st = betStatus(b);
    return {
      date: new Date(b.createdAt).toISOString().slice(0, 10), statut: STATUS_LABEL[st], cote: b.odds, mise: b.stake,
      retour: Math.round(betReturn({ ...b, status: st }) * 100) / 100, force: b.manual || undefined,
      selections: b.selections.map((s) => ({
        match: `${s.home} - ${s.away}`, coup_envoi: s.kickoff, score: selectionScore(s)?.join("-") ?? null,
        paris: s.markets.map((mk) => ({ marche: marketLabel(mk.k, s.home, s.away, mk.name), cote: mk.odds, resultat: marketResult(s, mk) })),
      })),
    };
  });
  const w = wallet();
  return `Pronos Foot · export du ${new Date().toLocaleString("fr-FR")} · solde ${fmtEur(w.balance)}\n${JSON.stringify(lines)}`;
}

// ================================================================ Navigation et événements

function showView(v) {
  state.view = v;
  renderSlipBar();
  document.querySelectorAll(".view").forEach((el) => (el.hidden = el.id !== `view-${v}`));
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  window.scrollTo(0, 0);
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (d.view) showView(d.view);
  else if (d.day !== undefined) {
    state.day = Number(d.day);
    document.querySelectorAll(".chip-day[data-day]").forEach((b) => b.classList.toggle("active", b === t));
    renderMatches();
  } else if (d.comp) { state.comp = d.comp === "all" ? "all" : Number(d.comp); renderMatches(); }
  else if (d.toggle) {
    state.closed.has(d.toggle) ? state.closed.delete(d.toggle) : state.closed.add(d.toggle);
    renderMatches();
  } else if (d.mode) { state.mode[d.id] = d.mode; renderMatches(); }
  else if (d.pick) {
    const set = state.slip.get(d.id) || new Set();
    set.has(d.pick) ? set.delete(d.pick) : set.add(d.pick);
    set.size ? state.slip.set(d.id, set) : state.slip.delete(d.id);
    state.slipOdds = null;
    renderMatches();
    renderSlip();
  } else if (d.unpick) {
    const set = state.slip.get(d.id);
    set?.delete(d.unpick);
    if (!set?.size) state.slip.delete(d.id);
    state.slipOdds = null;
    renderSlip();
    renderMatches();
  } else if (d.combo !== undefined) {
    const c = state.combos[Number(d.combo)];
    state.slip.clear();
    c.legs.forEach((l) => state.slip.set(l.m.id, new Set([l.k])));
    state.slipOdds = null;
    renderSlip(); renderMatches(); $("#slip-sheet").showModal();
    toast(c.legs.length > 1 ? "Combiné ajouté au bulletin" : "Pari ajouté au bulletin");
  } else if (d.boost !== undefined) {
    saveBoost(d.boost);
  } else if (t.id === "clear-slip") {
    state.slip.clear(); state.slipOdds = null; renderSlip(); renderMatches();
  } else if (t.id === "save-bet") saveBet();
  else if (t.id === "refresh-odds") refreshOdds();
  else if (d.betFilter) { state.betFilter = d.betFilter; renderBets(); }
  else if (d.openSlip !== undefined) $("#slip-sheet").showModal();
  else if (d.closeSlip !== undefined) $("#slip-sheet").close();
  else if (d.legend !== undefined) $("#legend").showModal();
  else if (d.reliability !== undefined) {
    $("#reliability").innerHTML = `<p class="muted small">Calcul en cours…</p>`;
    computeReliability().then((r) => { state.reliability = r; renderProfile(); })
      .catch((err) => { console.error(err); $("#reliability").innerHTML = `<p class="neg">Calcul impossible, réessaie.</p>`; });
  } else if (d.exportBets !== undefined) {
    const text = exportBets();
    const box = $("#export-box");
    navigator.clipboard.writeText(text).then(() => toast("Paris copiés : colle-les dans Claude"))
      .catch(() => { box.hidden = false; box.value = text; box.select(); toast("Sélectionne le texte et copie-le"); });
  }
  else if (d.closeLegend !== undefined) $("#legend").close();
  else if (d.tx) addTransaction(d.tx).catch((err) => { console.error(err); toast(`Erreur d'enregistrement (${err.code || err.message})`); });
  else if (d.txDelete) { if (confirm("Supprimer ce mouvement ?")) store.removeTransaction(d.txDelete); }
  else if (d.delete) { if (confirm("Supprimer ce pari ?")) store.remove(d.delete); }
  else if (d.login !== undefined) store.login().catch((err) => toast(err.code === "auth/popup-closed-by-user" ? "Connexion annulée" : "Connexion impossible"));
  else if (d.logout !== undefined) { if (confirm("Se déconnecter ?")) store.logout(); }
});

// Un clic sur le fond assombri ferme la légende
document.addEventListener("click", (e) => { if (e.target.id === "legend" || e.target.id === "slip-sheet") e.target.close(); });

document.addEventListener("input", (e) => {
  if (e.target.id === "slip-odds") state.slipOdds = e.target.value;
  if (e.target.id === "slip-stake") state.slipStake = e.target.value;
  if (e.target.id === "slip-odds" || e.target.id === "slip-stake") {
    const g = parseNum($("#slip-odds").value) * parseNum($("#slip-stake").value);
    $("#slip-gain").textContent = Number.isFinite(g) ? fmtEur(g) : "–";
    $("#stake-warn").hidden = !(parseNum($("#slip-stake").value) > balance());
    renderSlipBar();
  }
});

document.addEventListener("toggle", (e) => {
  if (e.target.classList?.contains("boosts")) state.boostsOpen = e.target.open;
  else if (e.target.classList?.contains("combos")) state.combosOpen = e.target.open;
}, true);

document.addEventListener("change", (e) => {
  if (e.target.dataset.manual) store.update(e.target.dataset.manual, { manual: e.target.value || null });
});

// ================================================================ Démarrage

async function main() {
  // Avec Firebase configuré, toute l'app est réservée aux utilisateurs connectés
  if (isConfigured) document.body.classList.add("auth-pending");
  onUser((u) => {
    state.user = u?.demo ? null : u;
    document.body.classList.remove("auth-pending");
    document.body.classList.toggle("locked", isConfigured && !state.user);
    renderAccount(); renderSlip(); renderBets();
  });
  onBets((bets) => { state.bets = bets; persistScores(bets); renderBets(); renderAccount(); if (state.data) { renderMatches(); renderSlip(); } });
  onTransactions((txs) => { state.transactions = txs; renderAccount(); if (state.data) renderSlip(); });
  const storeReady = initStore().catch((e) => {
    console.error(e);
    document.body.classList.replace("auth-pending", "locked");
    toast("Connexion indisponible, réessaie dans un instant");
  });

  try {
    const r = await fetch(`data/matches.json?t=${Date.now()}`);
    state.data = await r.json();
  } catch (e) {
    $("#matches").innerHTML = `<p class="empty">Impossible de charger les matchs. Réessaie dans un instant.</p>`;
    return;
  }
  renderUpdated();
  renderMatches();
  renderSlip();
  await storeReady;
  renderBets();
  persistScores(state.bets);
}

main();
