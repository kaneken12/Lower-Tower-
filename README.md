# Bot Telegram LOWER TOWER

Le bot ne contient **aucune règle métier** : chaque administrateur autorisé est relié à **son propre compte du site**.
Le bot se connecte à ce compte avec la clé **publique** du projet et appelle les **mêmes fonctions serveur** que le site.
Les permissions (OWNER / ADMIN avec permissions), les confirmations, les règles financières et le journal d'audit sont donc
exactement ceux du site. Une modification faite sur Telegram est visible immédiatement sur le site (même base de données).

## Ce qu'il sait faire
- `/stats` : statistiques générales.
- `/joueur [texte]` : rechercher un joueur (nom, pseudo ou numéro) ; fiche, historique, créditer / débiter (avec motif et confirmation), suspendre / réactiver.
- **✏️ Modifier** (depuis la fiche d'un joueur) : nom, pseudo, classe, niveau (1 à 9999), avec motif obligatoire, confirmation et inscription au journal d'audit.
- **🔑 Mot de passe** : génère un mot de passe temporaire (12 caractères) et coupe les sessions ouvertes du joueur. Il s'affiche une seule fois puis le message est supprimé après 90 secondes. Un mot de passe existant ne peut **jamais** être relu (il est stocké sous forme chiffrée) : on peut seulement en générer un nouveau.
  Le mot de passe du compte OWNER ne se réinitialise pas ici ; celui d'un ADMIN ne peut l'être que par l'OWNER.
- `/prets` : demandes Ask Loan en attente (approuver / refuser, avec confirmation) ; `/retards` : dettes en retard.
- `/events` : lister, publier, dépublier, annuler, créer un évent.
- `/boutique` : lister les articles, créer un article (photo possible).
- Alertes automatiques : demande Ask Loan, message signalé, article vendu (vérification toutes les 20 secondes).
- `/id` : affiche ton identifiant Telegram. `/annuler` : quitte l'opération en cours.

## Mise en place
1. Sur Telegram, crée le bot avec **@BotFather** (`/newbot`) et copie le jeton.
2. Envoie `/id` à ton bot une fois lancé (ou à @userinfobot) pour connaître ton identifiant numérique.
3. Sur le serveur (Node.js 18 ou plus) :
   ```bash
   cd telegram-bot
   npm install
   cp .env.example .env      # puis remplir TELEGRAM_BOT_TOKEN et ADMINS_JSON
   chmod 600 .env
   npm start
   ```
4. Pour le laisser tourner en continu : `pm2 start src/index.js --name lower-tower-bot` (ou un service systemd).

## Sécurité
- Le jeton du bot et les mots de passe restent dans `.env` (jamais dans Git, jamais dans le site).
- Le bot ne répond **qu'en conversation privée** et **uniquement** aux identifiants Telegram listés dans `ADMINS_JSON`.
  Tout autre identifiant reçoit « Accès refusé » (et la tentative est écrite dans les journaux du serveur).
- Si le compte du site lié n'est ni OWNER ni ADMIN, le bot refuse de démarrer pour cet identifiant.
- Pour retirer un accès : supprimer l'entrée de `ADMINS_JSON`, redémarrer le bot, et changer le mot de passe du compte du site.
- Les opérations d'argent demandent toujours un motif et une confirmation explicite avant d'être envoyées.
- Les opérations faites par le bot apparaissent dans le journal d'audit sous le nom du compte lié.

## Limites connues
- Ce code a été vérifié (syntaxe) mais **n'a pas encore été essayé en conditions réelles avec Telegram** : fais un premier test avec un petit montant.
- Les alertes sont relues toutes les 20 secondes (pas de push instantané).
