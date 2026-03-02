#!/bin/bash

# Script pour lancer le frontend et le backend en même temps pour le développement local

echo "Nettoyage des ports (3001 et 5173)..."
lsof -ti:3001,5173 | xargs kill -9 2>/dev/null

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
    kill $BACKEND_PID 2>/dev/null
    kill $FRONTEND_PID 2>/dev/null
    exit
}

trap cleanup SIGINT

# Garder le script actif pour voir les logs
wait
