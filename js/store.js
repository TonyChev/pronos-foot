// Stockage des paris : Firestore (synchronisé entre appareils) ou, à défaut, en mémoire (mode démo).
import { firebaseConfig } from "./firebase-config.js";

const FB = "https://www.gstatic.com/firebasejs/10.12.2";

export const isConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let listeners = [];
let userListeners = [];
let api = null;

function emit(bets) { listeners.forEach((fn) => fn(bets)); }
function emitUser(user) { userListeners.forEach((fn) => fn(user)); }

export function onBets(fn) { listeners.push(fn); }
export function onUser(fn) { userListeners.push(fn); }

// ---------------------------------------------------------------- mode démo
function memoryStore() {
  let bets = [];
  let n = 0;
  const publish = () => emit([...bets].sort((a, b) => b.createdAt - a.createdAt));
  setTimeout(() => { emitUser({ demo: true, displayName: "Mode démo" }); publish(); });
  return {
    async add(bet) { bets.push({ ...bet, id: `demo-${++n}`, createdAt: Date.now() }); publish(); },
    async update(id, patch) { bets = bets.map((b) => (b.id === id ? { ...b, ...patch } : b)); publish(); },
    async remove(id) { bets = bets.filter((b) => b.id !== id); publish(); },
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
  let unsub = null;
  let uid = null;

  auth.onAuthStateChanged(a, (user) => {
    uid = user?.uid ?? null;
    emitUser(user);
    if (unsub) unsub();
    unsub = null;
    if (!user) { emit([]); return; }
    const q = fs.query(fs.collection(db, "users", uid, "bets"), fs.orderBy("createdAt", "desc"));
    unsub = fs.onSnapshot(q, (snap) => {
      emit(snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toMillis?.() ?? Date.now() })));
    }, (err) => console.error(err));
  });

  const col = () => fs.collection(db, "users", uid, "bets");
  return {
    async add(bet) { await fs.addDoc(col(), { ...bet, createdAt: fs.serverTimestamp() }); },
    async update(id, patch) { await fs.updateDoc(fs.doc(col(), id), patch); },
    async remove(id) { await fs.deleteDoc(fs.doc(col(), id)); },
    async login() { await auth.signInWithPopup(a, new auth.GoogleAuthProvider()); },
    async logout() { await auth.signOut(a); },
  };
}

export async function initStore() {
  api = isConfigured ? await firebaseStore() : memoryStore();
  return api;
}

export const store = {
  add: (b) => api.add(b),
  update: (id, p) => api.update(id, p),
  remove: (id) => api.remove(id),
  login: () => api.login(),
  logout: () => api.logout(),
};
