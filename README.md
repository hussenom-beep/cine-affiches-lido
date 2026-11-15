# Ciné Affiches — Le Lido

Catalogue public des affiches de films du cinéma Le Lido (accessible par QR code) et administration privée des stocks.

- **Vitrine publique** : `/` — recherche, tris, filtres par format, fiche détaillée, autres visuels du même film. Aucune quantité ni emplacement visible.
- **Administration** : `/espace-interne` — connexion Supabase, ajout d'affiches via TMDB (galerie de tous les visuels) ou par photo (recadrage), stocks par visuel × format × emplacement, ventes en deux gestes, déplacements, historique, inventaire PDF, réglages, gestion des administrateurs (invitations, rôles, transfert du rôle principal).

**Pour installer et mettre en ligne : lire `GUIDE-MISE-EN-SERVICE.md`.**

## Architecture

| Élément | Rôle |
|---|---|
| `index.html` | Toute l'interface (HTML, CSS, JavaScript) en un seul fichier. Bibliothèques chargées depuis jsDelivr en versions figées : supabase-js 2.117.3 ; pdfmake 0.2.23, Cropper.js 1.6.2 et qrcode-generator 1.4.4 chargés seulement quand on en a besoin. |
| `api/config.js` | Fournit au navigateur l'adresse Supabase et la clé **publique**. |
| `api/tmdb.js` | Accès à TMDB réservé aux administrateurs ; la clé TMDB reste côté serveur. |
| `api/admins.js` | Invitations, renvois, désactivation, retrait (clé secrète Supabase côté serveur, réservé au principal). |
| `api/setup.js` | Création unique du premier administrateur principal (protégée par `SETUP_CODE`). |
| `supabase/01_schema.sql` | Tables, contraintes, index, fonctions atomiques de stock, rôles, politiques RLS. |
| `supabase/02_storage.sql` | Bucket `posters` et ses règles. |
| `vercel.json` | Réécritures (lien direct, actualisation), `noindex` sur `/espace-interne`, CSP et en-têtes de sécurité. |

Sécurité : tables inaccessibles aux visiteurs ; vitrine servie par deux fonctions SQL qui n'exposent ni quantité, ni emplacement, ni compte. Stock et historique modifiables uniquement par des fonctions SQL atomiques (verrou de ligne, quantité jamais négative, historique dans la même transaction). Rôles « principal » / « administrateur » vérifiés dans la base ; il reste toujours au moins un principal actif ; un compte désactivé perd l'accès immédiatement.

## Tests

```bash
npm run check          # syntaxe JavaScript (index.html + api)
npm run test:logic     # 15 tests : recherche, tris, filtres, stocks, inventaire, adresses
npm run test:api       # 16 tests : fonctions serveur (accès, invitations, initialisation, clés)
npm i --no-save embedded-postgres pg && npm run test:db   # 69 tests sur un vrai PostgreSQL
# Navigateur (Playwright + Pillow) : voir l'en-tête de tests/e2e/e2e.py — 69 vérifications
```
