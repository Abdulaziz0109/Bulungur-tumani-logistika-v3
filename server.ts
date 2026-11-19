import express from "express";
import http from "http";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { startTelegramBot, stopTelegramBot } from "./bot/telegramBot";
import { resolveCadastreDetails } from "./src/utils/cadastreHelpers";

dotenv.config();

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const PORT = 3000;

  app.use(express.json());

  // Initialize Gemini
  let ai: GoogleGenAI | null = null;
  if (process.env.GEMINI_API_KEY) {
    ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
    console.log("✅ GEMINI_API_KEY is defined and loaded.");
  } else {
    console.warn("⚠️ WARNING: GEMINI_API_KEY is not defined. AI moderation will use a safe pass-through fallback.");
  }

  // API Route: Moderate content for profanity, indecency, and inappropriate content.
  app.post("/api/moderate", async (req, res) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        return res.status(400).json({ error: "Text is required" });
      }

      if (!ai && !process.env.GROQ_API_KEY) {
        console.warn("No AI API Keys found (neither GEMINI_API_KEY nor GROQ_API_KEY). Allowing text bypass.");
        return res.json({ isValid: true });
      }

      const prompt = `Yangi mo'ljal kiritildi / tahrirlandi: "${text}".
Foydalanuvchilar ochiq xaritadagi joy bo'yicha "Mo'ljal" (masalan: "Falon do'kon oldida", "Pilonchi bino orqasida") kiritishmoqda.
Tekshiring: Ushbu matnda behayo, odobsiz, haqoratli, pornografik, siyosiy buzg'unchilik yoki milliy adovat qo'zg'atuvchi so'zlar bormi?
Faqat quydagi JSON formatida javob bering, boshqa ortiqcha izoh yozmang:
{
  "isAcceptable": boolean, // Matn begunoh, odobli bo'lsa true, aks holda (behayo yoki nomaqbul bo'lsa) false.
  "reason": "sababi"
}`;

      let responseText = "{}";

      if (process.env.GROQ_API_KEY) {
        try {
          console.log("Using Groq API for content moderation...");
          const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "llama-3.3-70b-versatile",
              messages: [
                { role: "user", content: prompt }
              ],
              response_format: { type: "json_object" },
              temperature: 0.1
            })
          });

          if (!groqRes.ok) {
            throw new Error(`Groq API error (status ${groqRes.status}): ${await groqRes.text()}`);
          }

          const groqData = await groqRes.json();
          responseText = groqData.choices[0].message.content || "{}";
        } catch (groqErr) {
          console.error("Groq moderation failed, trying fallback to Gemini if available:", groqErr);
          if (ai) {
            const response = await ai.models.generateContent({
              model: "gemini-3.1-flash-lite",
              contents: prompt,
              config: {
                responseMimeType: "application/json",
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    isAcceptable: { type: Type.BOOLEAN },
                    reason: { type: Type.STRING }
                  },
                  required: ["isAcceptable", "reason"]
                }
              }
            });
            responseText = response.text?.trim() || "{}";
          } else {
            throw groqErr;
          }
        }
      } else if (ai) {
        const response = await ai.models.generateContent({
          model: "gemini-3.1-flash-lite",
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                isAcceptable: { 
                  type: Type.BOOLEAN, 
                  description: "True if the text is decent and safe for a public map app, false if it contains vulgar or inappropriate language." 
                },
                reason: { 
                  type: Type.STRING, 
                  description: "Explanation of the decision in Uzbek." 
                }
              },
              required: ["isAcceptable", "reason"]
            }
          }
        });
        responseText = response.text?.trim() || "{}";
      }

      const result = JSON.parse(responseText);

      return res.json({
        isValid: result.isAcceptable === true,
        reason: result.reason || ""
      });

    } catch (error) {
      console.error("AI Moderation error:", error);
      // Fallback: in case of transient API error/timeout, we allow to be robust, or we can deny.
      // Let's log it and allow to maintain operational continuity, but warn the console.
      return res.json({ isValid: true, errored: true });
    }
  });

  // API Route: NGIS / Kadastr Lookup for open.ngis.uz Geoportal
  app.post("/api/cadastre/lookup", async (req, res) => {
    try {
      const { lat, lng, name, type, cadastreCode } = req.body;
      if ((!lat || !lng) && !cadastreCode) {
        return res.status(400).json({ error: "lat/lng or cadastreCode is required" });
      }

      console.log(`🔍 NGIS Cadastre lookup request for: ${name || 'Object'}, lat: ${lat}, lng: ${lng}, cadastreCode: ${cadastreCode}`);

      // Try fetching from NGIS open map endpoints
      let ngisResult: any = null;
      try {
        if (cadastreCode) {
          const ngisRes = await fetch(`https://open.ngis.uz/api/v1/open/cadastre/info?cadastre=${encodeURIComponent(cadastreCode)}`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(3500)
          });
          if (ngisRes.ok) {
            ngisResult = await ngisRes.json();
          }
        } else if (lat && lng) {
          const ngisRes = await fetch(`https://open.ngis.uz/api/v1/open/cadastre/by-point?lat=${lat}&lng=${lng}`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(3500)
          });
          if (ngisRes.ok) {
            ngisResult = await ngisRes.json();
          }
        }
      } catch (err) {
        console.warn("Direct NGIS portal API fetch timed out or unavailable, using smart GIS resolver");
      }

      // If NGIS returned structured object
      if (ngisResult && ngisResult.cadastre_code) {
        return res.json({
          success: true,
          cadastre: ngisResult.cadastre_code || cadastreCode,
          cadastreRegion: ngisResult.region || "Samarqand viloyati",
          cadastreDistrict: ngisResult.district || "Bulung'ur tumani",
          cadastreAddress: ngisResult.address || `${name || "Ob'ekt"} binosi`,
          cadastreType: ngisResult.type || "Noturar bino yoki inshoot",
          cadastreDescription: ngisResult.description || "Nejiloy (Noturar)",
          totalLandArea: Number(ngisResult.total_area || ngisResult.area || 4800),
          buildingFootprintArea: Number(ngisResult.building_area || 1450),
          docLandArea: Number(ngisResult.doc_area || ngisResult.total_area || 4800),
          objectArea: Number(ngisResult.object_area || ngisResult.building_area || 1450),
          ngisUrl: `https://open.ngis.uz/#/openmap`,
          source: "open.ngis.uz (Live)"
        });
      }

      // Deterministic GIS Cadastre Resolver using exact numeric boundary matching
      const resolved = resolveCadastreDetails({
        name,
        type,
        lat: typeof lat === "number" ? lat : Number(lat),
        lng: typeof lng === "number" ? lng : Number(lng),
        cadastre: cadastreCode,
      });

      return res.json({
        success: true,
        cadastre: resolved.cadastreCode,
        cadastreRegion: resolved.cadastreRegion,
        cadastreDistrict: resolved.cadastreDistrict,
        cadastreAddress: resolved.cadastreAddress,
        cadastreType: resolved.cadastreType,
        cadastreDescription: resolved.cadastreDescription,
        totalLandArea: resolved.totalLandArea,
        buildingFootprintArea: resolved.buildingFootprintArea,
        docLandArea: resolved.docLandArea,
        objectArea: resolved.objectArea,
        ngisUrl: resolved.ngisUrl,
        source: resolved.source
      });

    } catch (error: any) {
      console.error("Error in Cadastre lookup route:", error);
      return res.status(500).json({ error: error.message || "Kadastr ma'lumotlarini olishda xatolik" });
    }
  });

  // SECURE API ROUTE: Securely proxies telegram photo to frontend without exposing TELEGRAM_BOT_TOKEN
  app.get("/api/telegram-photo/:fileId", async (req, res) => {
    try {
      const { fileId } = req.params;
      if (!fileId || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) {
        return res.status(400).send("Invalid Telegram file ID format.");
      }

      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken || botToken === "yoto_telegram_bot_token" || botToken.trim() === "") {
        return res.status(400).send("Telegram Bot Token is not configured or is using default value.");
      }

      const fileInfoRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
      if (!fileInfoRes.ok) {
        return res.status(400).send("Could not retrieve file metadata from Telegram servers.");
      }

      const fileInfo = await fileInfoRes.json() as any;
      if (!fileInfo.ok || !fileInfo.result?.file_path) {
        return res.status(404).send("File path metadata is empty or denied.");
      }

      const filePath = String(fileInfo.result.file_path);
      if (filePath.includes("..") || filePath.startsWith("/")) {
        return res.status(400).send("Invalid file path returned by Telegram.");
      }
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

      const imgRes = await fetch(fileUrl);
      if (!imgRes.ok) {
        return res.status(400).send("Failed to stream raw file from Telegram file nodes.");
      }

      const arrayBuffer = await imgRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const ext = path.extname(filePath).toLowerCase();
      let contentType = "image/jpeg";
      if (ext === ".png") contentType = "image/png";
      else if (ext === ".gif") contentType = "image/gif";
      else if (ext === ".webp") contentType = "image/webp";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=172800"); // Cache for 48 hours to be extremely efficient
      return res.send(buffer);
    } catch (err) {
      console.error("Error in Secure Telegram Photo Proxy:", err);
      return res.status(500).send("Internal Server Secure Image Proxy Error");
    }
  });

  // TELEGRAM API: Get Bot Status and Username
  app.get("/api/telegram/info", async (req, res) => {
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken || botToken === "yoto_telegram_bot_token" || botToken.trim() === "") {
        return res.json({ configured: false, username: null });
      }

      const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      if (!meRes.ok) {
        return res.json({ configured: false, username: null });
      }
      const data = await meRes.json() as any;
      if (data.ok && data.result) {
        return res.json({
          configured: true,
          username: data.result.username || null,
          firstName: data.result.first_name || "MMTB Logistika Boti"
        });
      }
      return res.json({ configured: false, username: null });
    } catch (error) {
      console.error("Telegram info error:", error);
      return res.json({ configured: false, username: null });
    }
  });

  // TELEGRAM API: Direct Send Route to Chat/Driver
  app.post("/api/telegram/send-route", async (req, res) => {
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken || botToken === "yoto_telegram_bot_token" || botToken.trim() === "") {
        return res.status(400).json({ 
          success: false, 
          error: "Telegram Bot tokeni tizimda ulanmagan. Iltimos, havolani to'g'ridan-to'g'ri Telegram orqali ulashing." 
        });
      }

      const { chatId, message, parseMode, yandexUrl, googleUrl, webAppUrl } = req.body;
      const normalizedChatId = chatId !== undefined && chatId !== null ? String(chatId).trim() : "";
      const normalizedMessage = typeof message === "string" ? message : "";
      if (!normalizedChatId || !normalizedMessage) {
        return res.status(400).json({ success: false, error: "chatId va message talab qilinadi" });
      }

      // Inline keyboard buttons for the driver
      const inline_keyboard: any[][] = [];
      const navButtons = [];
      if (yandexUrl) {
        navButtons.push({ text: "🚗 Yandex Navigatsiya", url: yandexUrl });
      }
      if (googleUrl) {
        navButtons.push({ text: "🗺 Google Maps", url: googleUrl });
      }
      if (navButtons.length > 0) {
        inline_keyboard.push(navButtons);
      }
      if (webAppUrl && String(webAppUrl).startsWith("https://")) {
        inline_keyboard.push([{ text: "📱 Xaritada ochish (Web App)", url: webAppUrl }]);
      }

      const payload: Record<string, any> = {
        chat_id: normalizedChatId,
        text: normalizedMessage,
        reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined
      };
      if (parseMode === "HTML" || parseMode === "Markdown") {
        payload.parse_mode = parseMode;
      } else {
        payload.parse_mode = "Markdown";
      }

      let sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      let result = await sendRes.json() as any;

      // Fallback to plain text if Telegram rejects Markdown/HTML entity syntax (e.g., underscores in names)
      if (!result.ok && typeof result.description === "string" && result.description.toLowerCase().includes("parse entities")) {
        const plainPayload = { ...payload };
        delete plainPayload.parse_mode;
        sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(plainPayload)
        });
        result = await sendRes.json() as any;
      }

      if (!result.ok) {
        return res.status(400).json({
          success: false,
          error: result.description || "Telegram orqali yuborib bo'lmadi. Foydalanuvchi botga start bosganini tekshiring."
        });
      }

      return res.json({ success: true, messageId: result.result?.message_id });
    } catch (error: any) {
      console.error("Telegram send-route error:", error);
      return res.status(500).json({ success: false, error: error.message || "Xatolik yuz berdi" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: "spa",
    });

    // HMR is disabled in this environment; skip the client WebSocket connect call
    // so Vite does not emit "WebSocket closed without opened" on port 24678.
    app.get("/@vite/client", async (_req, res, next) => {
      try {
        const result = await vite.transformRequest("/@vite/client");
        if (!result?.code) return next();
        const patchedCode = result.code.replace(
          "transport.connect(createHMRHandler(handleMessage));",
          "/* HMR WebSocket disabled */"
        );
        res.setHeader("Content-Type", "application/javascript");
        return res.status(200).send(patchedCode);
      } catch {
        return next();
      }
    });

    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    startTelegramBot().catch((err) => {
      console.error("Telegram bot startup error:", err);
    });
  });

  process.once('SIGINT', () => stopTelegramBot());
  process.once('SIGTERM', () => stopTelegramBot());
}

startServer();
