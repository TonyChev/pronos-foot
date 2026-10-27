import { initStore, store, onBets, onTransactions, onUser, isConfigured } from "./store.js?v=202610271602";

const MARKETS = { btts: "Les 2 équipes marquent", o25: "Plus de 2,5 buts" };
const SHORT = { btts: "Les 2 marquent", o25: "+2,5 buts" };
const KAMBI = "https://eu-offering-api.kambicdn.com/offering/v2018/ub";
const STATUS_LABEL = { won: "Gagné", lost: "Perdu", pending: "En cours", void: "Remboursé" };
const TX_LABEL = { deposit: "Crédit", withdraw: "Retrait", adjust: "Correction du solde" };
const QUICK_STAKES = [2, 5, 10, 20];

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

  // Ordre chronologique, toutes compétitions mélangées
  const shown = all
    .filter((m) => state.comp === "all" || state.comp === m.c)
    .sort((x, y) => new Date(x.t) - new Date(y.t) || order.indexOf(x.c) - order.indexOf(y.c));
  if (!shown.length) {
    $("#matches").innerHTML = `<p class="empty">Aucun match ${state.day ? "demain" : "aujourd'hui"} dans tes compétitions.</p>`;
    return;
  }
  $("#matches").innerHTML = shown.map(matchCard).join("");
}

// ================================================================ Combinés suggérés

function renderCombos() {
  const days = [0, 1].map((d) => { const x = new Date(); x.setDate(x.getDate() + d); return localDay(x); });
  // Matchs déjà joués dans un pari en cours : on ne les repropose pas
  const taken = new Set(state.bets.filter((b) => betStatus(b) === "pending").flatMap((b) => b.selections.map((s) => s.matchId)));
  const picks = state.data.matches
    .filter((m) => !m.started && !m.finished && new Date(m.t) > Date.now() && days.includes(localDay(new Date(m.t))) && !taken.has(m.id))
    .map(bestPick)
    .filter((p) => p && p.p >= MAYBE);
  const pairs = [];
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      pairs.push({ legs: [picks[i], picks[j]].sort((x, y) => new Date(x.m.t) - new Date(y.m.t)), p: picks[i].p * picks[j].p });
    }
  }
  // Les plus sûrs d'abord, chaque match n'apparaît que dans une seule suggestion
  const used = new Set();
  state.combos = [];
  for (const c of pairs.sort((x, y) => y.p - x.p)) {
    if (c.legs.some((l) => used.has(l.m.id))) continue;
    c.legs.forEach((l) => used.add(l.m.id));
    state.combos.push(c);
    if (state.combos.length === 4) break;
  }
  const dayLabel = (iso) => (localDay(new Date(iso)) === days[0] ? "Auj." : "Demain");
  $("#combos").innerHTML = `<details class="card combos" ${state.combosOpen ? "open" : ""}>
    <summary><h2>Mes combinés suggérés (${state.combos.length})</h2></summary>
    <p class="hint">Combinés de 2 matchs d'aujourd'hui et de demain, classés par chances que les 2 sélections passent.
      Les matchs déjà dans un pari en cours sont exclus.</p>
    ${state.combos.length ? state.combos.map((c, i) => `<div class="combo">
      ${c.legs.map((l) => `<div class="combo-leg">
        <span class="muted small">${dayLabel(l.m.t)} ${fmtTime(l.m.t)} · ${comp(l.m.c).flag} ${esc(comp(l.m.c).name)}</span>
        <span><b>${esc(team(l.m.h).name)} – ${esc(team(l.m.a).name)}</b></span>
        <span>${SHORT[l.k]} · ${pctSpan(Math.round(l.p * 100))} · cote ${fmtOdds(l.odds)}</span>
      </div>`).join("")}
      <div class="combo-foot">
        <span>Les 2 passent : ${pctSpan(Math.round(c.p * 100))} · cote ≈ <b>${fmtOdds(c.legs[0].odds * c.legs[1].odds)}</b></span>
        <button class="chip active" data-combo="${i}">Au bulletin</button>
      </div>
    </div>`).join("") : `<p class="muted small">Aucun match assez sûr pour l'instant.</p>`}
  </details>`;
}

function matchCard(m) {
  const h = team(m.h), a = team(m.a);
  const c = comp(m.c);
  const open = !state.closed.has(m.id);
  const [hs, as] = (m.score || "").split(" - ");
  let ko = `<div class="kickoff">${fmtTime(m.t)}</div>`;
  if (m.finished) ko = `<div class="kickoff">Terminé</div>`;
  else if (m.started) ko = `<div class="kickoff live">${esc(m.live || "En cours")}</div>`;
  const picked = state.slip.get(m.id) || new Set();
  const locked = m.started || m.finished;
  const hint = (k) => {
    const S = [h.stats.all, a.stats.all];
    const n = S[0].n + S[1].n;
    return n ? pct(S[0][k] + S[1][k], n) : null;
  };
  const oddBtn = (k) => {
    const o = m.odds?.[k];
    const p = hint(k);
    return `<button class="odd ${picked.has(k) ? "picked" : ""}" data-pick="${k}" data-id="${m.id}" ${!o || locked ? "disabled" : ""}
      title="${MARKETS[k]} — taux de la saison des 2 équipes : ${p ?? "–"}%">
      <span>${SHORT[k]} ${p === null ? "" : pctSpan(p, "pct")}</span><b>${fmtOdds(o)}</b></button>`;
  };
  return `<article class="match ${open ? "open" : ""}" data-match="${m.id}">
    <div class="match-comp"><img src="${compLogo(m.c)}" alt="" loading="lazy">${c.flag} ${esc(c.name)} <span class="muted">· ${esc(c.country)}</span></div>
    <button class="match-head" data-toggle="${m.id}" aria-expanded="${open}">
      ${ko}
      <div class="teams">
        <div><img src="${teamLogo(m.h)}" alt="" loading="lazy">${esc(h.name)}</div>
        <div><img src="${teamLogo(m.a)}" alt="" loading="lazy">${esc(a.name)}</div>
      </div>
      <div class="score">${m.score ? `<span>${esc(hs)}</span><span>${esc(as)}</span>` : ""}</div>
      <span class="chev">▾</span>
    </button>
    <div class="odds-row">${oddBtn("btts")}${oddBtn("o25")}</div>
    ${locked ? "" : verdictHTML(m)}
    ${open ? distHTML(m) : ""}
  </article>`;
}

// 50 % ou plus en vert, moins de 50 % en rouge
const pctSpan = (p, cls = "") => `<span class="${cls} ${p >= 50 ? "good" : "bad"}">${p}%</span>`;

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

function estimate(m) {
  const H = team(m.h).stats, A = team(m.a).stats;
  if (H.all.n < 4 || A.all.n < 4) return null;
  // Buts attendus : attaque de l'un croisée avec la défense de l'autre (loi de Poisson)
  const lh = (rate(H.home, H.all, "gf") + rate(A.away, A.all, "ga")) / 2;
  const la = (rate(A.away, A.all, "gf") + rate(H.home, H.all, "ga")) / 2;
  const poisBtts = (1 - Math.exp(-lh)) * (1 - Math.exp(-la));
  const poisO25 = 1 - [0, 1, 2].reduce((s, k) => s + poisson(lh + la, k), 0);
  // Mélange avec les fréquences réellement observées cette saison
  const freq = (k) => (H.all[k] + A.all[k]) / (H.all.n + A.all.n);
  return {
    lh, la,
    btts: 0.6 * poisBtts + 0.4 * freq("btts"),
    o25: 0.6 * poisO25 + 0.4 * freq("o25"),
  };
}

// L'avis ne regarde que la probabilité : en combiné, une cote basse sur un match reste utile.
const YES = 0.68, MAYBE = 0.6;
const level = (p) => (p >= YES ? "yes" : p >= MAYBE ? "maybe" : "no");

// Meilleur marché d'un match (le plus probable) parmi ceux qui ont une cote Unibet
function bestPick(m) {
  const est = estimate(m);
  if (!est) return null;
  const k = ["btts", "o25"].filter((x) => m.odds?.[x]).sort((x, y) => est[y] - est[x])[0];
  return k ? { m, k, p: est[k], odds: m.odds[k] } : null;
}

function verdictHTML(m) {
  const est = estimate(m);
  if (!est) {
    return `<div class="verdict no"><b>Mon avis : je ne miserais pas</b><span>Pas assez de matchs joués cette saison pour juger.</span></div>`;
  }
  const best = est.btts >= est.o25 ? "btts" : "o25";
  const lv = level(est[best]);
  const title = {
    yes: `je miserais sur « ${SHORT[best]} »`,
    maybe: `jouable sur « ${SHORT[best]} », sans plus`,
    no: "je ne miserais pas",
  }[lv];
  const line = (k) => {
    const p = Math.round(est[k] * 100);
    const o = m.odds?.[k];
    const tag = `<i class="dot ${level(est[k])}"></i>`;
    return `<span>${tag} ${SHORT[k]} : ${pctSpan(p)} de chances selon moi${o ? ` · cote ${fmtOdds(o)}` : " · pas de cote"}</span>`;
  };
  return `<div class="verdict ${lv}">
    <b>Mon avis : ${title}</b>
    ${line("btts")}${line("o25")}
    <span class="muted">Buts attendus : ${est.lh.toFixed(1).replace(".", ",")} – ${est.la.toFixed(1).replace(".", ",")} · avis statistique, pas une garantie</span>
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
    <div class="v">${s.n ? pctSpan(pct(s.btts, s.n)) : "–"}</div><div class="v">${s.n ? pctSpan(pct(s.o25, s.n)) : "–"}</div>`;
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
      <div class="h" style="text-align:left">Sur ${mode === "all" ? "la saison" : "dom. / ext."}</div><div class="h">Buts/match</div><div class="h">BTTS</div><div class="h">+2,5</div>
      ${kpi(m.h, H.name, hs)}${kpi(m.a, A.name, as)}
    </div>
  </div>`;
}

function renderUpdated() {
  const g = new Date(state.data.generatedAt);
  const min = Math.round((Date.now() - g) / 60000);
  const ago = min < 60 ? `${min} min` : `${Math.round(min / 60)} h`;
  $("#updated").textContent = `Données mises à jour il y a ${ago} · cotes Unibet · touche un match pour replier ses stats`;
}

// ================================================================ Cotes en direct (Kambi / Unibet)

function extractOdds(offers) {
  const odds = {};
  for (const b of offers) {
    const label = b.criterion?.englishLabel;
    for (const o of b.outcomes || []) {
      if (!o.odds || (o.status && o.status !== "OPEN")) continue;
      if (label === "Both Teams To Score" && o.englishLabel === "Yes") odds.btts = o.odds / 1000;
      if (label === "Total Goals" && o.englishLabel === "Over" && o.line === 2500) odds.o25 = o.odds / 1000;
    }
  }
  return odds;
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
        const odds = extractOdds((await r.json()).betOffers || []);
        if (Object.keys(odds).length) { m.odds = odds; ok++; }
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
    return { m, markets: [...set].map((k) => ({ k, odds: m.odds?.[k] ?? null })) };
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
  $("#slip-count").hidden = !count;
  $("#slip-count").textContent = count;
  renderSlipBar(sels, count);
  const view = $("#view-slip");
  if (!count) {
    view.innerHTML = `<p class="empty">Ton bulletin est vide.<br>Dans l'onglet <b>Matchs</b>, touche une cote
      « Les 2 marquent » ou « +2,5 buts » pour l'ajouter.</p>`;
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
        <div class="sel-markets">${markets.map((mk) => `<span class="tag">${MARKETS[mk.k]} <b>${fmtOdds(mk.odds)}</b>
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
    <div class="quick-stakes">${QUICK_STAKES.map((v) => `<button class="chip" data-stake="${v}">${v} €</button>`).join("")}</div>
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
    <button class="btn" data-view="slip">${count > 1 ? "Créer le combiné" : "Créer le pari"}</button>`;
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
    showView("bets");
  } catch (e) {
    console.error(e);
    toast(`Erreur d'enregistrement (${e.code || e.message})`);
    btn.disabled = false;
  }
}

// ================================================================ Mes paris

const marketWon = (k, [hg, ag]) => (k === "btts" ? hg > 0 && ag > 0 : hg + ag >= 3);

function selectionScore(sel) {
  return sel.score || state.data?.results?.[sel.matchId] || null;
}

function selectionStatus(sel) {
  const sc = selectionScore(sel);
  if (!sc) return "pending";
  return sel.markets.every((mk) => marketWon(mk.k, sc)) ? "won" : "lost";
}

function betStatus(bet) {
  if (bet.manual) return bet.manual;
  const st = bet.selections.map(selectionStatus);
  if (st.includes("lost")) return "lost";
  return st.every((s) => s === "won") ? "won" : "pending";
}

// Recopie le score final dans le pari : il reste réglé même après la sortie du match des données.
function persistScores(bets) {
  if (!state.data) return;
  for (const bet of bets) {
    let changed = false;
    const selections = bet.selections.map((s) => {
      const r = !s.score && state.data.results[s.matchId];
      if (r) { changed = true; return { ...s, score: r }; }
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
  const returned = settled.reduce((s, b) => s + (b.status === "won" ? b.stake * b.odds : b.status === "void" ? b.stake : 0), 0);
  const profit = returned - staked;
  const pending = bets.filter((b) => b.status === "pending");
  const sign = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");

  const list = bets.filter((b) => state.betFilter === "all" || (state.betFilter === "pending" ? b.status === "pending" : b.status !== "pending"));

  view.innerHTML = `${!isConfigured ? `<div class="card small">⚠️ <b>Mode démo</b> : la synchronisation Firebase n'est pas encore configurée, tes paris seront perdus au rechargement de la page (voir README).</div>` : ""}
  <div class="card">
    <h2>Bilan</h2>
    <div class="stats-grid">
      <div class="stat"><b>${won.length} / ${won.length + lost.length}</b><span>paris gagnés</span></div>
      <div class="stat"><b>${pct(won.length, won.length + lost.length)}%</b><span>réussite</span></div>
      <div class="stat"><b class="${sign(profit)}">${profit > 0 ? "+" : ""}${fmtEur(profit)}</b><span>bénéfice</span></div>
      <div class="stat"><b>${fmtEur(staked)}</b><span>misé (réglés)</span></div>
      <div class="stat"><b class="${sign(profit)}">${staked ? `${profit > 0 ? "+" : ""}${Math.round((profit / staked) * 100)}%` : "–"}</b><span>ROI</span></div>
      <div class="stat"><b>${pending.length}</b><span>en cours · ${fmtEur(pending.reduce((s, b) => s + b.stake, 0))}</span></div>
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
  const gain = b.status === "won" ? b.stake * b.odds : b.status === "void" ? b.stake : 0;
  return `<div class="card">
    <div class="bet-head">
      <div><b>${n > 1 ? `Combiné × ${n}` : "Simple"}</b> <span class="muted small">· ${new Date(b.createdAt).toLocaleDateString("fr-FR")}</span></div>
      <span class="status ${b.status}">${STATUS_LABEL[b.status]}</span>
    </div>
    ${b.selections.map((s) => {
      const sc = selectionScore(s);
      return `<div class="sel"><div>
        <div class="sel-title">${esc(s.home)} – ${esc(s.away)} ${sc ? `<span class="muted">(${sc[0]}-${sc[1]})</span>` : ""}</div>
        <div class="muted small">${fmtDate(s.kickoff)} ${fmtTime(s.kickoff)}</div>
        <div class="sel-markets">${s.markets.map((mk) => {
          const cls = sc ? (marketWon(mk.k, sc) ? "win" : "lose") : "";
          return `<span class="tag ${cls}">${sc ? (marketWon(mk.k, sc) ? "✓" : "✗") : "⏳"} ${MARKETS[mk.k]}${mk.odds ? ` · ${fmtOdds(mk.odds)}` : ""}</span>`;
        }).join("")}</div>
      </div></div>`;
    }).join("")}
    <div class="bet-foot">
      <span>Cote <b>${fmtOdds(b.odds)}</b> · Mise <b>${fmtEur(b.stake)}</b> · ${b.status === "pending" ? `Gain pot. <b>${fmtEur(b.stake * b.odds)}</b>` : `Retour <b>${fmtEur(gain)}</b>`}</span>
    </div>
    <div class="bet-foot">
      <select data-manual="${b.id}" aria-label="Statut">
        <option value="">Statut automatique</option>
        ${["won", "lost", "void"].map((s) => `<option value="${s}" ${b.manual === s ? "selected" : ""}>Forcer : ${STATUS_LABEL[s]}</option>`).join("")}
      </select>
      <button class="link-btn" data-delete="${b.id}">Supprimer</button>
    </div>
  </div>`;
}

// ================================================================ Portefeuille et profil

const betReturn = (b) => (b.status === "won" ? b.stake * b.odds : b.status === "void" ? b.stake : 0);

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
  </div>`;
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
    renderSlip(); renderMatches(); showView("slip");
    toast("Combiné ajouté au bulletin");
  } else if (t.id === "clear-slip") {
    state.slip.clear(); state.slipOdds = null; renderSlip(); renderMatches();
  } else if (t.id === "save-bet") saveBet();
  else if (t.id === "refresh-odds") refreshOdds();
  else if (d.betFilter) { state.betFilter = d.betFilter; renderBets(); }
  else if (d.stake) {
    state.slipStake = d.stake;
    $("#slip-stake").value = d.stake;
    $("#slip-stake").dispatchEvent(new Event("input", { bubbles: true }));
  } else if (d.tx) addTransaction(d.tx).catch((err) => { console.error(err); toast(`Erreur d'enregistrement (${err.code || err.message})`); });
  else if (d.txDelete) { if (confirm("Supprimer ce mouvement ?")) store.removeTransaction(d.txDelete); }
  else if (d.delete) { if (confirm("Supprimer ce pari ?")) store.remove(d.delete); }
  else if (d.login !== undefined) store.login().catch((err) => toast(err.code === "auth/popup-closed-by-user" ? "Connexion annulée" : "Connexion impossible"));
  else if (d.logout !== undefined) { if (confirm("Se déconnecter ?")) store.logout(); }
});

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
  if (e.target.classList?.contains("combos")) state.combosOpen = e.target.open;
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
