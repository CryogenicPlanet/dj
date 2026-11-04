FROM oven/bun:1.4-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
# Persistent state (Spotify token, session, track cache, profile, history) lives on a mounted volume.
ENV VIBEQ_HOME=/data \
    VIBEQ_HOST=0.0.0.0
EXPOSE 8080
CMD ["bun", "src/main.ts", "serve"]
