# 1. Node.js bazaviy imiji
FROM node:20-slim

# 2. Zarur paketlarni o‘rnatish (ffmpeg, yt-dlp, build tools)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    yt-dlp \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# 3. Ishchi papka
WORKDIR /app

# 4. package.json fayllarini nusxalash
COPY package*.json ./

# 5. Node modullarini o‘rnatish
RUN npm install

# 6. Kodni konteynerga nusxalash
COPY . .

# 7. Port
EXPOSE 10000

# 8. Default ishga tushirish buyrug‘i
CMD ["node", "index.js"]
