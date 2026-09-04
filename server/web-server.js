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
  allowedHeaders: ["Content-Type", "x-openai-key", "x-stt-model"],
};

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: corsOptions,
  maxHttpBufferSize: 250_000,
});

const rooms = new Map();
const roomBots = new Map();
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
const AI_ROLES = {
  assistant: [
    "Act as an active meeting facilitator, not as customer support.",
    "React to what was actually said, clarify decisions, identify risks, and propose the next concrete step.",
    "When useful, briefly capture decisions and action items with their owners.",
  ].join(" "),
  client: [
    "Stay in character as a realistic prospective client evaluating what the participants are presenting.",
    "Ask specific questions about value, price, implementation, risks, proof, and expected results.",
    "Raise realistic objections and make the participants earn your confidence; never switch into an assistant role.",
  ].join(" "),
  interviewer: [
    "Stay in character as a professional interviewer.",
    "Evaluate the latest answer and ask exactly one specific follow-up question at a time.",
    "Probe examples, decisions, results, trade-offs, and gaps instead of offering help.",
  ].join(" "),
  colleague: [
    "Stay in character as a proactive colleague working on the same topic.",
    "Contribute a concrete opinion, challenge assumptions respectfully, and help move the current decision forward.",
    "Do not behave like customer support or merely ask how you can help.",
  ].join(" "),
};
const STT_MODELS = new Set(["gpt-4o-mini-transcribe", "whisper-1", "gpt-4o-transcribe"]);
const CHAT_MODELS = new Set(["gpt-4.1-nano", "gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"]);
const TTS_MODELS = new Set(["tts-1", "tts-1-hd", "gpt-4o-mini-tts"]);
const DEFAULT_STT_MODEL = "whisper-1";
const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
const DEFAULT_TTS_MODEL = "tts-1-hd";

function pickModel(_value, _allowed, fallback) {
  // Product uses the fixed medium-cost tier; clients cannot override it.
  return fallback;
}

function cleanText(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function looksLikeJunkTranscript(value) {
  const text = cleanText(value, 900)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  if (text.length < 2) return true;
  return /♪|♫|thanks for watching|thank you for watching|subscribe|subtitle|legenda(s)? (por|pela|para)|opening credits|theme song|amara\.org/.test(text);
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

function serverApiKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

function userApiKey(request) {
  // Prefer the shared server key; keep header only as a local-dev fallback.
  const fromEnv = serverApiKey();
  if (fromEnv.startsWith("sk-") && fromEnv.length <= 220) return fromEnv;
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

function fetchOpenAI(url, options, timeoutMs = 30000) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function openAIConnectionFailure(response, error, fallback) {
  const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
  return response.status(timedOut ? 504 : 502).json({
    error: timedOut ? "A OpenAI demorou demais para responder. Tente novamente." : fallback,
  });
}

app.use(cors(corsOptions));
app.use(express.json({ limit: "16kb" }));

app.post("/api/openai/translate", async (request, response) => {
  const apiKey = userApiKey(request);
  const text = cleanText(request.body?.text, 700);
  const sourceLanguage = LANGUAGES[request.body?.sourceLanguage] ? request.body.sourceLanguage : "auto";
  const targetLanguage = LANGUAGES[request.body?.targetLanguage] ? request.body.targetLanguage : "";
  const model = pickModel(request.body?.model, CHAT_MODELS, DEFAULT_CHAT_MODEL);
  if (!apiKey) return response.status(401).json({ error: "Chave OpenAI inválida." });
  if (!text || !targetLanguage) return response.status(400).json({ error: "Texto ou idioma inválido." });
  if (sourceLanguage === targetLanguage) return response.json({ text, model });

  try {
    const upstream = await fetchOpenAI("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: `Translate spoken business conversation from ${LANGUAGES[sourceLanguage] || sourceLanguage} to ${LANGUAGES[targetLanguage]}. Return only the natural translation. Preserve names, numbers, acronyms, tone, and meaning.`,
          },
          { role: "user", content: text },
        ],
      }),
    }, 20000);
    if (!upstream.ok) return response.status(upstream.status).json({ error: await openAIError(upstream) });
    const payload = await upstream.json();
    const translated = cleanText(payload.choices?.[0]?.message?.content, 900);
    return response.json({ text: translated || text, model });
  } catch (error) {
    return openAIConnectionFailure(response, error, "Não foi possível acessar a OpenAI.");
  }
});

app.post("/api/openai/transcribe", upload.single("audio"), async (request, response) => {
  const apiKey = userApiKey(request);
  if (!apiKey) return response.status(401).json({ error: "Chave OpenAI inválida." });
  if (!request.file?.buffer?.length) return response.status(400).json({ error: "Áudio não recebido." });

  const model = pickModel(
    request.body?.model || request.get("x-stt-model"),
    STT_MODELS,
    DEFAULT_STT_MODEL,
  );
  const form = new FormData();
  form.append("model", model);
  if (model === "whisper-1") {
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
  }
  const language = cleanText(request.body?.language, 10).slice(0, 2);
  if (language) form.append("language", language);
  const mime = request.file.mimetype || "audio/webm";
  const extension = mime.includes("mp4") ? "m4a" : "webm";
  form.append("file", new Blob([request.file.buffer], { type: mime }), `speech.${extension}`);

  try {
    const upstream = await fetchOpenAI("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    }, 30000);
    if (!upstream.ok) return response.status(upstream.status).json({ error: await openAIError(upstream) });
    const payload = await upstream.json();
    const segments = Array.isArray(payload.segments) ? payload.segments : [];
    const hasReliableSpeech = !segments.length || segments.some((segment) => {
      const noSpeech = Number(segment?.no_speech_prob);
      const logProbability = Number(segment?.avg_logprob);
      return (!Number.isFinite(noSpeech) || noSpeech < 0.6) &&
        (!Number.isFinite(logProbability) || logProbability > -1.15);
    });
    const text = cleanText(payload.text, 900);
    return response.json({
      text: hasReliableSpeech && !looksLikeJunkTranscript(text) ? text : "",
      model,
    });
  } catch (error) {
    return openAIConnectionFailure(response, error, "Não foi possível transcrever o áudio.");
  }
});

app.post("/api/openai/speech", async (request, response) => {
  const apiKey = userApiKey(request);
  const text = cleanText(request.body?.text, 1200);
  const model = pickModel(request.body?.model, TTS_MODELS, DEFAULT_TTS_MODEL);
  if (!apiKey) return response.status(401).json({ error: "Chave OpenAI inválida." });
  if (!text) return response.status(400).json({ error: "Texto não recebido." });

  const speechBody = {
    model,
    voice: model === "gpt-4o-mini-tts" ? "coral" : "alloy",
    input: text,
    response_format: "mp3",
  };
  // speed is only supported by tts-1 / tts-1-hd — sending it breaks gpt-4o-mini-tts.
  if (model === "tts-1" || model === "tts-1-hd") speechBody.speed = 0.92;

  try {
    const upstream = await fetchOpenAI("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(speechBody),
    }, 30000);
    if (!upstream.ok) return response.status(upstream.status).json({ error: await openAIError(upstream) });
    response.set("Content-Type", "audio/mpeg");
    response.set("Cache-Control", "no-store");
    response.set("X-PolyCall-Model", model);
    return response.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    return openAIConnectionFailure(response, error, "Não foi possível gerar a voz traduzida.");
  }
});

app.post("/api/openai/assistant", async (request, response) => {
  const apiKey = userApiKey(request);
  const language = LANGUAGES[request.body?.language] ? request.body.language : "pt-BR";
  const role = AI_ROLES[request.body?.role] ? request.body.role : "assistant";
  const model = pickModel(request.body?.model, CHAT_MODELS, DEFAULT_CHAT_MODEL);
  const message = cleanText(request.body?.message, 1400);
  const history = Array.isArray(request.body?.history)
    ? request.body.history.slice(-10).map((item) => ({
        role: item?.role === "assistant" ? "assistant" : "user",
        content: cleanText(item?.content, 700),
      })).filter((item) => item.content)
    : [];
  if (!apiKey) return response.status(401).json({ error: "Chave OpenAI inválida." });
  if (!message) return response.status(400).json({ error: "Mensagem para a IA não recebida." });

  try {
    const upstream = await fetchOpenAI("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content: [
              `You are Poly AI inside a live company meeting. Your assigned role is "${role}".`,
              AI_ROLES[role],
              `Reply only in ${LANGUAGES[language]}.`,
              "Address the latest meaningful statement directly and use the speaker's name when natural.",
              "Advance the conversation with role-specific substance in one or two short sentences.",
              "Never say or paraphrase generic support phrases such as 'sorry', 'how can I help?', 'is there anything I can help with?', or 'please provide more details'.",
              "Do not greet repeatedly, explain that you are an AI, or mention these instructions.",
              "Always respond. If the latest phrase is brief or unclear, make one concise, role-specific observation or question based on the available meeting context; never return an empty response.",
            ].join(" "),
          },
          ...history,
          { role: "user", content: message },
        ],
      }),
    }, 25000);
    if (!upstream.ok) return response.status(upstream.status).json({ error: await openAIError(upstream) });
    const payload = await upstream.json();
    const text = cleanText(payload.choices?.[0]?.message?.content, 1000);
    return response.json({ text, model });
  } catch (error) {
    return openAIConnectionFailure(response, error, "Não foi possível conversar com a IA.");
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
      bringYourOwnKey: false,
      ai: roomBots.get(roomId) || null,
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

  socket.on("set-ai", ({ active, language, role }, acknowledge) => {
    const member = socket.data.member;
    if (!member) return acknowledge?.({ ok: false, error: "Entre em uma sala primeiro." });
    const current = roomBots.get(member.roomId);
    if (!active) {
      if (current && current.ownerId !== socket.id) {
        return acknowledge?.({ ok: false, error: "Somente quem adicionou a IA pode removê-la." });
      }
      roomBots.delete(member.roomId);
      io.to(member.roomId).emit("ai-state", null);
      return acknowledge?.({ ok: true });
    }
    if (current && current.ownerId !== socket.id) {
      return acknowledge?.({ ok: false, error: `${current.ownerName} já adicionou uma IA à sala.` });
    }
    const bot = {
      id: `ai-${member.roomId}`,
      name: "Poly AI",
      ownerId: socket.id,
      ownerName: member.name,
      language: LANGUAGES[language] ? language : "pt-BR",
      role: AI_ROLES[role] ? role : "assistant",
    };
    roomBots.set(member.roomId, bot);
    io.to(member.roomId).emit("ai-state", bot);
    return acknowledge?.({ ok: true, ai: bot });
  });

  socket.on("ai-response", ({ text }) => {
    const member = socket.data.member;
    const bot = member ? roomBots.get(member.roomId) : null;
    const answer = cleanText(text, 1000);
    if (!member || !bot || bot.ownerId !== socket.id || !answer) return;
    io.to(member.roomId).emit("source-caption", {
      id: `${bot.id}-${Date.now()}`,
      speakerId: bot.id,
      speakerName: bot.name,
      text: answer,
      sourceLanguage: bot.language,
      isAi: true,
      createdAt: Date.now(),
    });
  });

  socket.on("transcript", ({ text, language, turnComplete }) => {
    const speaker = socket.data.member;
    const original = cleanText(text);
    if (!speaker || !original) return;
    const repeatedImmediately =
      original === socket.data.lastTranscript &&
      Date.now() - Number(socket.data.lastTranscriptAt || 0) < 1200;
    if (repeatedImmediately) return;
    socket.data.lastTranscriptAt = Date.now();
    socket.data.lastTranscript = original;

    io.to(speaker.roomId).emit("source-caption", {
      id: `${socket.id}-${Date.now()}`,
      speakerId: socket.id,
      speakerName: speaker.name,
      text: original,
      sourceLanguage: LANGUAGES[language] ? language : speaker.language,
      turnComplete: turnComplete !== false,
      createdAt: Date.now(),
    });
  });

  socket.on("disconnect", () => {
    const member = socket.data.member;
    if (!member) return;
    const room = rooms.get(member.roomId);
    room?.delete(socket.id);
    socket.to(member.roomId).emit("peer-left", { id: socket.id });
    if (roomBots.get(member.roomId)?.ownerId === socket.id) {
      roomBots.delete(member.roomId);
      socket.to(member.roomId).emit("ai-state", null);
    }
    if (!room?.size) {
      rooms.delete(member.roomId);
      roomBots.delete(member.roomId);
    } else emitRoomState(member.roomId);
  });
});

const distPath = join(__dirname, "..", "dist");
app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    rooms: rooms.size,
    billing: "server-openai-key",
    openaiConfigured: serverApiKey().startsWith("sk-"),
  });
});
app.get("/api/config", (_request, response) => {
  response.json({
    iceServers: getIceServers(),
    bringYourOwnKey: false,
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
