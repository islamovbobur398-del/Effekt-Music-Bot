// index.js — ANIMATSIYALI VERSIYA 🎬

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
axios.defaults.timeout = 60000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;
const STORAGE_DIR = process.env.STORAGE_DIR || "/data/files";
const COOKIES_PATH = "/app/cookies.txt";

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN topilmadi!");
  process.exit(1);
}

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// === DATABASE ===
const db = new Database(path.join(STORAGE_DIR, "bot.db"));
db.exec(`
CREATE TABLE IF NOT EXISTS search_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  idx INTEGER,
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

const insertVariant = db.prepare(`INSERT INTO search_variants VALUES (NULL,?,?,?,?,?,?)`);
const clearVariants = db.prepare(`DELETE FROM search_variants WHERE chat_id=?`);
const getVariants = db.prepare(`SELECT * FROM search_variants WHERE chat_id=? ORDER BY idx`);
const getVariant = db.prepare(`SELECT * FROM search_variants WHERE chat_id=? AND idx=?`);
const insertFile = db.prepare(`INSERT INTO files VALUES (NULL,?,?,?,?,?,?)`);
const getLatestOriginal = db.prepare(`SELECT * FROM files WHERE chat_id=? AND kind='original' ORDER BY created_at DESC LIMIT 1`);
const oldFiles = db.prepare(`SELECT * FROM files WHERE created_at<=?`);
const delFile = db.prepare(`DELETE FROM files WHERE id=?`);

// === EXPRESS APP ===
const app = express();
app.use(express.json());

// 🔹 Telegram "action" (jonli animatsiya) funksiyasi
async function sendAction(chatId, action) {
  await axios.post(`${BASE_URL}/sendChatAction`, { chat_id: chatId, action });
}

// 🔹 Oddiy xabar yuborish
async function sendMessage(chatId, text) {
  await axios.post(`${BASE_URL}/sendMessage`, { chat_id: chatId, text });
}

// 🔹 Inline tugmalar bilan yuborish
async function sendVariantsKeyboard(chatId) {
  const rows = getVariants.all(chatId);
  if (!rows.length) return sendMessage(chatId, "❌ Natijalar topilmadi.");
  const inline = rows.map(r => [{ text: r.title.slice(0, 60), callback_data: String(r.idx) }]);
  await axios.post(`${BASE_URL}/sendMessage`, {
    chat_id: chatId,
    text: "🎶 Quyidagi variantlardan birini tanlang:",
    reply_markup: { inline_keyboard: inline },
  });
}

// === WEBHOOK ===
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;

    // Callback bosilganda
    if (body.callback_query) {
      const cq = body.callback_query;
      const chatId = String(cq.message.chat.id);
      const idx = parseInt(cq.data, 10);
      const row = getVariant.get(chatId, idx);
      if (!row) return;

      await sendAction(chatId, "upload_audio");
      await handleDownload(chatId, row.title, row.url, row.video_id);
      return;
    }

    // Oddiy xabar
    const msg = body.message;
    if (!msg || !msg.text) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    // 🔹 /start
    if (text === "/start") {
      return sendMessage(chatId, "👋 Salom! Menga qo‘shiq nomini yozing — men topib, effektlar bilan yuboraman 🎧");
    }

    // 🔹 Effektlar
    if (["/zal", "/bass", "/8d"].includes(text)) {
      const effect = text.slice(1);
      const latest = getLatestOriginal.get(chatId);
      if (!latest) return sendMessage(chatId, "⚠️ Avval musiqani yuklang.");

      const output = path.join(STORAGE_DIR, `${chatId}_${effect}_${Date.now()}.mp3`);
      await sendAction(chatId, "record_voice");
      await sendMessage(chatId, `🎚 ${effect.toUpperCase()} effekti yaratilmoqda...`);

      await applyEffect(latest.filepath, output, effect);
      insertFile.run(chatId, "effect", effect, latest.title, output, Date.now());
      return sendAudio(chatId, output, `${effect.toUpperCase()} - ${latest.title}`);
    }

    // 🔹 Qidiruv
    await sendAction(chatId, "typing");
    await sendMessage(chatId, `🔎 "${text}" qidirilmoqda...`);

    clearVariants.run(chatId);
    const yts = (await import("yt-search")).default;
    const result = await yts(text);
    const vids = result.videos.slice(0, 10);
    if (!vids.length) return sendMessage(chatId, "❌ Natija topilmadi.");

    vids.forEach((v, i) => insertVariant.run(null, chatId, i, v.title, v.videoId, v.url, Date.now()));
    await sendVariantsKeyboard(chatId);
  } catch (e) {
    console.error("Webhook xato:", e);
  }
});

// === MUSIQA YUKLASH FUNKSIYASI ===
async function handleDownload(chatId, title, url, videoId) {
  try {
    await sendAction(chatId, "upload_audio");
    await sendMessage(chatId, `⏳ Yuklanmoqda: ${title}`);

    const filepath = path.join(STORAGE_DIR, `${chatId}_original_${videoId}.mp3`);
    const cmd = `yt-dlp -x --audio-format mp3 --cookies ${COOKIES_PATH} -o "${filepath}" "${url}"`;
    await exec(cmd, { maxBuffer: 1024 * 1024 * 100 });

    insertFile.run(null, chatId, "original", null, title, filepath, Date.now());
    await sendAudio(chatId, filepath, title);
    await sendMessage(chatId, "✅ Yuklandi! Endi effekt tanlang:\n/zal — Zal\n/bass — Bass\n/8d — 8D");
  } catch (err) {
    console.error("Yuklash xatosi:", err.message);
    await sendMessage(chatId, `❌ Yuklashda xatolik: ${err.message}`);
  }
}

// === AUDIO YUBORISH ===
async function sendAudio(chatId, filePath, title) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("title", title);
  form.append("audio", fs.createReadStream(filePath));
  await axios.post(`${BASE_URL}/sendAudio`, form, { headers: form.getHeaders() });
}

// === EFFEKT QO‘LLASH ===
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

// === FAYL TOZALOVCHI ===
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const olds = oldFiles.all(cutoff);
  olds.forEach(r => {
    try {
      if (fs.existsSync(r.filepath)) fs.unlinkSync(r.filepath);
      delFile.run(r.id);
    } catch {}
  });
}, 2 * 60 * 60 * 1000);

app.get("/", (req, res) => res.send("Bot ishlayapti ✅"));
app.listen(PORT, () => console.log(`🚀 Server port ${PORT} da ishlayapti`));
