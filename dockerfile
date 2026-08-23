FROM node:20-alpine

# Installation des paquets requis pour les dépendances C/C++
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
