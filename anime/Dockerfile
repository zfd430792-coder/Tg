# Сборка фронтенда
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# Заглушка вместо webrtc-polyfill: серверу WebRTC не нужен, а настоящий тянет нативный пакет.
COPY vendor ./vendor
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Рантайм: Node сам исполняет TypeScript сервера (type stripping), сборка не нужна
FROM node:22-alpine
WORKDIR /app
# ffmpeg — для торрент-плеера: перекладывает серию из .mkv в HLS для браузера.
RUN apk add --no-cache ffmpeg
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/animini.db
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
