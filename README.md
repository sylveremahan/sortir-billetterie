# Sortir — billetterie en ligne

Vitrine responsive en français publiée sur GitHub Pages : https://sylveremahan.github.io/sortir-billetterie/ . Catalogue de démonstration, recherche, filtres, détails des événements et formulaire acheteur.

## Paiements

Un premier backend Paystack est présent dans `api/`. Il utilise PostgreSQL pour le catalogue, les réservations de stock, les commandes et l'émission interne de codes 8 chiffres et de jetons QR après vérification. Il doit être déployé séparément du site statique. Le checkout public reste en mode démonstration tant que l'API n'a pas été déployée, raccordée au frontend et configurée avec des données réelles.

Consulter [api/README.md](api/README.md) pour le schéma, les secrets d'environnement, le webhook et les étapes restantes. Aucun secret réel n'est stocké dans le dépôt.

## Limites

Aucune intégration Paystack réelle n'est encore activée. Il faut un compte marchand validé, une clé de test configurée dans l'hébergeur du backend, une base PostgreSQL, un hôte HTTPS et les événements/tarifs/quantités exacts. Les billets ne sont pas encore envoyés par courriel ni accessibles dans un espace client.