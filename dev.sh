#!/bin/bash

# Script pour lancer le frontend et le backend en même temps pour le développement local

echo "Lancement des serveurs DATAtourisme Explorer..."

# Lancer le serveur Backend (Scraping/Socket) en arrière-plan
echo "1. Démarrage du Backend (Port 3001)..."
node server.js &
BACKEND_PID=$!

# Lancer le serveur Frontend (Vite)
echo "2. Démarrage du Frontend (Vite)..."
npm run dev &
FRONTEND_PID=$!

# Fonction pour tout arrêter proprement quand on fait Ctrl+C
cleanup() {
    echo -e "\nArrêt des serveurs..."
    kill $BACKEND_PID
    kill $FRONTEND_PID
    exit
}

trap cleanup SIGINT

# Garder le script actif pour voir les logs
wait
