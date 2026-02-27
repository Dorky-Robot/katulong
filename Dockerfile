# -- Flutter build stage: compile Flutter Web frontend --
FROM ghcr.io/cirruslabs/flutter:3.41.2 AS flutter-build

WORKDIR /app/ui
COPY ui/pubspec.yaml ui/pubspec.lock* ./
RUN flutter pub get
COPY ui/ .
RUN flutter build web --release --dart-define=FLUTTER_WEB_CANVASKIT_URL=/canvaskit/

# -- Node build stage: compile node-pty native addon --
FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 cmake \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Copy Flutter build output into public/
# Preserve vendor assets, icons, manifest that are not part of Flutter build
COPY --from=flutter-build /app/ui/build/web/ /tmp/flutter-build/
RUN cp -a public/vendor /tmp/flutter-build/vendor && \
    cp -a public/favicon.ico public/icon-192.png public/icon-512.png \
          public/icon-512-maskable.png public/apple-touch-icon.png \
          public/manifest.json public/logo.webp /tmp/flutter-build/ 2>/dev/null || true && \
    rm -rf public/* && \
    cp -a /tmp/flutter-build/. public/ && \
    mkdir -p public/js && \
    cp -a ui/web/js/xterm_bridge.js ui/web/js/webauthn_bridge.js ui/web/js/p2p_bridge.js public/js/

# -- Runtime stage --
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash zsh curl \
  && rm -rf /var/lib/apt/lists/*

RUN adduser --disabled-password --gecos '' katulong

WORKDIR /app
COPY --from=build /app .

RUN mkdir -p /data && chown katulong:katulong /data

ENV NODE_ENV=production
ENV KATULONG_DATA_DIR=/data

EXPOSE 3001
EXPOSE 2222

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:3001/auth/status || exit 1

USER katulong
ENTRYPOINT ["node", "entrypoint.js"]
