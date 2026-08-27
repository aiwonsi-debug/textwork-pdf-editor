FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt \
    && npm install -g corepack@latest \
    && corepack pnpm install \
    && corepack pnpm run build

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
