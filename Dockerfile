# -- Build stage: install dependencies --
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# -- Runtime stage --
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash zsh curl tmux \
  && rm -rf /var/lib/apt/lists/*

RUN adduser --disabled-password --gecos '' katulong

WORKDIR /app
COPY --from=build /app .

RUN mkdir -p /data && chown katulong:katulong /data

ENV NODE_ENV=production
ENV KATULONG_DATA_DIR=/data

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:3001/auth/status || exit 1

USER katulong
ENTRYPOINT ["node", "server.js"]
