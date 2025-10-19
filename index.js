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
const STORAGE_DIR = process.env.STORAGE_DIR || "/data/files"; // Docker konteynerda mavjud bo'lishi kerak

if (!BOT_TOKEN || !SERPAPI_KEY) {
  console.error("BOT_TOKEN va SERPAPI_KEY environment variables ni o'rnat !");
  process.exit(1);
}

// papkani yarat
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

// SQLite DB (fayl storage)
const dbPath = path.join(STORAGE_DIR, "bot.db");
const db = new Database(dbPath);

// Jadvalni yaratamiz: users, search_variants, files
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
  kind TEXT, -- original|effect
  effect TEXT, -- null or 'zal'|'bass'|'8d'
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
const getFileByPath = db.prepare(`SELECT * FROM files WHERE filepath = ? LIMIT 1`);
const deleteOldFiles = db.prepare(`SELECT * FROM files WHERE created_at <= ?`);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Telegram webhook endpoint
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Telegram'ga tez javob beramiz
  try {
    const body = req.body;
    const message = body.message || body.edited_message;
    if (!message) return;

    const chatId = String(message.chat.id);
    const text = (message.text || "").trim();

    if (!text) {
      await sendMessage(chatId, "Iltimos matnli xabar yuboring (qo'shiq yoki artist nomi).");
      return;
    }

    if (text === "/start") {
      await sendMessage(chatId, "🎵 Salom! Menga qo'shiq yoki ijrochi nomini yozing. Men 10 ta variant topaman va siz tanlaysiz.");
      return;
    }

    // effekt komandalar
    if (text === "/zal" || text === "/bass" || text === "/8d") {
      const effect = text.replace("/", "");
      // olish oxirgi original fayl
      const row = getFile.get(chatId);
      if (!row) {
        await sendMessage(chatId, "⚠️ Avval original musiqani yuklang (variant tanlang).");
        return;
      }
      const originalPath = row.filepath;
      const outName = `${chatId}_${effect}_${Date.now()}.mp3`;
      const outPath = path.join(STORAGE_DIR, outName);
      await sendMessage(chatId, `🎚 ${effect.toUpperCase()} effekti yaratilmoqda...`);
      try {
        await applyEffect(originalPath, outPath, effect);
        insertFile.run(chatId, "effect", effect, row.title, outPath, Date.now());
        await sendAudioFile(chatId, outPath, `${effect.toUpperCase()} versiya - ${row.title}`);
      } catch (err) {
        console.error("Effect error:", err);
        await sendMessage(chatId, `❌ Effektda xatolik: ${err.message || err}`);
      }
      return;
    }

    // agar bu callback_query bilan kelmadi, lekin foydalanuvchi tugma bosishi orqali variant tanlash
    if (message.reply_to_message && message.text && message.text.startsWith("PICK:")) {
      // not used; our bot uses inline keyboard callbacks via callback_query endpoint
      return;
    }

    // oddiy matn: qidiruv
    await sendMessage(chatId, `🔎 "${text}" uchun qidirilmoqda... Iltimos kuting.`);

    // o'zgaruvchilarni o'chirib yangi qidiruvni saqlaymiz
    clearVariantsForChat.run(chatId);

    // SerpApi chaqiruv
    const params = {
      engine: "google",
      q: `${text} filetype:mp3`,
      num: 10,
      api_key: SERPAPI_KEY,
    };

    const searchRes = await axios.get("https://serpapi.com/search.json", { params });
    const results = (searchRes.data.organic_results || []).slice(0, 10);

    if (!results.length) {
      // demo fallback
      const demoVariants = Array.from({ length: 10 }).map((_, i) => ({
        title: `${text} Variant ${i + 1}`,
        link: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
      }));
      demoVariants.forEach((v, i) => insertVariant.run(chatId, i, v.title, v.link, Date.now()));
      await sendMessage(chatId, "⚠️ Onlayn mp3 topilmadi. Demo variantlar yuborildi.");
      await sendVariantsKeyboard(chatId);
      return;
    }

    // saqlash va inline keyboard bilan yuborish
    results.forEach((r, i) => {
      const url = r.link || r.url || (r.rich_snippet && r.rich_snippet.top && r.rich_snippet.top.source);
      const title = r.title || r.snippet || `Variant ${i + 1}`;
      if (url) insertVariant.run(chatId, i, title, url, Date.now());
    });

    await sendVariantsKeyboard(chatId);
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

// Telegram callback_query endpoint (webhook will also POST callback_query here in same /webhook body)
// But Express receives callback_query in /webhook POST body too — handle callback_query inside same webhook handler:
app.post("/webhook-callback", async (req, res) => {
  res.sendStatus(200);
});

// However, Telegram sends callback_query in the same webhook POST; so better parse below:
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // already done above; duplicate safe
});

// Instead, add separate route for handling callback_query via Telegram's update object:
// We'll create a middleware that handles callback_query type from webhook (some providers send them together).
app.post("/updates", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.callback_query) {
    const cq = body.callback_query;
    const chatId = String(cq.message.chat.id);
    const data = cq.data; // expecting index like "0","1",...
    // if it's demo__ prefix
    if (data && data.startsWith("demo__")) {
      const idx = parseInt(data.split("__")[1], 10);
      const title = `Demo Variant ${idx + 1}`;
      const url = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";
      await handleChosenVariant(chatId, idx, title, url);
      // answer callback (ack)
      await answerCallbackQuery(cq.id, "Yuklanmoqda...");
      return;
    }
    const idx = parseInt(data, 10);
    const row = getVariant.get(chatId, idx);
    if (!row) {
      await answerCallbackQuery(cq.id, "⚠️ Tanlov topilmadi.");
      return;
    }
    await answerCallbackQuery(cq.id, `Yuklanmoqda: ${row.title}`);
    await handleChosenVariant(chatId, idx, row.title, row.url);
  }
});

// Small helper to answer callback_query
async function answerCallbackQuery(callback_id, text) {
  try {
    await axios.post(`${BASE_URL}/answerCallbackQuery`, { callback_query_id: callback_id, text });
  } catch (err) {
    console.warn("answerCallbackQuery error", err.message || err);
  }
}

// yuborish: variantlarni inline keyboard bilan yuborish
async function sendVariantsKeyboard(chatId) {
  const rows = getVariantsForChat.all(chatId);
  if (!rows || !rows.length) {
    await sendMessage(chatId, "❌ Variantlar topilmadi.");
    return;
  }
  const inline = rows.map((r) => [{ text: r.title.substring(0, 60), callback_data: String(r.idx) }]);
  await axios.post(`${BASE_URL}/sendMessage`, {
    chat_id: Number(chatId),
    text: "🎶 Quyidagi variantlardan birini tanlang:",
    reply_markup: { inline_keyboard: inline },
  });
}

// handler: user tanlagan variant (yuklab olish, originalni yuborish va DB saqlash)
async function handleChosenVariant(chatId, idx, title, url) {
  try {
    await sendMessage(chatId, `⬇️ '${title}' yuklanmoqda...`);
    // yuklab oling
    const res = await axios.get(url, { responseType: "stream", timeout: 30000 });
    // check size header
    const contentLength = res.headers["content-length"] ? parseInt(res.headers["content-length"], 10) : null;
    if (contentLength && contentLength > 50 * 1024 * 1024) {
      await sendMessage(chatId, "❌ Fayl juda katta (max 50MB). Iltimos boshqa variant tanlang.");
      return;
    }
    const filename = `${chatId}_original_${Date.now()}.mp3`;
    const filepath = path.join(STORAGE_DIR, filename);
    const writer = fs.createWriteStream(filepath);
    await new Promise((resolve, reject) => {
      res.data.pipe(writer);
      let error = null;
      writer.on("error", (err) => {
        error = err; writer.close(); reject(err);
      });
      writer.on("close", () => {
        if (!error) resolve();
      });
    });

    // DBga saqlash
    insertFile.run(chatId, "original", null, title, filepath, Date.now());

    // yuborish
    await sendAudioFile(chatId, filepath, title);

    await sendMessage(chatId, "✅ Yuklandi! Endi effekt tanlang:\n/zal — Zal effekti\n/bass — Bass effekti\n/8d — 8D effekti");

  } catch (err) {
    console.error("handleChosenVariant error:", err);
    await sendMessage(chatId, `❌ Yuklash vaqti xatolik: ${err.message || err}`);
  }
}

// send simple text message
async function sendMessage(chatId, text) {
  try {
    await axios.post(`${BASE_URL}/sendMessage`, { chat_id: Number(chatId), text, parse_mode: "HTML" });
  } catch (err) {
    console.warn("sendMessage failed:", err.message || err);
  }
}

// send audio by multipart/form-data
async function sendAudioFile(chatId, filePath, title) {
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("title", title);
    form.append("audio", fs.createReadStream(filePath));
    await axios.post(`${BASE_URL}/sendAudio`, form, { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity });
  } catch (err) {
    console.error("sendAudioFile error:", err.message || err);
    // fallback: give URL or error message
    await sendMessage(chatId, "⚠️ Audio yuborishda xatolik yuz berdi.");
  }
}

// apply ffmpeg effect
function applyEffect(inputPath, outputPath, type) {
  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath).output(outputPath).audioCodec("libmp3lame");

    if (type === "zal") {
      command.audioFilters("aecho=0.8:0.9:1000:0.3");
    } else if (type === "bass") {
      // bass filter: boost low frequencies
      command.audioFilters("bass=g=10");
    } else if (type === "8d") {
      // 8D-like effect using apulsator or stereo panning
      // prefer apulsator if available, else use stereoize + pan
      command.audioFilters("apulsator=hz=0.125");
    } else {
      return reject(new Error("Unknown effect"));
    }

    command.on("end", () => resolve()).on("error", (err) => reject(err)).run();
  });
}

// FILE CLEANUP: fayllarni 24 soatdan (86400*1000 ms) eski bo'lsa o'chiradi
setInterval(() => {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const olds = deleteOldFiles.all(cutoff);
    olds.forEach((r) => {
      try {
        if (fs.existsSync(r.filepath)) fs.unlinkSync(r.filepath);
        // ham DB yozuvini ham o'chirish
        db.prepare(`DELETE FROM files WHERE id = ?`).run(r.id);
      } catch (e) {
        console.warn("cleanup file error", e.message || e);
      }
    });
    // ham search_variants ham kerak bo'lsa eski yozuvlar uchun tozalash qilinishi mumkin (lekin talab bo'lmasa qoldiramiz)
  } catch (e) {
    console.error("cleanup interval error", e);
  }
}, 60 * 60 * 1000); // har 1 soatda tekshiradi

// start Express
app.listen(PORT, () => {
  console.log(`Server ishlayapti port ${PORT}`);
});
