# 1. Rasmiy Node.js image
FROM node:18-slim

# 2. Ishchi katalog
WORKDIR /usr/src/app

# 3. Kerakli kutubxonalarni o‘rnatish
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip && \
    pip3 install yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 4. Fayllarni konteynerga yuklash
COPY package*.json ./
RUN npm install

COPY . .

# 5. Muhit o‘zgaruvchilari
ENV PORT=3000
ENV STORAGE_DIR=/data/files

# 6. Portni ochish
EXPOSE 3000

# 7. Botni ishga tushirish
CMD ["npm", "start"]
