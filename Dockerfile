# fixture-dynamic — built from an official Node base image rather than Nixpacks.
# Nixpacks' bundled Node 22 is 22.14.0; node:22-alpine takes the current 22.x
# patch release on every rebuild, and the major is pinned in this one line.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./

# Unprivileged. The /data volume must be owned by uid 1000 on the host, or the
# storage probe in /health fails — which is the probe doing its job.
USER node
EXPOSE 3000

# Shell form so $PORT is read at run time. /health checks the database and the
# volume, so a container that is running but broken reports unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT:-3000}/health" | grep -q '"status":"healthy"' || exit 1

CMD ["node", "server.js"]
