# Pronos Foot : règles pour Claude

## Argent réel et Freebet : toujours séparés

- Le portefeuille **Freebet** est entièrement fictif (paris marqués `wallet: "fun"` dans Firestore).
- Ne **jamais** mélanger les paris Freebet avec l'argent réel : bilans, rentabilité, conseils de mise
  ou décisions sur l'app se font uniquement sur les paris réels.
- Ne prendre en compte les paris Freebet **que** si l'utilisateur envoie lui-même un export Freebet
  (en-tête « export FREEBET ») et demande une analyse. Cette analyse reste à part et ne change rien
  aux conseils sur l'argent réel.
- Dans le code, tout calcul sur l'argent réel filtre avec `inWallet("real")` / `wallet("real")`.
