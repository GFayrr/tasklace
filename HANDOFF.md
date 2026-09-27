# Passage de relais Windows → WSL (document temporaire)

> Document destiné à Claude Code, à lire **avant toute autre action** dans la première session WSL.
> **À supprimer** une fois toutes les étapes ci-dessous terminées, et au plus tard avant toute fusion
> de la branche `feature/project-validation-json` dans `main`.

## 1. Demander la copie du `CLAUDE.md` (priorité absolue)

Le `CLAUDE.md` du projet est exclu de Git : il n'existe que côté Windows. Sans lui, les règles du projet
sont inconnues.

- Vérifier si `CLAUDE.md` existe à la racine du dépôt.
- S'il manque : **ne rien coder** et demander à l'utilisateur de le copier depuis Windows avec :
  `cp /mnt/f/PROJETS/Gantt/CLAUDE.md ~/tasklace/CLAUDE.md`
- Vérifier ensuite qu'il contient la section « ⚠️ Rappels permanents » (WSL et fin de projet).

## 2. Restaurer la règle de la mémoire Windows

La mémoire de Claude est restée côté Windows. Règle à réappliquer immédiatement :

- **Aucune mention de Claude** dans les messages de commit ni dans les pull requests
  (pas de ligne `Co-Authored-By: Claude`, pas de « Generated with Claude Code »).

Proposer à l'utilisateur de l'inscrire dans le `CLAUDE.md` (§16, Git) si ce n'est pas déjà fait.

## 3. Vérifier l'environnement

- Node.js 24 LTS (`node --version`), Git, et l'accès GitHub pour pousser.
- `npm ci`, puis `npm run lint`, `npm test` et `npm run bench` : tout doit passer, comme dans
  l'intégration continue Linux.

## 4. Reprendre le travail

- Branche en cours : `feature/project-validation-json` (sous-étape **4a** : validation complète d'un
  projet et échange JSON). Le code est écrit, **les tests restent à écrire et à exécuter**.
- Une fois les tests passés, présenter le résultat à l'utilisateur et lui faire **valider le commit**
  avant toute fusion dans `main`.
- Supprimer ce fichier (`HANDOFF.md`) dans un commit dédié avant la fusion.
