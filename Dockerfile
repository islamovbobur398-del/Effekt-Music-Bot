FROM node:18-bullseye

# ffmpeg va kerakli paketlarni o'rnatish
RUN apt-get update && apt-get install -y ffmpeg && apt-get clean && rm -rf /var/lib/apt/lists/*

# ishchi papka
WORKDIR /usr/src/app

# paketlarni nusxalash va o'rnatish
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# kodni nusxalash
COPY . .

# vaqtinchalik fayllar uchun katalog
RUN mkdir -p /data/files
VOLUME ["/data/files"]

ENV PORT=3000
EXPOSE 10000

CMD ["npm", "start"]
