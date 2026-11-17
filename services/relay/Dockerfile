# sv-relay: one small container that speaks RTMP for the browser — ffmpeg copies the publisher's
# H.264/AAC segments into the RTMP(S) streams (no transcoding, a sliver of a CPU per stream) — and
# fetches YouTube song tracks (yt-dlp + ffmpeg) into a singer's own Drive.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# yt-dlp, the standalone build (no Python needed). It lives where the `node` user can write it, because
# the relay asks it to update itself when it starts (YouTube changes under it every few weeks).
RUN mkdir -p /app/bin && curl -fsSL -o /app/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux && chmod 755 /app/bin/yt-dlp && chown -R node:node /app/bin
COPY package.json ./
COPY src ./src
ENV PORT=8080 NODE_ENV=production RELAY_YTDLP=/app/bin/yt-dlp
EXPOSE 8080
USER node
CMD ["node", "src/server.mjs"]
