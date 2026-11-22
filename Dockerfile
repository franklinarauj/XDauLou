FROM node:22-alpine

# ffmpeg para a conversão em GIF; yt-dlp como extrator alternativo.
RUN apk add --no-cache ffmpeg yt-dlp

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund && npm install ioredis --no-save --no-audit --no-fund

COPY server ./server
COPY public ./public

ENV NODE_ENV=production PORT=3000 FFMPEG_PATH=/usr/bin/ffmpeg
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
