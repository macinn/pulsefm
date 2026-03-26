FROM node:22-slim AS base
# Pulse AI Radio — agent-server

# --- Build stage ---
FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# --- Production stage ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY media/ media/

# Data dirs (ephemeral on Cloud Run, persistent with volume mounts)
RUN mkdir -p data/schedules data/stations data/news

EXPOSE 3001
CMD ["node", "dist/index.js"]
