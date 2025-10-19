# Dockerfile
FROM node:20

# Kerakli kutubxonalarni o‘rnatamiz
RUN apt-get update && apt-get install -y ffmpeg yt-dlp && mkdir -p /data/files

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

ENV PORT=3000
ENV STORAGE_DIR=/data/files

CMD ["npm", "start"]
