FROM node:22-alpine

# Python (secours yt-dlp), Make, G++, Git (dépendances npm), FFmpeg (audio/vidéo), espeak-ng (secours voix pour .voc)
RUN apk add --no-cache python3 make g++ git ffmpeg espeak-ng ca-certificates

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

# yt-dlp est téléchargé / mis à jour automatiquement par le bot au démarrage (dossier /app/bin)
CMD ["node", "index.js"]
