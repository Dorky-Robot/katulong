# -- Build stage: compile node-pty native addon --
FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 cmake \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# -- Runtime stage --
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash zsh curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app .

RUN mkdir -p /data

ENV NODE_ENV=production
ENV KATULONG_DATA_DIR=/data

EXPOSE 3001
EXPOSE 2222

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:3001/auth/status || exit 1

ENTRYPOINT ["node", "entrypoint.js"]
