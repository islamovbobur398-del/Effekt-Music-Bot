# Node 18 asosida
FROM node:18

# Ishchi papka
WORKDIR /app

# package.json fayllarni ko‘chiramiz
COPY package*.json ./

# Kutubxonalarni o‘rnatamiz
RUN npm install

# FFMPEG o‘rnatish
RUN apt-get update && apt-get install -y ffmpeg

# Qolgan fayllarni ko‘chiramiz
COPY . .

# Render porti
ENV PORT=10000

# Botni ishga tushirish
CMD ["npm", "start"]
