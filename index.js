// index.js
import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import Database from "better-sqlite3";
import ffmpeg from "fluent-ffmpeg";

const BOT_TOKEN = process.env.BOT_TOKEN;
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
const PORT = process.env.PORT || 10000;
const STORAGE_DIR = process.env.STORAGE_DIR || "/data/files";

if (!BOT_TOKEN || !SERPAPI_KEY) {
  console.error("❌ BOT_TOKEN va SERPAPI_KEY environment variables ni o‘rnat!");
  process.exit(1);
}

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

// Database
const dbPath = path.join(STORAGE_DIR, "bot.db");
const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS search_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  title TEXT,
  url TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chat ON search_variants(chat_id);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  kind TEXT,
  effect TEXT,
  title TEXT,
  filepath TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_files_chat ON files(chat_id);
`);

const insertVariant = db.prepare(`INSERT INTO search_variants (chat_id, idx, title, url, created_at) VALUES (?, ?, ?, ?, ?)`);
const clearVariantsForChat = db.prepare(`DELETE FROM search_variants WHERE chat_id = ?`);
const getVariantsForChat = db.prepare(`SELECT idx, title, url FROM search_variants WHERE chat_id = ? ORDER BY idx ASC`);
const getVariant = db.prepare(`SELECT idx, title, url FROM search_variants WHERE chat_id = ? AND idx = ? LIMIT 1`);
const insertFile = db.prepare(`INSERT INTO files (chat_id, kind, effect, title, filepath, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
const getFile = db.prepare(`SELECT * FROM files WHERE chat_id = ? AND kind = 'original' ORDER BY created_at DESC LIMIT 1`);
const deleteOldFiles = db.prepare(`SELECT * FROM files WHERE created_at <= ?`);

const app = express();
app.use(express.json());

// --- Webhook faqat bitta joyda ishlaydi ---
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    // 1️⃣ Agar callback_query bo‘lsa (variant tugmasi bosilgan)
    if (body.callback_query) {
      const cq = body.callback_query;
      const chatId = String(cq.message.chat.id);
      const data = cq.data;
      const idx = parseInt(data, 10);
      const row = getVariant.get(chatId, idx);
      if (!row) {
        await answerCallbackQuery(cq.id, "⚠️ Tanlov topilmadi.");
        return;
      }
      await answerCallbackQuery(cq.id, `Yuklanmoqda: ${row.title}`);
      await handleChosenVariant(chatId, idx, row.title, row.url);
      return;
    }

    // 2️⃣ Agar oddiy xabar bo‘lsa
    const message = body.message;
    if (!message || !message.text) return;
    const chatId = String(message.chat.id);
    const text = message.text.trim();

    if (text === "/start") {
      await sendMessage(chatId, "🎵 Salom! Menga qo‘shiq yoki ijrochi nomini yozing. Men 10 ta variant topaman va siz tanlaysiz.");
      return;
    }

    if (text === "/zal" || text === "/bass" || text === "/8d") {
      const effect = text.replace("/", "");
      const row = getFile.get(chatId);
      if (!row) {
        await sendMessage(chatId, "⚠️ Avval original musiqani yuklang (variant tanlang).");
        return;
      }
      const originalPath = row.filepath;
      const outPath = path.join(STORAGE_DIR, `${chatId}_${effect}_${Date.now()}.mp3`);
      await sendMessage(chatId, `🎚 ${effect.toUpperCase()} effekti yaratilmoqda...`);

      try {
        await applyEffect(originalPath, outPath, effect);
        insertFile.run(chatId, "effect", effect, row.title, outPath, Date.now());
        await sendAudioFile(chatId, outPath, `${effect.toUpperCase()} versiya - ${row.title}`);
      } catch (err) {
        await sendMessage(chatId, `❌ Effektda xatolik: ${err.message}`);
      }
      return;
    }

    // Qidiruv
    await sendMessage(chatId, `🔎 "${text}" uchun qidirilmoqda...`);
    clearVariantsForChat.run(chatId);

    const params = { engine: "google", q: `${text} filetype:mp3`, num: 10, api_key: SERPAPI_KEY };
    const searchRes = await axios.get("https://serpapi.com/search.json", { params });
    const results = (searchRes.data.organic_results || []).slice(0, 10);

    if (!results.length) {
      await sendMessage(chatId, "⚠️ Musiqa topilmadi, demo variantlar yuborildi.");
      const demo = Array.from({ length: 3 }).map((_, i) => ({
        title: `Demo ${i + 1}`,
        link: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
      }));
      demo.forEach((v, i) => insertVariant.run(chatId, i, v.title, v.link, Date.now()));
      await sendVariantsKeyboard(chatId);
      return;
    }

    results.forEach((r, i) => {
      const url = r.link || r.url;
      if (url) insertVariant.run(chatId, i, r.title, url, Date.now());
    });
    await sendVariantsKeyboard(chatId);

  } catch (err) {
    console.error("Webhook xatolik:", err);
  }
});

// --- Telegramga javob yuborish funksiyalari ---
async function answerCallbackQuery(id, text) {
  await axios.post(`${BASE_URL}/answerCallbackQuery`, { callback_query_id: id, text }).catch(() => {});
}

async function sendMessage(chatId, text) {
  await axios.post(`${BASE_URL}/sendMessage`, { chat_id: chatId, text });
}

async function sendVariantsKeyboard(chatId) {
  const rows = getVariantsForChat.all(chatId);
  if (!rows.length) return sendMessage(chatId, "Variant topilmadi.");
  const inline_keyboard = rows.map(r => [{ text: r.title.slice(0, 40), callback_data: String(r.idx) }]);
  await axios.post(`${BASE_URL}/sendMessage`, {
    chat_id: chatId,
    text: "🎶 Quyidagi variantlardan birini tanlang:",
    reply_markup: { inline_keyboard }
  });
}

async function handleChosenVariant(chatId, idx, title, url) {
  try {
    const res = await axios.get(url, { responseType: "stream" });
    const filepath = path.join(STORAGE_DIR, `${chatId}_original_${Date.now()}.mp3`);
    const writer = fs.createWriteStream(filepath);
    res.data.pipe(writer);
    await new Promise(resolve => writer.on("finish", resolve));
    insertFile.run(chatId, "original", null, title, filepath, Date.now());
    await sendAudioFile(chatId, filepath, title);
    await sendMessage(chatId, "✅ Endi effekt tanlang:\n/zal\n/bass\n/8d");
  } catch (err) {
    await sendMessage(chatId, `❌ Yuklash xatosi: ${err.message}`);
  }
}

async function sendAudioFile(chatId, filePath, title) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("title", title);
  form.append("audio", fs.createReadStream(filePath));
  await axios.post(`${BASE_URL}/sendAudio`, form, { headers: form.getHeaders() }).catch(() => {});
}

// --- Effekt funksiyasi ---
function applyEffect(inputPath, outputPath, type) {
  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath).output(outputPath).audioCodec("libmp3lame");
    if (type === "zal") command.audioFilters("aecho=0.8:0.9:1000:0.3");
    else if (type === "bass") command.audioFilters("bass=g=10");
    else if (type === "8d") command.audioFilters("apulsator=hz=0.125");
    else return reject(new Error("Noma’lum effekt"));
    command.on("end", resolve).on("error", reject).run();
  });
}

// --- Fayl tozalash ---
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const olds = deleteOldFiles.all(cutoff);
  olds.forEach(r => {
    try {
      if (fs.existsSync(r.filepath)) fs.unlinkSync(r.filepath);
      db.prepare("DELETE FROM files WHERE id = ?").run(r.id);
    } catch {}
  });
}, 60 * 60 * 1000);

// --- Server ishga tushirish ---
app.listen(PORT, () => console.log(`✅ Server ishlayapti port ${PORT}`));
