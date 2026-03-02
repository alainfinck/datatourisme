#!/bin/bash

echo "Adding changes..."
git add .

# Générer un message automatique basé sur les changements si aucun n'est fourni
if [ -z "$1" ]
then
    # Récupérer les fichiers modifiés/nouveaux (max 5 pour garder un message court)
    # On filtre pour ne garder que le nom du fichier
    CHANGES=$(git status --porcelain | awk '{print $NF}' | head -n 5 | tr '\n' ',' | sed 's/,$//')
    
    if [ -z "$CHANGES" ]
    then
        MESSAGE="update: $(date +'%Y-%m-%d %H:%M:%S')"
    else
        MESSAGE="auto: $CHANGES $(date +'%H:%M:%S')"
    fi
else
    MESSAGE="$1"
fi

echo "Committing with message: $MESSAGE"
git commit -m "$MESSAGE"

echo "Pushing to remote..."
git push

echo "Done!"
