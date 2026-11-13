# hp game solver

un userscript qui résout les mini-jeux à ta place. un bouton, un jeu, c'est réglé.

pensé pour le mobile (android + tampermonkey), marche aussi sur desktop.

---

## ce que ça fait

un petit bouton 🧩 flotte sur la page. tu l'ouvres, tu choisis un jeu, tu appuies. c'est tout.

pas de log, pas d'auto, pas de menu à rallonge. si la partie est finie, il en relance une.

| jeu | comment il le résout |
|---|---|
| **voisins** | backtracking sur la grille, deux cartes voisines doivent partager un type ou une génération |
| **coffre** | à chaque essai, il prend le code qui coupe le mieux les possibilités restantes |
| **connexions** | il retrouve les groupes tout seul |
| **cartodle** | il élimine les candidats jusqu'à tomber sur la bonne carte |
| **voltorb flip** | il envoie la grille à un solveur externe et joue les cases sûres |

## installation

1. installe [tampermonkey](https://www.tampermonkey.net/) (kiwi browser ou firefox sur android, n'importe quel navigateur sur desktop)
2. ouvre ce lien, tampermonkey te propose d'installer :

   **[`INSTALL_URL`](INSTALL_URL)**

3. ou à la main : tampermonkey → *utilitaires* → *installer depuis une URL* → colle le lien ci-dessus
4. va sur le site du jeu, le 🧩 apparaît en haut à droite

## ça marche pas ?

- le 🧩 n'apparaît pas → vérifie que le script est activé dans tampermonkey, puis recharge la page
- ça dit `erreur · HTTP 4xx` → tu n'es pas connecté, ou la partie du jour est déjà jouée
- ça ne se met pas à jour tout seul → c'est normal, la page se recharge après la résolution

## ce que le script contacte

le script parle au site du jeu (avec ta session), et à ces trois domaines :

- `pokeapi.co` : données des pokémon
- `api.tcgdex.net` : données des cartes
- `voltorbflip.com` : solveur de voltorb flip (c'est le seul qui reçoit l'état de ta grille)

rien d'autre. pas de tracking, pas de serveur à moi.

## mettre à jour

tampermonkey vérifie tout seul. sinon : *utilitaires* → *vérifier les mises à jour*.

---

usage perso. si le site change, ça peut casser. c'est la vie.
