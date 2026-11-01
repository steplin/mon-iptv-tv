# Mon IPTV TV

Application web installable (PWA) pour regarder sur téléphone Android les chaînes de la TNT française
dont le flux est diffusé publiquement, et ses propres flux M3U / M3U8.

- Les **25 chaînes nationales gratuites** dans l'ordre officiel (numérotation en vigueur depuis juin 2025, RMC Life au 25).
- Lecture **dans l'application** (HLS / M3U8), avec passage automatique à la source suivante en cas d'échec.
- Onglet **Plus** : autres chaînes françaises trouvées dans les listes publiques (régionales, locales…).
- **Mes flux** : ajout d'un flux M3U8, import d'une playlist M3U par adresse ou par fichier, export en `.m3u`.
- Recherche par nom ou numéro, favoris, tout est enregistré sur le téléphone.
- Fonctionne installée sur l'écran d'accueil ; les mises à jour publiées ici arrivent toutes seules au lancement suivant.
- Télécommande / clavier : flèches haut-bas pour changer de chaîne, Échap ou Retour pour fermer.

## Ce que l'application ne fait pas

Elle ne contient **aucun flux** : au démarrage (puis toutes les 12 h, ou avec le bouton ↻) elle lit les listes publiques
suivantes et y retrouve les chaînes par leur nom :

- `https://iptv-org.github.io/iptv/countries/fr.m3u`
- `https://iptv-org.github.io/iptv/languages/fra.m3u`
- `https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8` (seules les chaînes françaises sont gardées)

Seuls les flux **hébergés par les diffuseurs eux-mêmes** sont retenus (liste `OFFICIAL_DOMAINS` dans `js/catalog.js`) : ces listes contiennent aussi de nombreuses rediffusions non autorisées, sur des serveurs quelconques, qui sont écartées. Les listes se modifient dans ⚙ « Sources et réglages ». Une chaîne dont le diffuseur ne publie pas de flux libre
(cas fréquent pour TF1, M6 et leurs chaînes sœurs) reste grisée : l'application ne contourne ni DRM, ni abonnement,
ni restriction d'accès. On peut y associer son propre flux (bouton « Associer mon propre flux »).

Raisons possibles d'un échec de lecture, affichées dans le lecteur :
- **CORS** : le serveur du flux refuse d'être lu depuis une page web → bouton « Regarder dans VLC » ;
- **http** : un flux non sécurisé est bloqué par Chrome dans une application https (l'application essaie d'abord la même adresse en https) → VLC ;
- **403 / 401** : accès refusé par le diffuseur (géo-restriction, jeton expiré) ;
- **404** : adresse périmée → actualiser le catalogue.

## Publier avec GitHub Pages

1. Le dépôt doit être **public** (GitHub Pages n'est pas disponible sur un dépôt privé avec un compte gratuit).
   Le code devient alors visible de tous ; vos flux personnels et favoris, eux, restent sur votre téléphone.
2. Sur github.com : dépôt → **Settings** → **Pages** → *Source* : **Deploy from a branch** →
   branche **main**, dossier **/ (root)** → **Save**.
3. Après une à deux minutes, l'application est en ligne à l'adresse `https://steplin.github.io/mon-iptv-tv/`.

Pour garder le dépôt privé : connecter le dépôt à un hébergeur gratuit qui accepte les dépôts privés
(Netlify ou Cloudflare Pages), sans étape de compilation, dossier de publication `/`.

## Installer sur Android

1. Ouvrir l'adresse de l'application dans **Chrome**.
2. Menu **⋮** → **Installer l'application** (ou **Ajouter à l'écran d'accueil**).
3. L'icône « Mon IPTV » apparaît avec les autres applications.

## Mettre à jour

Modifier les fichiers sur GitHub suffit : l'application installée charge la nouvelle version au lancement suivant
(connexion nécessaire). Pensez à augmenter `VERSION` dans `sw.js` quand vous ajoutez ou renommez un fichier.

## Organisation des fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Page unique de l'application |
| `css/style.css` | Thème sombre, adapté au téléphone |
| `js/app.js` | Interface, lecteur, imports, favoris |
| `js/catalog.js` | Liste des 25 chaînes TNT et association avec les listes publiques |
| `js/m3u.js` | Lecture et écriture des playlists M3U |
| `js/store.js` | Enregistrement local (IndexedDB, localStorage) |
| `sw.js` | Service worker : fonctionnement hors connexion et mises à jour |
| `manifest.webmanifest`, `icons/` | Installation sur l'écran d'accueil |

Le moteur de lecture [hls.js](https://github.com/video-dev/hls.js) (licence Apache 2.0) est chargé depuis jsDelivr ;
si ce chargement échoue, l'application se rabat sur le lecteur HLS intégré à Chrome.
