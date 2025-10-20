# 1. Node bazasi
FROM node:20-slim

# 2. Kerakli paketlar
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl && \
    pip3 install -U yt-dlp && \
    rm -rf /var/lib/apt/lists/*

# 3. Ishchi papka
WORKDIR /app

# 4. package.json va lock fayllarni nusxalash
COPY package*.json ./

# 5. Node modullarni o‘rnatish
RUN npm install

# 6. Boshqa kodlarni ko‘chirish
COPY . .

# 7. Port
EXPOSE 10000

# 8. Botni ishga tushirish
CMD ["node", "index.js"]
