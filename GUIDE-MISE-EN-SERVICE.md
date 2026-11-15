# Ciné Affiches — Le Lido · Guide de mise en service

Ce guide suit l'ordre exact dans lequel faire les choses. Compte environ **1 h 30** la première fois.
Chaque étape dépend des précédentes : ne saute pas d'étape.

---

## Ce que contient le dossier

| Fichier / dossier | À quoi il sert |
|---|---|
| `index.html` | **Toute l'application** : vitrine publique, connexion, administration (un seul fichier). |
| `api/` | Petites fonctions serveur exécutées par Vercel : clé TMDB, invitations, premier compte. |
| `supabase/01_schema.sql` | Création de la base de données et de toutes les règles de sécurité. |
| `supabase/02_storage.sql` | Création de l'espace de stockage des photos et du logo. |
| `vercel.json` | Adresses (`/espace-interne`…) et en-têtes de sécurité pour Vercel. |
| `.env.example` | Liste des réglages à saisir dans Vercel (sans aucun secret). |
| `package.json`, `.vercelignore`, `.gitignore` | Fichiers techniques nécessaires au déploiement. |
| `scripts/`, `tests/` | Outils de test (facultatifs, non publiés en ligne). |

Tu vas créer **4 comptes gratuits** : GitHub, Supabase, Vercel et TMDB (si le cinéma n'a pas déjà une clé utilisable).
Prépare un endroit sûr (gestionnaire de mots de passe) pour noter les clés : certaines sont **secrètes**.

---

## Étape 1 — Créer le projet Supabase (la base de données)

1. Va sur **https://supabase.com** → **Start your project** → crée un compte (le plus simple : « Continue with GitHub » après l'étape 7, ou avec ton e-mail).
2. Clique sur **New project**.
   - **Organization** : celle proposée (ton nom).
   - **Project name** : `cine-affiches-lido`.
   - **Database Password** : clique sur **Generate a password** et note-le (tu n'en auras presque jamais besoin, mais garde-le).
   - **Region** : **Europe (Paris)** ou une région « West EU ».
   - Offre : **Free**.
3. Clique sur **Create new project** et attends 1 à 2 minutes.

> Bon à savoir : un projet gratuit Supabase est mis en pause s'il n'a presque aucune activité pendant une semaine (tu reçois un e-mail avant). Les visites de la vitrine suffisent en général à l'éviter ; sinon, un clic sur **Restore** dans le tableau de bord le relance sans perte de données.

## Étape 2 — Installer la base de données

1. Dans le menu de gauche de Supabase, clique sur **SQL Editor**.
2. Clique sur **New query** (ou le bouton **+**).
3. Ouvre le fichier `supabase/01_schema.sql` avec un éditeur de texte (Bloc-notes, TextEdit…), **sélectionne tout** (Ctrl/Cmd + A), **copie**, puis **colle** dans l'éditeur Supabase.
4. Clique sur **Run** (en bas à droite). Le message attendu est **« Success. No rows returned »**.
   - Si Supabase affiche un avertissement « destructive operation » : c'est normal (le script contient des `drop policy if exists` qui ne suppriment aucune donnée) → **Run this query**.
5. Recommence avec **une nouvelle requête** pour `supabase/02_storage.sql` → **Run** → « Success ».

Vérification : menu **Table Editor** → tu dois voir les tables `admin_profiles`, `films`, `formats`, `locations`, `poster_visuals`, `prices`, `stocks`, `stock_movements`, `app_settings`. La table `formats` contient déjà « Petit format » et « Grand format ».

## Étape 3 — Vérifier l'espace des photos

1. Menu **Storage** → tu dois voir un bucket nommé **`posters`** marqué **Public**.
2. Rien d'autre à faire : le script a déjà fixé les règles (5 Mo maximum, images JPEG/PNG/WebP, envoi et suppression réservés aux administrateurs). « Public » signifie seulement que les photos s'affichent dans la vitrine ; personne ne peut lister, envoyer ou supprimer des fichiers.

## Étape 4 — Récupérer les clés Supabase

Menu **Project Settings** (roue dentée en bas à gauche) → **API Keys** (tu peux aussi passer par le bouton **Connect** en haut).

Note ces trois informations :

| Ce que tu notes | Où le trouver | Nom de la variable plus tard |
|---|---|---|
| L'adresse du projet, du type `https://abcdefgh.supabase.co` | **Project Settings → Data API** (champ « Project URL ») ou bouton **Connect** | `SUPABASE_URL` |
| La clé **publishable** (`sb_publishable_…`) — publique | **API Keys** | `SUPABASE_ANON_KEY` |
| La clé **secret** (`sb_secret_…`) — **SECRÈTE** | **API Keys** → bouton **Reveal** | `SUPABASE_SERVICE_ROLE_KEY` |

> Si ton projet affiche encore l'onglet **Legacy API keys**, les anciennes clés `anon` (publique) et `service_role` (secrète) fonctionnent aussi : l'application accepte les deux formats. Supabase remplace progressivement les anciennes clés : préfère `sb_publishable_…` et `sb_secret_…`.
>
> **Ne mets jamais la clé secrète dans `index.html`, dans un e-mail ou dans un message.** Elle ne servira que dans Vercel.

## Étape 5 — Configurer la connexion (Supabase Auth)

1. Menu **Authentication** → **Sign In / Providers** (ou **Providers**) :
   - **Email** doit être activé.
   - Désactive **Allow new users to sign up** (personne ne peut créer de compte tout seul ; les invitations continuent de fonctionner).
   - Clique sur **Save**.
2. On reviendra sur **URL Configuration** à l'étape 9, quand tu connaîtras l'adresse du site.

## Étape 6 — Configurer les e-mails (invitations et mot de passe oublié)

**Indispensable** : le service d'e-mail fourni par Supabase n'envoie qu'aux adresses des membres de ton équipe Supabase, et seulement environ **2 e-mails par heure**. Pour inviter l'adresse du cinéma et récupérer un mot de passe de façon fiable, il faut un serveur d'envoi (SMTP).

Exemple avec **Brevo** (offre gratuite, entreprise française) — tout autre fournisseur SMTP convient (Resend, Postmark, Mailjet, ou le SMTP de la messagerie du cinéma) :

1. Crée un compte sur **https://www.brevo.com**.
2. Dans Brevo : **Paramètres → Expéditeurs, domaines et IP dédiées** → ajoute l'adresse expéditrice (par exemple l'adresse du cinéma) et valide-la. Idéalement, authentifie aussi le **domaine** (Brevo te donne des enregistrements DNS à ajouter chez l'hébergeur du nom de domaine) : les e-mails arriveront moins souvent dans les indésirables.
3. Dans Brevo : **SMTP & API** → onglet **SMTP** → note le **serveur** (`smtp-relay.brevo.com`), le **port** (`587`), l'**identifiant** et génère une **clé SMTP** (le mot de passe).
4. Dans Supabase : **Authentication → Emails → SMTP Settings** → active **Enable custom SMTP** et remplis :
   - **Sender email** : l'adresse validée chez Brevo ; **Sender name** : `Ciné Affiches — Le Lido`
   - **Host** : `smtp-relay.brevo.com` ; **Port** : `587` ; **Username** : l'identifiant Brevo ; **Password** : la clé SMTP
   - **Save**.
5. Facultatif mais conseillé : **Authentication → Emails → Templates** :
   - **Invite user** → objet : `Invitation — Administration Ciné Affiches Le Lido` ; dans le message, garde absolument le lien `{{ .ConfirmationURL }}`. Exemple :
     `<h2>Vous êtes invité(e) à gérer les affiches du cinéma Le Lido</h2><p><a href="{{ .ConfirmationURL }}">Activer mon compte et choisir mon mot de passe</a></p>`
   - **Reset password** → objet : `Réinitialisation de votre mot de passe — Ciné Affiches` ; garde `{{ .ConfirmationURL }}`.

## Étape 7 — Créer la clé TMDB

1. Va sur **https://www.themoviedb.org** → crée un compte (ou utilise celui du cinéma).
2. Menu de ton profil → **Paramètres** → **API** → demande une clé (formulaire « Developer » : décris l'usage, par exemple « Catalogue des affiches du cinéma Le Lido »).
3. Note le **Jeton d'accès en lecture à l'API** (« API Read Access Token », une longue chaîne commençant par `eyJ…`) → ce sera `TMDB_READ_ACCESS_TOKEN`.

> **Conditions d'utilisation** : l'accès gratuit à l'API TMDB est prévu pour un usage non commercial. La vitrine présente des affiches **en vente** : vérifie que l'autorisation TMDB dont le cinéma dispose déjà pour ses programmes couvre aussi ce site, ou demande à TMDB une licence adaptée. La mention d'attribution TMDB est déjà présente en bas de la vitrine. Sans clé TMDB, tout le reste fonctionne (ajout par photo).

## Étape 8 — Déposer les fichiers sur GitHub

1. Crée un compte sur **https://github.com**.
2. En haut à droite : **+** → **New repository**.
   - **Repository name** : `cine-affiches-lido` ; choisis **Private** ; coche **Add a README file** → **Create repository**.
3. Dans le dépôt : **Add file → Upload files**.
4. Décompresse l'archive sur ton ordinateur, ouvre le dossier `le-lido`, **sélectionne tout son contenu** (pas le dossier lui-même) et glisse-le dans la page GitHub.
   - Les fichiers commençant par un point (`.vercelignore`, `.gitignore`, `.env.example`) sont parfois masqués : sur Mac, **Cmd + Maj + .** les affiche ; sur Windows, **Affichage → Éléments masqués**. `.vercelignore` est important (il empêche de publier le SQL et les tests).
   - Vérifie que `index.html`, `vercel.json`, `package.json` et le dossier `api` sont **à la racine** du dépôt.
5. En bas : **Commit changes**.

## Étape 9 — Déployer sur Vercel

1. Va sur **https://vercel.com** → **Sign Up** → **Continue with GitHub**.
   > L'offre gratuite **Hobby** de Vercel est réservée à un usage personnel et non commercial. Pour la période de création et de tests, c'est adapté. Quand le site servira officiellement le cinéma, vérifie les conditions de Vercel : l'offre **Pro** (environ 20 $ par mois) peut être nécessaire.
2. **Add New… → Project** → à côté de `cine-affiches-lido`, clique sur **Import** (si le dépôt n'apparaît pas : **Adjust GitHub App Permissions** et autorise ce dépôt).
3. Écran **Configure Project** :
   - **Framework Preset** : **Other**.
   - **Root Directory** : laisse `./`.
   - **Build and Output Settings** : laisse tout vide / par défaut (il n'y a rien à compiler).
   - Ouvre **Environment Variables** et ajoute, une par une (**Key** = nom, **Value** = valeur) :

| Key | Value |
|---|---|
| `SUPABASE_URL` | l'adresse du projet (étape 4) |
| `SUPABASE_ANON_KEY` | la clé publishable `sb_publishable_…` |
| `SUPABASE_SERVICE_ROLE_KEY` | la clé secret `sb_secret_…` |
| `TMDB_READ_ACCESS_TOKEN` | le jeton TMDB (étape 7) |
| `SETUP_CODE` | un code que **tu inventes**, 12 caractères minimum (ex. `Lido-Affiches-2026!`). Il protège la création du premier compte. |

4. Clique sur **Deploy** et attends la fin (environ 1 minute) → **Continue to Dashboard**.
5. Note l'adresse du site affichée sous **Domains**, du type `https://cine-affiches-lido.vercel.app`.
6. **Retour dans Supabase** → **Authentication → URL Configuration** :
   - **Site URL** : `https://cine-affiches-lido.vercel.app` (ton adresse).
   - **Redirect URLs** → **Add URL** → `https://cine-affiches-lido.vercel.app/espace-interne/**` → **Save**.
   Sans cela, les liens d'invitation et de mot de passe oublié ne fonctionnent pas.

### Nom de domaine personnalisé (facultatif, à faire AVANT d'imprimer le QR code)
Si le cinéma veut une adresse comme `affiches-lelido.fr` :
1. Achète le domaine (OVH, Gandi, ou directement dans Vercel).
2. Vercel → ton projet → **Settings → Domains** → **Add** → saisis le domaine et suis les instructions DNS affichées.
3. Dans Vercel → **Settings → Environment Variables**, ajoute `PUBLIC_SITE_URL` = `https://affiches-lelido.fr`, puis **Deployments → … → Redeploy**.
4. Dans Supabase → **URL Configuration** : remplace le **Site URL** et ajoute `https://affiches-lelido.fr/espace-interne/**` aux **Redirect URLs**.

## Étape 10 — Créer TON compte administrateur principal

1. Ouvre `https://ton-adresse/espace-interne`.
2. La page de connexion affiche **« Première installation : créer le compte principal »** → clique dessus.
3. Remplis :
   - **Code d'initialisation** : le `SETUP_CODE` choisi à l'étape 9 ;
   - **Ton nom**, **ton adresse e-mail personnelle**, **ton mot de passe** (8 caractères minimum) deux fois.
4. **Créer le compte principal** → tu reviens sur la connexion → connecte-toi → le **tableau de bord** s'affiche.

C'est une opération unique : dès qu'un administrateur existe, la base de données refuse toute nouvelle initialisation, même avec le bon code. Tu peux ensuite supprimer la variable `SETUP_CODE` dans Vercel (**Settings → Environment Variables → … → Remove**).

> Solution de secours, si besoin : Supabase → **Authentication → Users → Add user → Create new user** (ton e-mail, ton mot de passe, coche **Auto Confirm User**), puis **SQL Editor** :
> ```sql
> insert into public.admin_profiles (user_id, email, role, status, activated_at)
> select id, email, 'owner', 'active', now() from auth.users where email = 'ton.adresse@exemple.fr';
> ```

## Étape 11 — Premiers réglages

Dans l'administration → **Réglages** :
1. **Formats et tarifs** : saisis le prix par défaut du petit et du grand format (ex. `8` et `15`).
2. **Catalogue** : vérifie le nom, ajoute le **logo du cinéma**, ajuste la phrase d'accueil.
3. **Emplacements** : crée tes zones (Réserve A, Carton 1, Armoire, Derrière la caisse…).

## Étape 12 — Vérifier les adresses

| Adresse | Ce que tu dois voir |
|---|---|
| `https://ton-adresse/` | La vitrine publique, **sans** aucun lien vers l'administration. |
| `https://ton-adresse/espace-interne` | La page de connexion (ou le tableau de bord si tu es connecté). |
| `https://ton-adresse/admin` | La vitrine (cette adresse n'est **pas** l'administration). |
| `https://ton-adresse/api/config` | Une ligne de texte avec ton adresse Supabase et la clé publique (normal : elles sont publiques). La clé secrète ne doit **pas** y figurer. |
| `https://ton-adresse/supabase/01_schema.sql` | La vitrine (le fichier SQL n'est pas publié). |

## Étape 13 — Tester les fonctions essentielles (15 minutes)

1. **Ajout TMDB** : **+ Ajouter** → tape « Mario » → choisis le film → parcours les visuels (français d'abord) → touche celui que tu possèdes → quantités + emplacement → **Enregistrer**. Ouvre la vitrine dans un autre onglet : l'affiche y est.
2. **Autre visuel** : **Ajouter un autre visuel de ce film** → choisis-en un second → les stocks restent séparés.
3. **Photo** (sur ton téléphone) : **+ Ajouter** → un film → **Ajouter ma propre affiche** → **Prendre une photo** → recadre → **Enregistrer**.
4. **Vente** : Accueil → recherche le film → bouton **−** sur la bonne ligne → **Vente**. **Historique** : la vente apparaît avec ton nom.
5. **Rupture** : retire le dernier exemplaire → l'affiche disparaît de la vitrine (environ 1 minute, ou recharge la page) mais reste dans **Stock** avec le statut « Épuisée ». **Remettre en stock** → elle réapparaît.
6. **Déplacement** : fiche d'une affiche → **Déplacer** → choisis la quantité et l'emplacement d'arrivée → le total ne change pas.
7. **Inventaire** : **Inventaire PDF** → **Générer le PDF** → imprime une page pour vérifier.
8. **Mot de passe oublié** : déconnecte-toi → **Mot de passe oublié ?** → ouvre l'e-mail → choisis un nouveau mot de passe → reconnecte-toi.
9. **Sécurité** : sur ton téléphone en navigation privée, ouvre la vitrine : aucune quantité, aucun emplacement.

## Étape 14 — Créer le QR code pour les clients

À faire **une fois l'adresse définitive en place** (le QR code contient l'adresse du site).

1. Connecte-toi **depuis l'adresse définitive** → **Réglages → QR code de la vitrine**.
2. **Affichette à imprimer (PDF)** : une page A4 prête à afficher dans le hall (« Scannez ce code… »).
   Ou **QR code (PNG)** : l'image seule, à intégrer dans une affiche ou un programme.
3. Teste-le avec l'appareil photo de ton téléphone avant l'impression.

Le QR code ne changera plus, même après le transfert de l'administration au cinéma.

## Étape 15 — Inviter le compte du cinéma Le Lido

1. **Réglages → Gestion des administrateurs** (visible uniquement par l'administrateur principal).
2. **Inviter un administrateur** → saisis l'adresse professionnelle du cinéma → **Envoyer l'invitation**.
   Le compte apparaît avec le statut **Invitation en attente**.
3. Le cinéma reçoit l'e-mail → clique sur le lien → arrive sur **« Bienvenue ! Activation de votre compte »** → saisit un nom (ex. « Cinéma Le Lido ») et choisit son mot de passe → **Activer mon compte**.
4. Chez toi, le statut passe à **Actif**. Si l'e-mail n'arrive pas : vérifie les indésirables, puis **Renvoyer**.

## Étape 16 — Transférer l'administration

1. Vérifie avec le cinéma qu'il se connecte bien sur `/espace-interne`.
2. **Gestion des administrateurs** → sur la ligne du cinéma → **Transférer le rôle principal**.
   - Case **« Rester également administrateur principal »** : coche-la si tu veux garder tous tes droits pendant une période de transition.
   - **Transférer**. L'opération est immédiate et ne touche à **aucune** donnée (films, affiches, stocks, photos, emplacements, prix, historique, réglages).
3. Ensuite, au choix :
   - tu gardes ton compte comme **Administrateur** (pour aider au quotidien) ;
   - ou le cinéma (devenu principal) clique sur **Désactiver** sur ta ligne : ton accès est coupé immédiatement, ton historique reste visible.

Garde-fou : il est impossible de désactiver ou de retirer **le dernier** administrateur principal actif.

### À ne pas oublier : les comptes techniques
Le transfert ci-dessus concerne l'**application**. Les comptes **Supabase**, **Vercel**, **GitHub**, **TMDB** et **Brevo** restent à ton nom. Quand tu veux tout remettre au cinéma :
- **Supabase** : **Organization settings → Team → Invite** l'adresse du cinéma avec le rôle **Owner** (ou **Project Settings → General → Transfer project**).
- **Vercel** : **Settings → General → Transfer** (vers l'équipe du cinéma).
- **GitHub** : **Settings → Danger Zone → Transfer ownership** (ou ajoute le cinéma comme collaborateur).
- **TMDB / Brevo** : idéalement créés dès le départ avec l'adresse du cinéma ; sinon, change l'adresse du compte.

---

## En cas de problème

| Symptôme | Solution |
|---|---|
| « Configuration requise » sur le site | Variables `SUPABASE_URL` / `SUPABASE_ANON_KEY` absentes ou mal saisies dans Vercel → corrige → **Deployments → Redeploy**. |
| « Initialisation désactivée » | `SETUP_CODE` absent ou trop court dans Vercel → ajoute-le → **Redeploy**. |
| La recherche TMDB affiche une erreur de clé | `TMDB_READ_ACCESS_TOKEN` incorrect → corrige → **Redeploy**. |
| « Invitation impossible / SUPABASE_SERVICE_ROLE_KEY » | Clé secrète absente dans Vercel. |
| L'e-mail d'invitation n'arrive pas | Indésirables ; SMTP de l'étape 6 ; limite d'envoi Brevo ; **Renvoyer**. |
| Le lien de l'e-mail mène à une erreur | Ajoute `https://ton-adresse/espace-interne/**` dans Supabase → **URL Configuration → Redirect URLs** ; le lien expire après un délai : renvoie-le. |
| Le site est indisponible après quelques semaines | Le projet Supabase gratuit est en pause → tableau de bord Supabase → **Restore project**. |

## Pour une personne technique (facultatif)

```bash
npm run check                         # syntaxe de index.html et des fonctions /api
npm run test:logic                    # logique métier (extraite de index.html)
npm run test:api                      # fonctions serveur (Supabase/TMDB simulés)
npm i --no-save embedded-postgres pg && npm run test:db    # base réelle PostgreSQL : RLS, rôles, simultanéité
cp .env.example .env.local && npm run dev                  # site complet en local sur http://localhost:3000
```
