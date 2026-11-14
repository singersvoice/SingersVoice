# sv-relay: one small container that speaks RTMP for the browser. ffmpeg copies the publisher's
# H.264/AAC segments into the RTMP(S) streams — no transcoding, a sliver of a CPU per stream.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "src/server.mjs"]
