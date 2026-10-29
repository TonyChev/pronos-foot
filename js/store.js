// Stockage des paris et des mouvements du portefeuille :
// Firestore (synchronisé entre appareils) ou, à défaut, en mémoire (mode démo).
import { firebaseConfig } from "./firebase-config.js?v=202610291610";

const FB = "https://www.gstatic.com/firebasejs/10.12.2";
const COLLECTIONS = ["bets", "transactions"];

export const isConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

const listeners = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
const userListeners = [];
let api = null;

function emit(name, docs) { listeners[name].forEach((fn) => fn(docs)); }
function emitUser(user) { userListeners.forEach((fn) => fn(user)); }

export function onBets(fn) { listeners.bets.push(fn); }
export function onTransactions(fn) { listeners.transactions.push(fn); }
export function onUser(fn) { userListeners.push(fn); }

// ---------------------------------------------------------------- mode démo
function memoryStore() {
  const data = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
  let n = 0;
  const publish = (name) => emit(name, [...data[name]].sort((a, b) => b.createdAt - a.createdAt));
  setTimeout(() => { emitUser({ demo: true, displayName: "Mode démo" }); COLLECTIONS.forEach(publish); });
  return {
    async add(name, doc) { data[name].push({ ...doc, id: `demo-${++n}`, createdAt: Date.now() }); publish(name); },
    async update(name, id, patch) { data[name] = data[name].map((d) => (d.id === id ? { ...d, ...patch } : d)); publish(name); },
    async remove(name, id) { data[name] = data[name].filter((d) => d.id !== id); publish(name); },
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
    if (!user) { COLLECTIONS.forEach((c) => emit(c, [])); return; }
    for (const name of COLLECTIONS) {
      const q = fs.query(fs.collection(db, "users", uid, name), fs.orderBy("createdAt", "desc"));
      unsubs.push(fs.onSnapshot(q, (snap) => {
        emit(name, snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toMillis?.() ?? Date.now() })));
      }, (err) => console.error(err)));
    }
  });

  const col = (name) => fs.collection(db, "users", uid, name);
  return {
    async add(name, doc) { await fs.addDoc(col(name), { ...doc, createdAt: fs.serverTimestamp() }); },
    async update(name, id, patch) { await fs.updateDoc(fs.doc(col(name), id), patch); },
    async remove(name, id) { await fs.deleteDoc(fs.doc(col(name), id)); },
    async login() { await auth.signInWithPopup(a, new auth.GoogleAuthProvider()); },
    async logout() { await auth.signOut(a); },
  };
}

export async function initStore() {
  api = isConfigured ? await firebaseStore() : memoryStore();
  return api;
}

export const store = {
  add: (b) => api.add("bets", b),
  update: (id, p) => api.update("bets", id, p),
  remove: (id) => api.remove("bets", id),
  addTransaction: (t) => api.add("transactions", t),
  removeTransaction: (id) => api.remove("transactions", id),
  login: () => api.login(),
  logout: () => api.logout(),
};
