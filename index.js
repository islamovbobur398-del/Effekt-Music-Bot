// index.js
import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import Database from "better-sqlite3";
import ffmpeg from "fluent-ffmpeg";
import { exec } from "child_process";

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const STORAGE_DIR = process.env.STORAGE_DIR || "/data/files";

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN o‘rnatilmagan!");
  process.exit(1);
}

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// SQLite database
const dbPath = path.join(STORAGE_DIR, "bot.db");
const db = new Database(dbPath);
db.exec(`
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  kind TEXT,
  effect TEXT,
  title TEXT,
  filepath TEXT,
  created_at INTEGER
);
`);
const insertFile = db.prepare(`INSERT INTO files (chat_id, kind, effect, title, filepath, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
const getFile = db.prepare(`SELECT * FROM files WHERE chat_id = ? AND kind = 'original' ORDER BY created_at DESC LIMIT 1`);

const app = express();
app.use(express.json());

// --- Webhook ---
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    const message = body.message;
    if (!message || !message.text) return;

    const chatId = String(message.chat.id);
    const text = message.text.trim();

    // /start
    if (text === "/start") {
      await sendMessage(chatId, "🎧 Salom! Menga YouTube’dagi qo‘shiq nomini yuboring. Men uni yuklab beraman.");
      return;
    }

    // Effektlar
    if (["/zal", "/bass", "/8d"].includes(text)) {
      const effect = text.replace("/", "");
      const row = getFile.get(chatId);
      if (!row) {
        await sendMessage(chatId, "⚠️ Avval YouTube’dan qo‘shiq yuklang.");
        return;
      }
      const originalPath = row.filepath;
      const outPath = path.join(STORAGE_DIR, `${chatId}_${effect}_${Date.now()}.mp3`);
      await sendMessage(chatId, `🎚 ${effect.toUpperCase()} effekti yaratilmoqda...`);

      try {
        await applyEffect(originalPath, outPath, effect);
        insertFile.run(chatId, "effect", effect, row.title, outPath, Date.now());
        await sendAudio(chatId, outPath, `${effect.toUpperCase()} versiya - ${row.title}`);
      } catch (err) {
        await sendMessage(chatId, `❌ Effekt xatosi: ${err.message}`);
      }
      return;
    }

    // YouTube yuklash
    await sendMessage(chatId, `🔎 "${text}" YouTube’dan qidirilmoqda...`);

    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`;
    const { data } = await axios.get(ytUrl);
    const videoId = (data.match(/"videoId":"(.*?)"/) || [])[1];
    if (!videoId) {
      await sendMessage(chatId, "❌ Qo‘shiq topilmadi.");
      return;
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const outputPath = path.join(STORAGE_DIR, `${chatId}_original_${Date.now()}.mp3`);

    await sendMessage(chatId, "🎵 Yuklanmoqda, biroz kuting...");

    await new Promise((resolve, reject) => {
      exec(`yt-dlp -x --audio-format mp3 -o "${outputPath}" "${videoUrl}"`, (err, stdout, stderr) => {
        if (err) return reject(stderr);
        resolve(stdout);
      });
    });

    insertFile.run(chatId, "original", null, text, outputPath, Date.now());
    await sendAudio(chatId, outputPath, text);
    await sendMessage(chatId, "✅ Endi effekt tanlang:\n/zal\n/bass\n/8d");

  } catch (err) {
    console.error("Webhook xatosi:", err);
  }
});

// --- Telegram funksiyalari ---
async function sendMessage(chatId, text) {
  await axios.post(`${BASE_URL}/sendMessage`, { chat_id: chatId, text });
}

async function sendAudio(chatId, filePath, title) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("title", title);
  form.append("audio", fs.createReadStream(filePath));
  await axios.post(`${BASE_URL}/sendAudio`, form, { headers: form.getHeaders() });
}

// --- Effekt funksiyasi ---
function applyEffect(inputPath, outputPath, type) {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputPath).output(outputPath).audioCodec("libmp3lame");
    if (type === "zal") cmd.audioFilters("aecho=0.8:0.9:1000:0.3");
    else if (type === "bass") cmd.audioFilters("bass=g=10");
    else if (type === "8d") cmd.audioFilters("apulsator=hz=0.125");
    else return reject(new Error("Noma’lum effekt"));
    cmd.on("end", resolve).on("error", reject).run();
  });
}

// --- Server ishga tushirish ---
app.listen(PORT, () => console.log(`✅ YouTube bot ishga tushdi, port ${PORT}`));
