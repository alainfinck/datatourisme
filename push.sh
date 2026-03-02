#!/bin/bash

# Vérifier si un message de commit est fourni
if [ -z "$1" ]
then
    MESSAGE="update: $(date +'%Y-%m-%d %H:%M:%S')"
else
    MESSAGE="$1"
fi

echo "Adding changes..."
git add .

echo "Committing with message: $MESSAGE"
git commit -m "$MESSAGE"

echo "Pushing to remote..."
git push

echo "Done!"
