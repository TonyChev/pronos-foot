// Stockage des paris et des mouvements du portefeuille :
// Firestore (synchronisé entre appareils) ou, à défaut, en mémoire (mode démo).
import { firebaseConfig } from "./firebase-config.js?v=202611081400";

const FB = "https://www.gstatic.com/firebasejs/10.12.2";
const COLLECTIONS = ["bets", "transactions"];

export const isConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

// Collections partagées entre joueurs connectés (classement Freebet) :
// funbets = paris Freebet de tous les joueurs (lecture pour tous, écriture par leur auteur), players = pseudos
const SHARED = ["funbets", "players"];
const listeners = Object.fromEntries([...COLLECTIONS, ...SHARED].map((c) => [c, []]));
const userListeners = [];
const settingsListeners = [];
let api = null;

function emit(name, docs) { listeners[name].forEach((fn) => fn(docs)); }
function emitUser(user) { userListeners.forEach((fn) => fn(user)); }
function emitSettings(s) { settingsListeners.forEach((fn) => fn(s)); }

export function onBets(fn) { listeners.bets.push(fn); }
export function onTransactions(fn) { listeners.transactions.push(fn); }
export function onFunBets(fn) { listeners.funbets.push(fn); }
export function onPlayers(fn) { listeners.players.push(fn); }
export function onUser(fn) { userListeners.push(fn); }
export function onSettings(fn) { settingsListeners.push(fn); }

// ---------------------------------------------------------------- mode démo
function memoryStore() {
  const data = Object.fromEntries([...COLLECTIONS, ...SHARED].map((c) => [c, []]));
  let n = 0;
  let settings = {};
  const publish = (name) => emit(name, [...data[name]].sort((a, b) => b.createdAt - a.createdAt));
  setTimeout(() => { emitUser({ demo: true, uid: "demo", displayName: "Mode démo" }); [...COLLECTIONS, ...SHARED].forEach(publish); });
  return {
    uid: () => "demo",
    async add(name, doc) { data[name].push({ ...doc, ...(name === "funbets" ? { uid: "demo" } : {}), id: `demo-${++n}`, createdAt: Date.now() }); publish(name); },
    async setPlayer(doc) { data.players = [...data.players.filter((p) => p.id !== "demo"), { ...doc, id: "demo" }]; publish("players"); },
    async update(name, id, patch) { data[name] = data[name].map((d) => (d.id === id ? { ...d, ...patch } : d)); publish(name); },
    async remove(name, id) { data[name] = data[name].filter((d) => d.id !== id); publish(name); },
    async saveSettings(patch) { settings = { ...settings, ...patch }; emitSettings(settings); },
    async login() {},
    async logout() {},
  };
}

// ---------------------------------------------------------------- Firebase
async function firebaseStore() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-auth.js`),
    import(`${FB}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const a = auth.getAuth(app);
  const db = fs.getFirestore(app);
  let unsubs = [];
  let uid = null;

  auth.onAuthStateChanged(a, (user) => {
    uid = user?.uid ?? null;
    emitUser(user);
    unsubs.forEach((u) => u());
    unsubs = [];
    if (!user) { [...COLLECTIONS, ...SHARED].forEach((c) => emit(c, [])); emitSettings({}); return; }
    unsubs.push(fs.onSnapshot(fs.doc(db, "users", uid, "settings", "prefs"),
      (snap) => emitSettings(snap.data() || {}), (err) => console.error(err)));
    for (const name of COLLECTIONS) {
      const q = fs.query(fs.collection(db, "users", uid, name), fs.orderBy("createdAt", "desc"));
      unsubs.push(fs.onSnapshot(q, (snap) => {
        emit(name, snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toMillis?.() ?? Date.now() })));
      }, (err) => console.error(err)));
    }
    // Collections partagées : si les règles Firestore ne les autorisent pas encore, on continue sans classement
    for (const name of SHARED) {
      unsubs.push(fs.onSnapshot(fs.collection(db, name), (snap) => {
        emit(name, snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toMillis?.() ?? Date.now(),
          firstKickoff: d.data().firstKickoff?.toMillis?.() ?? d.data().firstKickoff })));
      }, (err) => { console.warn(`${name} indisponible`, err.code); emit(name, null); }));
    }
  });

  const col = (name) => (SHARED.includes(name) ? fs.collection(db, name) : fs.collection(db, "users", uid, name));
  return {
    uid: () => uid,
    async add(name, doc) {
      const extra = name === "funbets" ? { uid, firstKickoff: fs.Timestamp.fromMillis(doc.firstKickoff) } : {};
      await fs.addDoc(col(name), { ...doc, ...extra, createdAt: fs.serverTimestamp() });
    },
    async update(name, id, patch) { await fs.updateDoc(fs.doc(col(name), id), patch); },
    async remove(name, id) { await fs.deleteDoc(fs.doc(col(name), id)); },
    async setPlayer(doc) { await fs.setDoc(fs.doc(db, "players", uid), { ...doc, updatedAt: fs.serverTimestamp() }, { merge: true }); },
    async saveSettings(patch) { await fs.setDoc(fs.doc(db, "users", uid, "settings", "prefs"), patch, { merge: true }); },
    async login() { await auth.signInWithPopup(a, new auth.GoogleAuthProvider()); },
    async logout() { await auth.signOut(a); },
  };
}

export async function initStore() {
  api = isConfigured ? await firebaseStore() : memoryStore();
  return api;
}

export const store = {
  uid: () => api?.uid(),
  add: (b) => api.add("bets", b),
  addFun: (b) => api.add("funbets", b),
  update: (id, p, col = "bets") => api.update(col, id, p),
  remove: (id, col = "bets") => api.remove(col, id),
  setPlayer: (doc) => api.setPlayer(doc),
  addTransaction: (t) => api.add("transactions", t),
  removeTransaction: (id) => api.remove("transactions", id),
  saveSettings: (patch) => api.saveSettings(patch),
  login: () => api.login(),
  logout: () => api.logout(),
};
