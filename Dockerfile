FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl wget git ca-certificates \
    python3 python3-pip python3-venv \
    make g++ gcc \
    tmux vim nano less htop procps \
    jq unzip zip \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/local/bin/python

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js agent.js ./
COPY views ./views

RUN mkdir -p /data/workspace /data/pylib /data/npm-global

ENV DATA_DIR=/data \
    WORKSPACE_DIR=/data/workspace \
    PORT=3000 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
