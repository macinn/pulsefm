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
ENV TZ=America/Mexico_City

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY media/ media/

RUN mkdir -p data

EXPOSE 3001
CMD ["node", "dist/index.js"]
