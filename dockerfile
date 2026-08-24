FROM node:20-alpine

# Installation des paquets requis (Python, Make, G++, Git et FFmpeg pour l'audio/vidéo)
RUN apk add --no-cache python3 make g++ git ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
