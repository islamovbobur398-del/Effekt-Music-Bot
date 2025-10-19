// index.js
import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import Database from "better-sqlite3";
import ffmpeg from "fluent-ffmpeg";
import { promisify } from "util";
import { exec as execCb } from "child_process";
import yts from "yt-search";

const exec = promisify(execCb);

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;
const STORAGE_DIR = process.env.STORAGE_DIR || "/data/files";

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN environment variable not set!");
  process.exit(1);
}

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// --- Database setup ---
const dbPath = path.join(STORAGE_DIR, "bot.db");
const db = new Database(dbPath);

// tables: search_variants (stores last searches per chat) and files (original/effect files)
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
CREATE INDEX IF NOT EXISTS idx_chat ON search_variants(chat_id);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  kind TEXT,    -- original | effect
  effect TEXT,  -- null | 'zal'|'bass'|'8d'
  title TEXT,
  filepath TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_files_chat ON files(chat_id);
`);

const insertVariant = db.prepare(`INSERT INTO search_variants (chat_id, idx, title, video_id, url, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
const clearVariantsForChat = db.prepare(`DELETE FROM search_variants WHERE chat_id = ?`);
const getVariantsForChat = db.prepare(`SELECT idx, title, video_id, url FROM search_variants WHERE chat_id = ? ORDER BY idx ASC`);
const getVariant = db.prepare(`SELECT idx, title, video_id, url FROM search_variants WHERE chat_id = ? AND idx = ? LIMIT 1`);

const insertFile = db.prepare(`INSERT INTO files (chat_id, kind, effect, title, filepath, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
const getLatestOriginal = db.prepare(`SELECT * FROM files WHERE chat_id = ? AND kind = 'original' ORDER BY created_at DESC LIMIT 1`);
const getFilesOlderThan = db.prepare(`SELECT * FROM files WHERE created_at <= ?`);
const deleteFileById = db.prepare(`DELETE FROM files WHERE id = ?`);

// --- Express setup ---
const app = express();
app.use(express.json());

// single webhook endpoint
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // respond quickly to Telegram
  try {
    const body = req.body;

    // handle callback_query (inline button)
    if (body.callback_query) {
      const cq = body.callback_query;
      const chatId = String(cq.message.chat.id);
      const data = cq.data; // we use index as callback_data
      if (!data) {
        await answerCallback(cq.id, "Noma'lum tanlov");
        return;
      }
      if (data.startsWith("demo__")) {
        // demo fallback
        const idx = parseInt(data.split("__")[1], 10);
        const title = `Demo Variant ${idx + 1}`;
        const url = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";
        await answerCallback(cq.id, "Yuklanmoqda...");
        await handleChosenVariant(chatId, idx, title, url, null);
        return;
      }

      const idx = parseInt(data, 10);
      const row = getVariant.get(chatId, idx);
      if (!row) {
        await answerCallback(cq.id, "⚠️ Tanlov topilmadi.");
        return;
      }
      await answerCallback(cq.id, `Yuklanmoqda: ${row.title}`);
      await handleChosenVariant(chatId, idx, row.title, row.url, row.video_id);
      return;
    }

    // handle regular message
    const message = body.message || body.edited_message;
    if (!message || !message.text) return;
    const chatId = String(message.chat.id);
    const text = message.text.trim();

    // commands
    if (text === "/start") {
      await sendMessage(chatId, "🎵 Salom! Menga qo‘shiq yoki artist nomini yozing. Men YouTube orqali 10 ta variant topaman.");
      return;
    }

    if (text === "/zal" || text === "/bass" || text === "/8d") {
      const effect = text.replace("/", "");
      const latest = getLatestOriginal.get(chatId);
      if (!latest) {
        await sendMessage(chatId, "⚠️ Avval musiqani yuklang (variant tanlang).");
        return;
      }
      const originalPath = latest.filepath;
      const outName = `${chatId}_${effect}_${Date.now()}.mp3`;
      const outPath = path.join(STORAGE_DIR, outName);
      await sendMessage(chatId, `🎚 ${effect.toUpperCase()} effekti yaratilmoqda...`);
      try {
        await applyEffect(originalPath, outPath, effect);
        insertFile.run(chatId, "effect", effect, latest.title, outPath, Date.now());
        await sendAudio(chatId, outPath, `${effect.toUpperCase()} - ${latest.title}`);
      } catch (e) {
        console.error("applyEffect error", e);
        await sendMessage(chatId, `❌ Effektda xatolik: ${e.message || e}`);
      }
      return;
    }

    // else: treat as search query -> YouTube search 10 results
    await sendMessage(chatId, `🔎 "${text}" uchun YouTube'dan qidirilmoqda... Iltimos kuting.`);

    // clear previous variants for this chat
    clearVariantsForChat.run(chatId);

    // yt-search
    const searchRes = await yts(text);
    const videos = (searchRes && searchRes.videos) ? searchRes.videos.slice(0, 10) : [];

    if (!videos.length) {
      // fallback demo variants
      const demo = Array.from({ length: 5 }).map((_, i) => ({
        title: `${text} Demo ${i+1}`,
        url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
        videoId: null
      }));
      demo.forEach((v, i) => insertVariant.run(chatId, i, v.title, v.videoId, v.url, Date.now()));
      await sendMessage(chatId, "⚠️ YouTube'dan topilmadi. Demo variantlar yuborildi.");
      await sendVariantsKeyboard(chatId);
      return;
    }

    videos.forEach((v, i) => {
      const title = v.title;
      const videoId = v.videoId;
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      insertVariant.run(chatId, i, title, videoId, url, Date.now());
    });

    await sendVariantsKeyboard(chatId);
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

// helper: answer callback query
async function answerCallback(callbackId, text) {
  try {
    await axios.post(`${BASE_URL}/answerCallbackQuery`, { callback_query_id: callbackId, text });
  } catch (e) { console.warn("answerCallback error", e.message || e); }
}

// send inline keyboard of variants
async function sendVariantsKeyboard(chatId) {
  const rows = getVariantsForChat.all(chatId);
  if (!rows || rows.length === 0) {
    await sendMessage(chatId, "❌ Variantlar topilmadi.");
    return;
  }
  const inline = rows.map(r => [{ text: r.title.substring(0, 60), callback_data: String(r.idx) }]);
  await axios.post(`${BASE_URL}/sendMessage`, {
    chat_id: Number(chatId),
    text: "🎶 Quyidagi variantlardan birini tanlang:",
    reply_markup: { inline_keyboard: inline },
  });
}

// download chosen variant: if videoId provided use yt-dlp, else try direct URL stream
async function handleChosenVariant(chatId, idx, title, url, videoId) {
  try {
    await sendMessage(chatId, `⬇️ '${title}' yuklanmoqda...`);

    // determine output path
    const safeTitle = title.replace(/[^a-zA-Z0-9_\- ]/g, "").slice(0, 60);
    const filename = `${chatId}_original_${videoId ? videoId : Date.now()}.mp3`;
    const filepath = path.join(STORAGE_DIR, filename);

    if (videoId) {
      // use yt-dlp to download audio as mp3
      // output template uses %(ext)s, but we set .mp3 by audio-format
      const cmd = `yt-dlp -q -f bestaudio --extract-audio --audio-format mp3 -o "${path.join(STORAGE_DIR, `${chatId}_original_${videoId}.%(ext)s`)}" "https://www.youtube.com/watch?v=${videoId}"`;
      await exec(cmd, { maxBuffer: 1024 * 1024 * 50 });
    } else {
      // fallback: direct download via axios stream
      const res = await axios.get(url, { responseType: "stream", timeout: 30000 });
      const writer = fs.createWriteStream(filepath);
      await new Promise((resolve, reject) => {
        res.data.pipe(writer);
        let err = null;
        writer.on("error", e => { err = e; writer.close(); reject(e); });
        writer.on("close", () => { if (!err) resolve(); });
      });
    }

    // compute final mp3 path when videoId used
    const finalPath = videoId ? path.join(STORAGE_DIR, `${chatId}_original_${videoId}.mp3`) : filepath;

    // double-check file exists and size
    if (!fs.existsSync(finalPath)) {
      await sendMessage(chatId, "❌ Yuklashda muammo bo‘ldi: fayl topilmadi.");
      return;
    }
    const stats = fs.statSync(finalPath);
    if (stats.size < 1000) {
      await sendMessage(chatId, "❌ Yuklangan fayl juda kichik, boshqa variant tanlang.");
      return;
    }

    // save record to DB
    insertFile.run(chatId, "original", null, title, finalPath, Date.now());

    // send original audio to user
    await sendAudio(chatId, finalPath, title);

    await sendMessage(chatId, "✅ Yuklandi! Endi effekt tanlang:\n/zal — Zal\n/bass — Bass\n/8d — 8D");

  } catch (err) {
    console.error("handleChosenVariant error:", err);
    await sendMessage(chatId, `❌ Yuklashda xatolik: ${err.message || err}`);
  }
}

// send audio file by multipart/form-data
async function sendAudio(chatId, filePath, title) {
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("title", title);
    form.append("audio", fs.createReadStream(filePath));
    await axios.post(`${BASE_URL}/sendAudio`, form, { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity });
  } catch (err) {
    console.error("sendAudio error", err.message || err);
    await sendMessage(chatId, "⚠️ Audio yuborishda xatolik yuz berdi.");
  }
}

// apply audio effects with ffmpeg
function applyEffect(inputPath, outputPath, type) {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputPath).output(outputPath).audioCodec("libmp3lame");
    if (type === "zal") cmd.audioFilters("aecho=0.8:0.9:1000:0.3");
    else if (type === "bass") cmd.audioFilters("bass=g=10");
    else if (type === "8d") cmd.audioFilters("apulsator=hz=0.125");
    else return reject(new Error("Noma'lum effekt"));
    cmd.on("end", resolve).on("error", reject).run();
  });
}

// cleanup files older than 24 hours
setInterval(() => {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const olds = getFilesOlderThan.all(cutoff);
    olds.forEach(r => {
      try {
        if (fs.existsSync(r.filepath)) fs.unlinkSync(r.filepath);
        deleteFileById.run(r.id);
      } catch (e) { console.warn("cleanup err", e.message || e); }
    });
  } catch (e) { console.error("cleanup interval error", e); }
}, 60 * 60 * 1000); // hourly

// health check root
app.get("/", (req, res) => res.send("Bot ishlayapti ✅"));

// start server
app.listen(PORT, () => console.log(`Server ishlayapti port ${PORT}`));
