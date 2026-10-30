# ⚽ Pronos Foot

Suivi de pronostics « Les 2 équipes marquent » et « Plus de 2,5 buts », avec les stats de buts façon Sofascore et les cotes Unibet.

## Comment ça marche

| Élément | Source / outil | Coût |
|---|---|---|
| Matchs, résultats, minutes des buts | FotMob (API publique non officielle) | gratuit |
| Cotes « Les 2 marquent » et « +2,5 buts » | Kambi, la plateforme de paris d'Unibet | gratuit |
| Mise à jour automatique (toutes les heures) | GitHub Actions | gratuit (dépôt public) |
| Hébergement du site | GitHub Pages | gratuit |
| Sauvegarde des paris (téléphone + PC) | Firebase Firestore + connexion Google | gratuit (offre Spark) |

- Matchs affichés : aujourd'hui et demain, pour les 18 championnats + Ligue des champions, Ligue Europa et Ligue Conférence (liste dans `scripts/update.py`, variable `COMPETITIONS`). Aucun match amical.
- Stats : saison en cours, championnat et coupes d'Europe confondus. Seuls les buts du temps réglementaire (90 min + arrêts de jeu) sont comptés : les prolongations sont exclues, comme pour le règlement des paris BTTS et +2,5.
- Les pourcentages sous les cotes = moyenne des 2 équipes sur la saison (ex. « 75% » = 75 % des matchs de ces équipes ont vu les 2 équipes marquer).
- Le bouton **↻ Cotes** recharge les cotes en direct depuis Unibet pour le jour affiché.
- Les paris se règlent tout seuls dès que le score final est connu (mise à jour horaire). En cas de match reporté, utilise « Forcer : Remboursé ».

## Mise en ligne (une seule fois, environ 15 min)

### 1. Créer le dépôt GitHub
1. Sur github.com : **New repository**, nom `pronos-foot`, visibilité **Public** (requis pour GitHub Pages gratuit). Crée-le vide.
2. **Add file → Upload files** : glisse tout le contenu du dossier `pronos-foot`, puis **Commit changes**.
   ⚠️ Le dossier `.github` est caché sur Mac et ne part pas toujours par glisser-déposer. S'il n'apparaît pas dans le dépôt : **Add file → Create new file**, nom `.github/workflows/update-data.yml`, colle le contenu du fichier du même nom, puis **Commit**.

### 2. Activer le site et la mise à jour automatique
1. **Settings → Pages** : Source = *Deploy from a branch*, branche `main`, dossier `/ (root)` → **Save**. L'adresse du site s'affiche au bout d'une minute (`https://<ton-pseudo>.github.io/pronos-foot/`).
2. **Settings → Actions → General → Workflow permissions** : coche *Read and write permissions* → **Save**.
3. **Actions → Mise à jour des données → Run workflow** pour lancer une première mise à jour. Ensuite, elle tourne toute seule toutes les heures.

### 3. Synchroniser les paris entre téléphone et PC (Firebase)
Sans cette étape, l'app fonctionne en **mode démo** : les paris sont perdus au rechargement de la page.

1. Va sur https://console.firebase.google.com → **Créer un projet** (nom libre, Google Analytics inutile).
2. **Build → Authentication → Commencer → Google** → Activer → Enregistrer.
   Puis onglet **Settings → Authorized domains → Add domain** : `<ton-pseudo>.github.io`
3. **Build → Firestore Database → Créer une base de données** : emplacement `eur3 (europe-west)`, mode **production**.
   Onglet **Règles** : remplace tout par le contenu du fichier `firestore.rules` → **Publier**.
4. **Paramètres du projet (⚙️) → Général → Vos applications → icône `</>`** (Web) : nom libre, *sans* Firebase Hosting.
   Copie les valeurs `apiKey`, `authDomain`, `projectId` et `appId` dans `js/firebase-config.js` (sur GitHub : ouvre le fichier → ✏️ → colle → Commit).

Exemple de `js/firebase-config.js` rempli :
```js
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "pronos-foot-xxxx.firebaseapp.com",
  projectId: "pronos-foot-xxxx",
  appId: "1:123456789:web:abc123",
};
```

### 4. Sur ton téléphone Android
Ouvre l'adresse du site dans Chrome → menu ⋮ → **Ajouter à l'écran d'accueil**. L'app s'ouvre alors comme une application.

## Ajouter une compétition
Dans `scripts/update.py`, ajoute une ligne à `COMPETITIONS` :
- `id` : le nombre dans l'URL FotMob de la compétition (ex. `fotmob.com/leagues/53/...` → 53) ;
- `kambi` : le pays (en anglais, minuscules) et le nom de la compétition chez Unibet.

## Limites à connaître
- FotMob et Kambi sont des API publiques mais **non officielles** : elles peuvent changer sans prévenir. Si les données ne bougent plus, regarde l'onglet **Actions** du dépôt.
- Les cotes viennent du site international d'Unibet. Elles sont généralement identiques ou très proches de l'appli Unibet France, mais saisis toujours la cote exacte dans le bulletin.
- Les tâches planifiées de GitHub peuvent avoir 10 à 30 min de retard aux heures chargées.
- Seule la session de connexion Google est conservée dans le navigateur. Tes paris sont stockés uniquement dans Firebase.

## Tester en local
```bash
python3 scripts/update.py      # rafraîchit data/
python3 -m http.server 8765    # puis ouvrir http://localhost:8765
```

## Publier une nouvelle version
Les fichiers sont appelés avec un numéro de version (`?v=...` dans `index.html`, `js/app.js` et `js/store.js`). Change ce numéro à chaque modification du code, sinon les téléphones peuvent garder l'ancienne version en cache.

## Buteurs

Pour chaque match des prochaines 48 h, le script récupère sur FotMob la compo probable (puis officielle),
les absents (blessés, suspendus) et, pour chaque joueur, ses buts, xG et minutes de la saison en cours.
L'app en déduit ses chances de marquer s'il est titulaire, ajustées à la défense adverse, puis fait la moyenne
avec la cote Unibet « buteur » (★ = cote plus généreuse que l'estimation). Seuls 3 joueurs par équipe au plus
sont proposés : ceux qui ont déjà marqué et ont au moins 25 % de chances. Un pari buteur est gagné si le joueur
marque (hors contre son camp) et remboursé s'il n'entre pas en jeu.

## Cotes boostées

Les offres foot de unibet.fr/cotes-boostees sont relevées à chaque mise à jour. Chaque offre est jugée sur le boost et une marge estimée, sans analyse du match, et seules celles à valeur positive sont affichées. Ces paris se règlent à la main dans « Mes paris ».
