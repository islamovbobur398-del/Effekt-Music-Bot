# 1. Rasm
FROM node:18-bullseye

# 2. Ishchi papka
WORKDIR /usr/src/app

# 3. Kerakli tizim paketlari
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip && \
    pip3 install --break-system-packages yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 4. Fayllarni konteynerga nusxalash
COPY package*.json ./
RUN npm install

COPY . .

# 5. Port
EXPOSE 10000

# 6. Botni ishga tushirish
CMD ["node", "index.js"]
