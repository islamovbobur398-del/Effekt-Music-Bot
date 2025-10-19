# 1. Node.js bazasi
FROM node:20-bullseye

# 2. Ishchi papka
WORKDIR /usr/src/app

# 3. Kerakli tizim paketlarini o‘rnatish
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip python3-venv && \
    python3 -m venv /venv && \
    /venv/bin/pip install yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 4. Muhit o‘zgaruvchilari
ENV PATH="/venv/bin:$PATH"

# 5. Node.js modullarini o‘rnatish
COPY package*.json ./
RUN npm install

# 6. Kodni konteynerga ko‘chirish
COPY . .

# 7. Port ochish
EXPOSE 10000

# 8. Botni ishga tushirish
CMD ["node", "index.js"]
