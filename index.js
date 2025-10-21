// index.js — TEZLIK VA BARQARORLIK UCHUN OPTIMALLASHTIRILGAN

import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import Database from "better-sqlite3";
import ffmpeg from "fluent-ffmpeg";
import { promisify } from "util";
import { exec as execCb } from "child_process";

const exec = promisify(execCb);
axios.defaults.timeout = 60000; // 60 sekund — sekin tarmoq uchun kutish vaqti

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;
const STORAGE_DIR = process.env.STORAGE_DIR || "/data/files";
const COOKIES_PATH = "/app/cookies.txt";

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN belgilanmagan!");
  process.exit(1);
}

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// === DATABASE ===
const dbPath = path.join(STORAGE_DIR, "bot.db");
const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS search_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  title TEXT,
  video_id TEXT,
  url TEXT,
  created_at INTEGER
);
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

const insertVariant = db.prepare(`INSERT INTO search_variants (chat_id, idx, title, video_id, url, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
const clearVariantsForChat = db.prepare(`DELETE FROM search_variants WHERE chat_id = ?`);
const getVariantsForChat = db.prepare(`SELECT idx, title, video_id, url FROM search_variants WHERE chat_id = ? ORDER BY idx ASC`);
const getVariant = db.prepare(`SELECT * FROM search_variants WHERE chat_id = ? AND idx = ? LIMIT 1`);
const insertFile = db.prepare(`INSERT INTO files (chat_id, kind, effect, title, filepath, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
const getLatestOriginal = db.prepare(`SELECT * FROM files WHERE chat_id = ? AND kind='original' ORDER BY created_at DESC LIMIT 1`);
const getFilesOlderThan = db.prepare(`SELECT * FROM files WHERE created_at <= ?`);
const deleteFileById = db.prepare(`DELETE FROM files WHERE id=?`);

// === EXPRESS ===
const app = express();
app.use(express.json());

// === TELEGRAM WEBHOOK ===
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;

    if (body.callback_query) {
      const cq = body.callback_query;
      const chatId = String(cq.message.chat.id);
      const data = cq.data;

      const row = getVariant.get(chatId, parseInt(data, 10));
      if (!row) return answerCallback(cq.id, "Tanlov topilmadi.");

      await answerCallback(cq.id, `Yuklanmoqda: ${row.title}`);
      await handleDownload(chatId, row.title, row.url, row.video_id);
      return;
    }

    const msg = body.message;
    if (!msg || !msg.text) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    if (text === "/start") {
      return sendMessage(chatId, "🎵 Salom! botni vazifasi muzikani topish va Zal.Bass.8D effektga aylantrish.");
    }

    if (["/zal", "/bass", "/8d"].includes(text)) {
      const effect = text.slice(1);
      const latest = getLatestOriginal.get(chatId);
      if (!latest) return sendMessage(chatId, "⚠️ Avval musiqani yuklang.");

      const output = path.join(STORAGE_DIR, `${chatId}_${effect}_${Date.now()}.mp3`);
      await sendMessage(chatId, `🎚 ${effect.toUpperCase()} effekti yaratilmoqda...`);
      await applyEffect(latest.filepath, output, effect);
      insertFile.run(chatId, "effect", effect, latest.title, output, Date.now());
      return sendAudio(chatId, output, `${effect.toUpperCase()} - ${latest.title}`);
    }

    // === YT SEARCH ===
    await sendMessage(chatId, `🔎 "${text}" mp3 yuklanmoqda...`);
    clearVariantsForChat.run(chatId);
    const yts = (await import("yt-search")).default;
    const result = await yts(text);
    const vids = result.videos.slice(0, 10);

    if (!vids.length) return sendMessage(chatId, "❌ Natija topilmadi.");

    vids.forEach((v, i) => insertVariant.run(chatId, i, v.title, v.videoId, v.url, Date.now()));
    await sendVariantsKeyboard(chatId);
  } catch (e) {
    console.error("Webhook xato:", e);
  }
});

// === ASOSIY FUNKSIYALAR ===
async function handleDownload(chatId, title, url, videoId) {
  try {
    await sendMessage(chatId, `⬇️ Yuklanmoqda: ${title}`);
    const filepath = path.join(STORAGE_DIR, `${chatId}_original_${videoId}.mp3`);

    const cmd = `yt-dlp -x --audio-format mp3 --limit-rate 1M --no-warnings --cookies ${COOKIES_PATH} -o "${filepath}" "${url}"`;
    await exec(cmd, { maxBuffer: 1024 * 1024 * 100 });

    if (!fs.existsSync(filepath)) throw new Error("Fayl topilmadi.");

    insertFile.run(chatId, "original", null, title, filepath, Date.now());
    await sendAudio(chatId, filepath, title);
    await sendMessage(chatId, "✅ Endi effekt tanlang: /zal /bass /8d");
  } catch (err) {
    console.error("Yuklash xatosi:", err.message);
    await sendMessage(chatId, `❌ Yuklashda xatolik: ${err.message}`);
  }
}

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

async function sendVariantsKeyboard(chatId) {
  const rows = getVariantsForChat.all(chatId);
  const inline = rows.map(r => [{ text: r.title.slice(0, 60), callback_data: String(r.idx) }]);
  await axios.post(`${BASE_URL}/sendMessage`, {
    chat_id: chatId,
    text: "🎶 Quyidagi variantlardan birini tanlang:",
    reply_markup: { inline_keyboard: inline },
  });
}

function applyEffect(input, output, type) {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(input).output(output).audioCodec("libmp3lame");
    if (type === "zal") cmd.audioFilters("aecho=0.8:0.9:1000:0.3");
    else if (type === "bass") cmd.audioFilters("bass=g=10");
    else if (type === "8d") cmd.audioFilters("apulsator=hz=0.125");
    else return reject(new Error("Noma'lum effekt"));
    cmd.on("end", resolve).on("error", reject).run();
  });
}

async function answerCallback(id, text) {
  await axios.post(`${BASE_URL}/answerCallbackQuery`, { callback_query_id: id, text });
}

// === FAYLLARNI TOZALASH ===
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000; // 6 soatdan eski fayllar
  const olds = getFilesOlderThan.all(cutoff);
  olds.forEach(r => {
    try {
      if (fs.existsSync(r.filepath)) fs.unlinkSync(r.filepath);
      deleteFileById.run(r.id);
    } catch {}
  });
}, 2 * 60 * 60 * 1000);

app.get("/", (req, res) => res.send("Bot ishlayapti ✅"));
app.listen(PORT, () => console.log(`🚀 Server port ${PORT} da ishlayapti`));
