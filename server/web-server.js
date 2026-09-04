const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { createServer } = require("node:http");
const { join } = require("node:path");
const { Server } = require("socket.io");
require("dotenv").config();
const PORT = Number(process.env.PORT || 3000);
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE || 12);
const CLIENT_ORIGINS = String(process.env.CLIENT_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const corsOptions = {
  origin: CLIENT_ORIGINS.length ? CLIENT_ORIGINS : true,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-openai-key"],
};

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: corsOptions,
  maxHttpBufferSize: 250_000,
});

const rooms = new Map();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});
const defaultIceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

function getIceServers() {
  if (!process.env.ICE_SERVERS_JSON) return defaultIceServers;
  try {
    const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
    return Array.isArray(parsed) && parsed.length ? parsed : defaultIceServers;
  } catch {
    console.error("ICE_SERVERS_JSON is invalid; using public STUN servers.");
    return defaultIceServers;
  }
}

const LANGUAGES = {
  "pt-BR": "Português do Brasil",
  "en-US": "English",
  "es-ES": "Español",
  "fr-FR": "Français",
  "de-DE": "Deutsch",
  "it-IT": "Italiano",
  "ja-JP": "日本語",
};

function cleanText(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanRoomId(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function roomMembers(roomId) {
  return [...(rooms.get(roomId)?.values() || [])];
}

function publicMember(member) {
  return {
    id: member.id,
    name: member.name,
    language: member.language,
    joinedAt: member.joinedAt,
  };
}

function emitRoomState(roomId) {
  io.to(roomId).emit("room-state", {
    roomId,
    participants: roomMembers(roomId).map(publicMember),
  });
}

function userApiKey(request) {
  const key = String(request.get("x-openai-key") || "").trim();
  return key.startsWith("sk-") && key.length <= 220 ? key : "";
}

async function openAIError(response) {
  try {
    const payload = await response.json();
    return cleanText(payload?.error?.message || "A OpenAI recusou a solicitação.", 300);
  } catch {
    return `A OpenAI respondeu com status ${response.status}.`;
  }
}

app.use(cors(corsOptions));
app.use(express.json({ limit: "16kb" }));

app.post("/api/openai/translate", async (request, response) => {
  const apiKey = userApiKey(request);
  const text = cleanText(request.body?.text, 700);
  const sourceLanguage = LANGUAGES[request.body?.sourceLanguage] ? request.body.sourceLanguage : "auto";
  const targetLanguage = LANGUAGES[request.body?.targetLanguage] ? request.body.targetLanguage : "";
  if (!apiKey) return response.status(401).json({ error: "Chave OpenAI inválida." });
  if (!text || !targetLanguage) return response.status(400).json({ error: "Texto ou idioma inválido." });
  if (sourceLanguage === targetLanguage) return response.json({ text });

  try {
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-nano",
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: `Translate spoken business conversation from ${LANGUAGES[sourceLanguage] || sourceLanguage} to ${LANGUAGES[targetLanguage]}. Return only the natural translation. Preserve names, numbers, acronyms, tone, and meaning.`,
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!upstream.ok) return response.status(upstream.status).json({ error: await openAIError(upstream) });
    const payload = await upstream.json();
    const translated = cleanText(payload.choices?.[0]?.message?.content, 900);
    return response.json({ text: translated || text });
  } catch {
    return response.status(502).json({ error: "Não foi possível acessar a OpenAI." });
  }
});

app.post("/api/openai/transcribe", upload.single("audio"), async (request, response) => {
  const apiKey = userApiKey(request);
  if (!apiKey) return response.status(401).json({ error: "Chave OpenAI inválida." });
  if (!request.file?.buffer?.length) return response.status(400).json({ error: "Áudio não recebido." });

  const form = new FormData();
  form.append("model", "gpt-4o-mini-transcribe");
  const language = cleanText(request.body?.language, 10).slice(0, 2);
  if (language) form.append("language", language);
  form.append("file", new Blob([request.file.buffer], { type: request.file.mimetype || "audio/webm" }), "speech.webm");

  try {
    const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!upstream.ok) return response.status(upstream.status).json({ error: await openAIError(upstream) });
    const payload = await upstream.json();
    return response.json({ text: cleanText(payload.text, 900) });
  } catch {
    return response.status(502).json({ error: "Não foi possível transcrever o áudio." });
  }
});

app.post("/api/openai/speech", async (request, response) => {
  const apiKey = userApiKey(request);
  const text = cleanText(request.body?.text, 1200);
  if (!apiKey) return response.status(401).json({ error: "Chave OpenAI inválida." });
  if (!text) return response.status(400).json({ error: "Texto não recebido." });

  try {
    const upstream = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tts-1", voice: "alloy", input: text, response_format: "mp3", speed: 1.05 }),
    });
    if (!upstream.ok) return response.status(upstream.status).json({ error: await openAIError(upstream) });
    response.set("Content-Type", "audio/mpeg");
    response.set("Cache-Control", "no-store");
    return response.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    return response.status(502).json({ error: "Não foi possível gerar a voz traduzida." });
  }
});

io.on("connection", (socket) => {
  socket.on("join-room", (payload, acknowledge) => {
    const roomId = cleanRoomId(payload?.roomId);
    const name = cleanText(payload?.name, 40);
    const language = LANGUAGES[payload?.language] ? payload.language : "pt-BR";

    if (roomId.length < 4 || !name) {
      acknowledge?.({ ok: false, error: "Informe seu nome e um código de sala válido." });
      return;
    }

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const room = rooms.get(roomId);
    if (room.size >= MAX_ROOM_SIZE) {
      acknowledge?.({ ok: false, error: `Esta sala atingiu o limite de ${MAX_ROOM_SIZE} participantes.` });
      return;
    }

    const existingPeers = [...room.values()].map(publicMember);
    const member = { id: socket.id, name, language, roomId, joinedAt: Date.now() };
    room.set(socket.id, member);
    socket.data.member = member;
    socket.join(roomId);

    acknowledge?.({
      ok: true,
      roomId,
      peers: existingPeers,
      bringYourOwnKey: true,
    });
    socket.to(roomId).emit("peer-joined", publicMember(member));
    emitRoomState(roomId);
  });

  socket.on("signal", ({ target, signal }) => {
    if (!target || !signal || !socket.data.member) return;
    const targetMember = rooms.get(socket.data.member.roomId)?.get(target);
    if (!targetMember) return;
    io.to(target).emit("signal", { from: socket.id, signal });
  });

  socket.on("update-language", (language) => {
    const member = socket.data.member;
    if (!member || !LANGUAGES[language]) return;
    member.language = language;
    emitRoomState(member.roomId);
  });

  socket.on("transcript", ({ text, language }) => {
    const speaker = socket.data.member;
    const original = cleanText(text);
    if (!speaker || !original) return;
    if (Date.now() - Number(socket.data.lastTranscriptAt || 0) < 350) return;
    socket.data.lastTranscriptAt = Date.now();

    io.to(speaker.roomId).emit("source-caption", {
      id: `${socket.id}-${Date.now()}`,
      speakerId: socket.id,
      speakerName: speaker.name,
      text: original,
      sourceLanguage: LANGUAGES[language] ? language : speaker.language,
      createdAt: Date.now(),
    });
  });

  socket.on("disconnect", () => {
    const member = socket.data.member;
    if (!member) return;
    const room = rooms.get(member.roomId);
    room?.delete(socket.id);
    socket.to(member.roomId).emit("peer-left", { id: socket.id });
    if (!room?.size) rooms.delete(member.roomId);
    else emitRoomState(member.roomId);
  });
});

const distPath = join(__dirname, "..", "dist");
app.get("/health", (_request, response) => {
  response.json({ ok: true, rooms: rooms.size, billing: "participant-api-key" });
});
app.get("/api/config", (_request, response) => {
  response.json({
    iceServers: getIceServers(),
    bringYourOwnKey: true,
    maxRoomSize: MAX_ROOM_SIZE,
  });
});
app.use(express.static(distPath));
app.use((_request, response) => {
  response.sendFile(join(distPath, "web", "index.html"));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`PolyCall web server running at http://localhost:${PORT}`);
});
