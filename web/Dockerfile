FROM node:22-slim AS base

# --- Build stage ---
FROM base AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build-time env: backend URL will be set during deploy
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

RUN npm run build

# --- Production stage ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/public public/
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static .next/static/

EXPOSE 3000
CMD ["node", "server.js"]
