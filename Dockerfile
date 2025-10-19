# Dockerfile
FROM node:18-bullseye

# o'rnatish va tozalash
RUN apt-get update && \
    apt-get install -y ffmpeg yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

# STORAGE dir
RUN mkdir -p /data/files
VOLUME ["/data/files"]

ENV PORT=10000
EXPOSE 10000

CMD ["npm", "start"]
