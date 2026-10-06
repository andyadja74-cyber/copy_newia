FROM node:22-alpine

# Python, Make, G++, Git, FFmpeg (audio/vidéo) + pip pour yt-dlp
RUN apk add --no-cache python3 py3-pip make g++ git ffmpeg ca-certificates

# yt-dlp avec ses composants YouTube (Node 22 sert de moteur JavaScript)
RUN pip install --no-cache-dir --break-system-packages "yt-dlp[default]"

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

# YouTube change souvent : on met yt-dlp à jour à chaque démarrage (sans bloquer si ça échoue)
CMD ["sh", "-c", "pip install -U --no-cache-dir --break-system-packages 'yt-dlp[default]' >/dev/null 2>&1 || true; node index.js"]
