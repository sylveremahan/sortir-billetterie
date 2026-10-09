# Déployer la billetterie Festin sur Vercel

Ce dossier est un projet Vercel autonome dans le dépôt. Il expose l’interface depuis `public/` et l’API Express depuis `index.mjs`. Les fonctions d’authentification, billets et check-in utilisent une base PostgreSQL externe.

## 1. Relier le dépôt à Vercel

Le dépôt doit être poussé vers GitHub, GitLab ou Bitbucket. Dans Vercel : **Add New → Project**, importer ce dépôt, puis régler **Root Directory** sur `vercel-festin`. Vercel doit détecter le projet Express. Garder le build command vide et ne pas définir d’Output Directory personnalisé. Les ressources web sont dans `public/`.

## 2. Créer PostgreSQL

Dans le projet Vercel, ouvrir **Storage / Marketplace**, installer l’intégration PostgreSQL Neon et la connecter au projet. Vercel indique les variables de connexion ajoutées au projet. Vérifier que `DATABASE_URL` est la chaîne PostgreSQL de production avec TLS et, si le fournisseur propose une URI de pooler, l’utiliser pour les fonctions serverless. Vercel ne fournit plus de base Vercel Postgres native : le PostgreSQL est fourni par une intégration Marketplace.

Dans la console Neon, ouvrir le SQL Editor, sélectionner la base créée, puis exécuter le contenu de `schema.sql` une seule fois. Ne pas partager la chaîne `DATABASE_URL` dans le chat ni l’ajouter au dépôt.

## 3. Créer les mots de passe opérateur

Avec Node.js 24 dans un terminal local, depuis `vercel-festin/`, lancer deux fois :

```powershell
node password-hash.mjs
```

La saisie est masquée. Utiliser deux mots de passe uniques de 14 caractères ou plus, un pour `admin`, l’autre pour `verif`. Copier chaque résultat `scrypt$...` dans les variables Vercel suivantes, sans enregistrer les mots de passe en clair.

## 4. Ajouter les variables Vercel

Dans **Project → Settings → Environment Variables**, ajouter pour **Production** et **Preview** :

- `DATABASE_URL` : normalement créée par l’intégration Neon ; vérifier qu’elle est disponible dans les deux environnements voulus.
- `ADMIN_PASSWORD_HASH` : hachage du mot de passe administrateur.
- `VERIFIER_PASSWORD_HASH` : hachage du mot de passe du compte de contrôle.

Ne pas définir `APP_ORIGIN` sur Vercel : le serveur prend l’origine de l’URL de déploiement Vercel pour les previews et l’URL de production pour la production. Ne pas définir `DATABASE_SSL=disable`, `PGSSL_REJECT_UNAUTHORIZED=false` ou `TRUST_PROXY_HOPS`; les valeurs par défaut activent HTTPS, vérifient TLS et utilisent le proxy Vercel pour le rate limiting. Le code exige HTTPS dans les déploiements hébergés.

## 5. Déployer et ouvrir

Lancer **Deploy**. Après le premier déploiement réussi, ouvrir l’URL de production du projet. Se connecter avec `admin` pour créer et gérer les billets, ou `verif` pour contrôler les entrées. Les previews disposent de leur propre origine Vercel ; elles utilisent la même base si `DATABASE_URL` est configurée en Preview. Pour éviter qu’une preview ne modifie les données réelles, il est recommandé de créer une base Neon de préproduction et de la configurer uniquement dans l’environnement Preview.

La caméra nécessite HTTPS ; la saisie manuelle du code reste disponible comme solution de repli.

## Migrer les billets déjà émis

Sur l’appareil qui contient l’ancienne base, exporter les billets en JSON depuis l’onglet Historique de l’ancienne page. Dans la nouvelle application, se connecter comme `admin`, aller dans **Historique → Importer l’ancienne base** et choisir le fichier. Le serveur valide la totalité du fichier avant toute écriture, conserve les anciens numéros et fusionne les entrées déjà utilisées. Cette migration doit être faite avant de distribuer la nouvelle URL de contrôle.

## Limites opérationnelles

- Cette application émet et contrôle les billets, mais ne traite pas les paiements.
- L’export JSON contient des noms et numéros de téléphone : le conserver de manière protégée et le supprimer quand il n’est plus nécessaire.
- Configurer des sauvegardes PostgreSQL et vérifier régulièrement les déploiements et journaux Vercel.
- Après perte d’un téléphone ou rotation des comptes, révoquer les sessions avec `DELETE FROM festin_sessions;` dans l’éditeur SQL Neon.
- Avant l’ouverture au public, effectuer un déploiement Preview avec une base distincte et vérifier la connexion admin/verif, la création, l’impression, l’import, le scan, le double scan et l’annulation.
