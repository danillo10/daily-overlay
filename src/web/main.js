import { io } from "socket.io-client";

const $ = (id) => document.getElementById(id);
const API_ORIGIN = String(
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? "http://localhost:3000" : "https://polycall-api-production.up.railway.app"),
).replace(/\/$/, "");
const LANGUAGE_LABELS = {
  "pt-BR": { short: "PT", name: "Português" },
  "en-US": { short: "EN", name: "English" },
  "es-ES": { short: "ES", name: "Español" },
  "fr-FR": { short: "FR", name: "Français" },
  "de-DE": { short: "DE", name: "Deutsch" },
  "it-IT": { short: "IT", name: "Italiano" },
  "ja-JP": { short: "JA", name: "日本語" },
};

const state = {
  socket: null,
  stream: null,
  peers: new Map(),
  participants: [],
  roomId: "",
  name: "",
  language: "pt-BR",
  joinedAt: 0,
  timer: null,
  recognition: null,
  recognitionActive: false,
  micEnabled: true,
  cameraEnabled: true,
  voiceEnabled: true,
  originalVolume: Number(sessionStorage.getItem("polycall_original_volume") || 12) / 100,
  translatedVolume: Number(sessionStorage.getItem("polycall_translated_volume") || 100) / 100,
  captionTimer: null,
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }],
  apiKey: sessionStorage.getItem("polycall_openai_key") || "",
  apiOrigin: API_ORIGIN,
  transcriptionTimer: null,
  transcriptionGeneration: 0,
  transcriptionBusy: 0,
  lastTranscript: "",
  lastAiSpoken: "",
  audioCtx: null,
  analyser: null,
  vadRaf: 0,
  utteranceRecorder: null,
  utteranceChunks: [],
  utteranceActive: false,
  silenceStartedAt: 0,
  speechStarted: false,
  utteranceStartedAt: 0,
  remoteGains: new Map(),
  ttsQueue: [],
  ttsPlaying: false,
  ttsAudio: null,
  listenCooldownUntil: 0,
  ai: null,
  aiHistory: [],
  aiBuffer: [],
  aiTimer: null,
  aiBusy: false,
  chatOpen: false,
  chatMessages: [],
  sttModel: sessionStorage.getItem("polycall_stt_model") || "gpt-4o-mini-transcribe",
  chatModel: sessionStorage.getItem("polycall_chat_model") || "gpt-4.1-nano",
  ttsModel: sessionStorage.getItem("polycall_tts_model") || "tts-1",
};

const ui = {
  lobby: $("lobby"),
  meeting: $("meeting"),
  joinForm: $("joinForm"),
  joinCard: document.querySelector(".join-card"),
  displayName: $("displayName"),
  language: $("language"),
  apiKey: $("apiKey"),
  roomCode: $("roomCode"),
  formError: $("formError"),
  primaryAction: $("primaryAction"),
  switchMode: $("switchMode"),
  localVideo: $("localVideo"),
  localTile: $("localTile"),
  localName: $("localName"),
  localInitials: $("localInitials"),
  localLanguage: $("localLanguage"),
  videoGrid: $("videoGrid"),
  participantList: $("participantList"),
  participantCount: $("participantCount"),
  sidebarCount: $("sidebarCount"),
  meetingTimer: $("meetingTimer"),
  roomBadge: $("roomBadge"),
  meetingName: $("meetingName"),
  meetingLanguage: $("meetingLanguage"),
  voiceEnabled: $("voiceEnabled"),
  originalVolume: $("originalVolume"),
  originalVolumeValue: $("originalVolumeValue"),
  translatedVolume: $("translatedVolume"),
  translatedVolumeValue: $("translatedVolumeValue"),
  translationStatus: $("translationStatus"),
  connectionLabel: $("connectionLabel"),
  copyInvite: $("copyInvite"),
  toggleMic: $("toggleMic"),
  toggleCamera: $("toggleCamera"),
  toggleChat: $("toggleChat"),
  leaveMeeting: $("leaveMeeting"),
  chatOverlay: $("chatOverlay"),
  chatLog: $("chatLog"),
  copyChat: $("copyChat"),
  clearChat: $("clearChat"),
  closeChat: $("closeChat"),
  sttModel: $("sttModel"),
  chatModel: $("chatModel"),
  ttsModel: $("ttsModel"),
  chatVoiceEnabled: $("chatVoiceEnabled"),
  liveCaption: $("liveCaption"),
  captionSpeaker: $("captionSpeaker"),
  captionLanguage: $("captionLanguage"),
  captionText: $("captionText"),
  aiPanel: document.querySelector(".ai-panel"),
  aiSettings: $("aiSettings"),
  aiRole: $("aiRole"),
  aiLanguage: $("aiLanguage"),
  toggleAi: $("toggleAi"),
  aiHint: $("aiHint"),
  toast: $("toast"),
};

ui.apiKey.value = state.apiKey;
if (ui.sttModel) ui.sttModel.value = state.sttModel;
if (ui.chatModel) ui.chatModel.value = state.chatModel;
if (ui.ttsModel) ui.ttsModel.value = state.ttsModel;
if (ui.voiceEnabled) ui.voiceEnabled.checked = state.voiceEnabled;
if (ui.chatVoiceEnabled) ui.chatVoiceEnabled.checked = state.voiceEnabled;
let joinMode = new URLSearchParams(location.search).has("room");
const roomFromUrl = new URLSearchParams(location.search).get("room");
if (roomFromUrl) ui.roomCode.value = normalizeRoomId(roomFromUrl);
setJoinMode(joinMode);

function normalizeRoomId(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function generateRoomId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function initials(name) {
  return String(name || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setJoinMode(enabled) {
  joinMode = enabled;
  ui.joinCard.classList.toggle("join-mode", enabled);
  ui.roomCode.required = enabled;
  ui.primaryAction.querySelector("span").textContent = enabled ? "Entrar na sala" : "Criar nova sala";
  ui.switchMode.textContent = enabled ? "Quero criar uma nova sala" : "Já tenho um código de sala";
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => ui.toast.classList.remove("show"), 2400);
}

ui.switchMode.addEventListener("click", () => {
  setJoinMode(!joinMode);
  ui.formError.textContent = "";
  if (joinMode) ui.roomCode.focus();
});

ui.roomCode.addEventListener("input", () => {
  ui.roomCode.value = normalizeRoomId(ui.roomCode.value);
});

ui.joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  ui.formError.textContent = "";
  const name = ui.displayName.value.trim();
  const apiKey = ui.apiKey.value.trim();
  const roomId = joinMode ? normalizeRoomId(ui.roomCode.value) : generateRoomId();
  if (!name || roomId.length < 4 || !apiKey.startsWith("sk-")) {
    ui.formError.textContent = "Preencha seu nome, a chave OpenAI e um código de sala válido.";
    return;
  }

  ui.primaryAction.disabled = true;
  ui.primaryAction.querySelector("span").textContent = "Preparando sala...";
  try {
    await joinMeeting({ name, roomId, language: ui.language.value, apiKey });
  } catch (error) {
    ui.formError.textContent = error.message || "Não foi possível entrar na sala.";
    stopLocalStream();
  } finally {
    ui.primaryAction.disabled = false;
    ui.primaryAction.querySelector("span").textContent = joinMode ? "Entrar na sala" : "Criar nova sala";
  }
});

function micAudioConstraints() {
  // Prefer voiceIsolation when available so only near-mic speech from this call is captured.
  return {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    voiceIsolation: { ideal: true },
    channelCount: 1,
  };
}

async function getLocalMedia() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: micAudioConstraints(),
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    });
  } catch (videoError) {
    try {
      state.cameraEnabled = false;
      return await navigator.mediaDevices.getUserMedia({
        audio: micAudioConstraints(),
        video: false,
      });
    } catch {
      state.cameraEnabled = false;
      state.micEnabled = false;
      showToast("Você entrou sem câmera e microfone");
      return new MediaStream();
    }
  }
}

async function joinMeeting({ name, roomId, language, apiKey }) {
  state.name = name;
  state.roomId = roomId;
  state.language = language;
  state.apiKey = apiKey;
  sessionStorage.setItem("polycall_openai_key", apiKey);
  try {
    const config = await fetch(`${state.apiOrigin}/api/config`).then((response) => response.json());
    if (Array.isArray(config.iceServers) && config.iceServers.length) state.iceServers = config.iceServers;
  } catch {
    // Public STUN defaults keep local development available if config cannot be loaded.
  }
  state.stream = await getLocalMedia();

  state.socket = io(state.apiOrigin, { transports: ["websocket", "polling"], timeout: 8000 });
  registerSocketEvents();

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("O servidor de reuniões não respondeu.")), 9000);
    state.socket.once("connect_error", () => {
      clearTimeout(timeout);
      reject(new Error("Não foi possível conectar ao servidor de reuniões."));
    });
    state.socket.emit("join-room", { name, roomId, language }, (response) => {
      clearTimeout(timeout);
      if (!response?.ok) {
        reject(new Error(response?.error || "Não foi possível entrar na sala."));
        return;
      }
      state.ai = response.ai || null;
      for (const peer of response.peers) createPeer(peer.id, true);
      resolve();
    });
  });

  state.joinedAt = Date.now();
  setupMeetingUi();
  startRecognition();
  history.replaceState({}, "", `${location.pathname}?room=${roomId}`);
}

function registerSocketEvents() {
  state.socket.on("peer-joined", (participant) => {
    if (!state.peers.has(participant.id)) createPeer(participant.id, false);
  });

  state.socket.on("signal", async ({ from, signal }) => {
    const pc = state.peers.get(from) || createPeer(from, false);
    try {
      if (signal.type === "offer") {
        await pc.setRemoteDescription(signal);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        state.socket.emit("signal", { target: from, signal: pc.localDescription });
      } else if (signal.type === "answer") {
        await pc.setRemoteDescription(signal);
      } else if (signal.candidate) {
        await pc.addIceCandidate(signal);
      }
    } catch (error) {
      console.error("WebRTC signaling error", error);
    }
  });

  state.socket.on("room-state", ({ participants }) => {
    state.participants = participants;
    renderParticipants();
    applyRemoteVolumes();
  });

  state.socket.on("peer-left", ({ id }) => removePeer(id));
  state.socket.on("source-caption", (source) => {
    processSourceCaption(source);
    // Own speech already schedules the AI locally after transcription.
    if (!source.isAi && source.speakerId !== state.socket?.id) scheduleAiResponse(source);
  });
  state.socket.on("ai-state", (ai) => {
    state.ai = ai;
    if (!ai) {
      state.aiHistory = [];
      state.aiBuffer = [];
      clearTimeout(state.aiTimer);
    }
    renderAiState();
    renderParticipants();
  });
  state.socket.on("disconnect", () => {
    ui.connectionLabel.textContent = "Reconectando...";
  });
  state.socket.on("connect", () => {
    if (state.joinedAt) ui.connectionLabel.textContent = "Conexão estável";
  });
}

function createPeer(peerId, shouldOffer) {
  const pc = new RTCPeerConnection({
    iceServers: state.iceServers,
  });
  state.peers.set(peerId, pc);

  for (const track of state.stream.getTracks()) pc.addTrack(track, state.stream);
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) state.socket.emit("signal", { target: peerId, signal: candidate });
  };
  pc.ontrack = ({ streams }) => {
    if (streams[0]) attachRemoteStream(peerId, streams[0]);
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) removePeer(peerId);
  };

  if (shouldOffer) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => state.socket.emit("signal", { target: peerId, signal: pc.localDescription }))
      .catch((error) => console.error("Could not create WebRTC offer", error));
  }
  return pc;
}

function attachRemoteStream(peerId, stream) {
  let tile = document.querySelector(`[data-peer="${peerId}"]`);
  if (!tile) {
    tile = document.createElement("article");
    tile.className = "video-tile remote";
    tile.dataset.peer = peerId;
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <div class="camera-placeholder"><span>?</span><p>Câmera desativada</p></div>
      <div class="tile-info"><span>Participante</span></div>
      <div class="tile-status"><span>--</span><i class="mic-indicator"></i></div>
    `;
    ui.videoGrid.appendChild(tile);
  }
  const video = tile.querySelector("video");
  video.srcObject = stream;
  // Mute element audio and route through GainNode so ducking works reliably.
  video.muted = true;
  tile.classList.toggle("has-video", stream.getVideoTracks().length > 0);
  updateRemoteTile(peerId);
  updateVideoGridLayout();
  void wireRemoteAudio(peerId, stream);
  applyRemoteVolumes();
}

async function ensureAudioCtx() {
  if (!state.audioCtx || state.audioCtx.state === "closed") {
    state.audioCtx = new AudioContext();
  }
  if (state.audioCtx.state === "suspended") await state.audioCtx.resume();
  return state.audioCtx;
}

function disconnectRemoteAudio(routed) {
  if (!routed) return;
  try { routed.source.disconnect(); } catch { /* ignore */ }
  try { routed.gain.disconnect(); } catch { /* ignore */ }
  try { routed.dest?.disconnect(); } catch { /* ignore */ }
  if (routed.audioEl) {
    try {
      routed.audioEl.pause();
      routed.audioEl.srcObject = null;
    } catch { /* ignore */ }
  }
}

async function wireRemoteAudio(peerId, stream) {
  if (!stream.getAudioTracks().length) return;
  try {
    const ctx = await ensureAudioCtx();
    const previous = state.remoteGains.get(peerId);
    disconnectRemoteAudio(previous);

    // Play through an HTMLAudioElement so browser AEC can cancel this call's
    // remote audio from the mic (Web Audio → destination alone skips AEC).
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    gain.gain.value = duckLevelForPeer(peerId);
    source.connect(gain);
    gain.connect(dest);

    const audioEl = previous?.audioEl || new Audio();
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.setAttribute("playsinline", "true");
    audioEl.srcObject = dest.stream;
    void audioEl.play().catch(() => {});

    state.remoteGains.set(peerId, { source, gain, dest, audioEl, stream });
  } catch (error) {
    console.error("Remote audio routing failed", error);
  }
}

function updateRemoteTile(peerId) {
  const tile = document.querySelector(`[data-peer="${peerId}"]`);
  const participant = state.participants.find((person) => person.id === peerId);
  if (!tile || !participant) return;
  tile.querySelector(".camera-placeholder span").textContent = initials(participant.name);
  tile.querySelector(".tile-info span").textContent = participant.name;
  tile.querySelector(".tile-status span").textContent = LANGUAGE_LABELS[participant.language]?.short || "--";
}

function removePeer(peerId) {
  state.peers.get(peerId)?.close();
  state.peers.delete(peerId);
  const routed = state.remoteGains.get(peerId);
  if (routed) {
    disconnectRemoteAudio(routed);
    state.remoteGains.delete(peerId);
  }
  document.querySelector(`[data-peer="${peerId}"]`)?.remove();
  updateVideoGridLayout();
}

function setupMeetingUi() {
  ui.lobby.classList.add("hidden");
  ui.meeting.classList.remove("hidden");
  ui.localVideo.srcObject = state.stream;
  ui.localTile.classList.toggle("has-video", state.stream.getVideoTracks().length > 0);
  ui.localName.textContent = state.name;
  ui.localInitials.textContent = initials(state.name);
  ui.localLanguage.textContent = LANGUAGE_LABELS[state.language].short;
  ui.meetingLanguage.value = state.language;
  ui.roomBadge.textContent = state.roomId;
  ui.meetingName.textContent = `Reunião ${state.roomId}`;
  ui.connectionLabel.textContent = "Conexão estável";
  ui.toggleCamera.classList.toggle("off", !state.cameraEnabled);
  ui.toggleMic.classList.toggle("off", !state.micEnabled);
  ui.translationStatus.textContent = "Fale naturalmente. Após ~1s de silêncio a frase fecha e a IA responde mais rápido.";
  void ensureAudioCtx();
  syncVolumeUi();
  applyRemoteVolumes();
  state.timer = setInterval(updateTimer, 1000);
  renderAiState();
  updateVideoGridLayout();
  updateTimer();
}

function updateVideoGridLayout() {
  const count = ui.videoGrid.querySelectorAll(".video-tile").length || 1;
  ui.videoGrid.dataset.count = String(Math.min(12, count));
}

function renderParticipants() {
  const count = state.participants.length + (state.ai ? 1 : 0);
  ui.participantCount.textContent = `${count} ${count === 1 ? "participante" : "participantes"}`;
  ui.sidebarCount.textContent = count;
  const people = state.participants.map((participant) => {
    const self = participant.id === state.socket.id;
    return `
      <div class="participant-row">
        <div class="participant-avatar">${escapeHtml(initials(participant.name))}</div>
        <div class="participant-info">
          <strong>${escapeHtml(participant.name)}${self ? " (você)" : ""}</strong>
          <small>${escapeHtml(LANGUAGE_LABELS[participant.language]?.name || participant.language)}</small>
        </div>
        <span>${LANGUAGE_LABELS[participant.language]?.short || "--"}</span>
      </div>
    `;
  });
  if (state.ai) {
    people.push(`
      <div class="participant-row ai">
        <div class="participant-avatar">✦</div>
        <div class="participant-info">
          <strong>${escapeHtml(state.ai.name)}</strong>
          <small>${escapeHtml(LANGUAGE_LABELS[state.ai.language]?.name || state.ai.language)} · IA</small>
        </div>
        <span>${LANGUAGE_LABELS[state.ai.language]?.short || "AI"}</span>
      </div>
    `);
  }
  ui.participantList.innerHTML = people.join("");
  for (const participant of state.participants) updateRemoteTile(participant.id);
  updateVideoGridLayout();
}

function renderAiState() {
  const active = Boolean(state.ai);
  const isOwner = state.ai?.ownerId === state.socket?.id;
  ui.aiPanel.classList.toggle("active", active);
  ui.aiSettings.classList.toggle("locked", active);
  ui.aiRole.value = state.ai?.role || ui.aiRole.value;
  ui.aiLanguage.value = state.ai?.language || ui.aiLanguage.value;
  ui.toggleAi.disabled = active && !isOwner;
  ui.toggleAi.innerHTML = active
    ? isOwner ? "<span>×</span> Remover IA" : "<span>✦</span> IA na sala"
    : "<span>✦</span> Adicionar IA";
  ui.aiHint.textContent = active
    ? isOwner
      ? "A IA responde após ~1s de silêncio e fala em ritmo natural."
      : `${state.ai.ownerName} adicionou a IA à conversa.`
    : "A IA responderá depois que você falar.";
  if (active && isOwner && !state.voiceEnabled) {
    setVoiceEnabled(true);
    showToast("Voz da tradução/IA ligada automaticamente");
  }

  let tile = document.querySelector(".ai-tile");
  if (!active) {
    tile?.remove();
    updateVideoGridLayout();
    return;
  }
  if (!tile) {
    tile = document.createElement("article");
    tile.className = "video-tile ai-tile";
    tile.innerHTML = `
      <div class="camera-placeholder"><span>✦</span><p>Participante inteligente</p></div>
      <div class="tile-info"><span>Poly AI</span><small>IA</small></div>
      <div class="tile-status"><span>AI</span><i class="mic-indicator"></i></div>
    `;
    ui.videoGrid.appendChild(tile);
  }
  tile.querySelector(".tile-status span").textContent = LANGUAGE_LABELS[state.ai.language]?.short || "AI";
  updateVideoGridLayout();
}

ui.toggleAi.addEventListener("click", async () => {
  const isOwner = state.ai?.ownerId === state.socket?.id;
  if (state.ai && !isOwner) return;
  ui.toggleAi.disabled = true;
  try {
    await ensureAudioCtx();
    await ensureVoices();
    // Unlock browser audio/speech on the same user gesture as adding the AI.
    if (window.speechSynthesis) {
      const warm = new SpeechSynthesisUtterance(" ");
      warm.volume = 0;
      window.speechSynthesis.speak(warm);
      window.speechSynthesis.cancel();
    }
  } catch { /* ignore unlock errors */ }
  state.socket.emit("set-ai", {
    active: !state.ai,
    language: ui.aiLanguage.value,
    role: ui.aiRole.value,
  }, (result) => {
    ui.toggleAi.disabled = false;
    if (!result?.ok) showToast(result?.error || "Não foi possível alterar a IA.");
    else if (!state.ai) showToast("IA adicionada · a voz será ativada nas respostas");
  });
});

function scheduleAiResponse(source) {
  if (!state.ai || state.ai.ownerId !== state.socket?.id) return;
  state.aiBuffer.push(`${source.speakerName}: ${source.text}`);
  state.aiBuffer = state.aiBuffer.slice(-4);
  clearTimeout(state.aiTimer);
  state.aiTimer = setTimeout(requestAiResponse, 150);
}

async function requestAiResponse() {
  if (state.aiBusy || !state.ai || state.ai.ownerId !== state.socket?.id || !state.aiBuffer.length) return;
  const message = state.aiBuffer.join("\n");
  state.aiBuffer = [];
  state.aiBusy = true;
  document.querySelector(".ai-tile")?.classList.add("thinking");
  ui.aiHint.textContent = "Poly AI está pensando...";
  try {
    const response = await fetch(`${state.apiOrigin}/api/openai/assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-openai-key": state.apiKey },
      body: JSON.stringify({
        message,
        language: state.ai.language,
        role: state.ai.role,
        history: state.aiHistory,
        model: selectedModels().chatModel,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "A IA não conseguiu responder.");
    if (payload.text) {
      state.aiHistory.push({ role: "user", content: message }, { role: "assistant", content: payload.text });
      state.aiHistory = state.aiHistory.slice(-10);

      let speakText = payload.text;
      let translated = false;
      if (state.ai.language !== state.language) {
        try {
          const translatedResponse = await fetch(`${state.apiOrigin}/api/openai/translate`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-openai-key": state.apiKey },
            body: JSON.stringify({
              text: payload.text,
              sourceLanguage: state.ai.language,
              targetLanguage: state.language,
              model: selectedModels().chatModel,
            }),
          });
          const translatedPayload = await translatedResponse.json();
          if (!translatedResponse.ok) throw new Error(translatedPayload.error || "Falha na tradução da IA.");
          if (translatedPayload.text) {
            speakText = translatedPayload.text;
            translated = true;
          }
        } catch (error) {
          ui.translationStatus.textContent = error.message;
        }
      }

      state.lastAiSpoken = speakText;
      // Owner hears/sees immediately without waiting for the socket round-trip.
      handleCaption({
        id: `ai-local-${Date.now()}`,
        speakerId: state.ai.id,
        speakerName: state.ai.name,
        text: speakText,
        original: translated ? payload.text : "",
        sourceLanguage: state.ai.language,
        targetLanguage: state.language,
        translated,
        isAi: true,
        createdAt: Date.now(),
      });
      state.socket.emit("ai-response", { text: payload.text });
    }
  } catch (error) {
    ui.translationStatus.textContent = error.message;
    showToast(error.message);
  } finally {
    state.aiBusy = false;
    document.querySelector(".ai-tile")?.classList.remove("thinking");
    if (state.ai?.ownerId === state.socket?.id) {
      ui.aiHint.textContent = "A IA responde após ~1s de silêncio e fala em ritmo natural.";
    }
    if (state.aiBuffer.length) state.aiTimer = setTimeout(requestAiResponse, 200);
  }
}

function updateTimer() {
  const elapsed = Math.max(0, Math.floor((Date.now() - state.joinedAt) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  ui.meetingTimer.textContent = hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function startRecognition() {
  state.recognitionActive = false;
  state.transcriptionGeneration += 1;
  clearTimeout(state.transcriptionTimer);
  cancelAnimationFrame(state.vadRaf);
  stopUtteranceRecorder(false);

  const audioTrack = state.stream.getAudioTracks()[0];
  if (!audioTrack || !window.MediaRecorder) {
    ui.translationStatus.textContent = "Este navegador não oferece gravação de áudio compatível.";
    return;
  }

  state.recognitionActive = true;
  state.speechStarted = false;
  state.silenceStartedAt = 0;
  state.utteranceStartedAt = 0;
  const generation = state.transcriptionGeneration;
  void (async () => {
    try {
      const ctx = await ensureAudioCtx();
      const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      state.analyser = analyser;
      const data = new Uint8Array(analyser.fftSize);

      const tick = () => {
        if (!state.recognitionActive || generation !== state.transcriptionGeneration) return;
        // Ignore mic while call TTS is playing so speakers/echo aren't transcribed.
        if (state.ttsPlaying || Date.now() < state.listenCooldownUntil) {
          if (state.utteranceActive) stopUtteranceRecorder(false);
          state.speechStarted = false;
          state.silenceStartedAt = 0;
          state.utteranceStartedAt = 0;
          state.vadRaf = requestAnimationFrame(tick);
          return;
        }
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const centered = (data[i] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        const speaking = rms > 0.028;

        if (speaking) {
          state.speechStarted = true;
          state.silenceStartedAt = 0;
          if (!state.utteranceActive) {
            state.utteranceStartedAt = Date.now();
            startUtteranceRecorder(audioTrack, generation);
          } else if (state.utteranceStartedAt && Date.now() - state.utteranceStartedAt >= 5500) {
            // Force-flush long continuous speech so the pipeline never stalls.
            state.speechStarted = false;
            state.silenceStartedAt = 0;
            state.utteranceStartedAt = 0;
            stopUtteranceRecorder(true);
          }
        } else if (state.speechStarted) {
          if (!state.silenceStartedAt) state.silenceStartedAt = Date.now();
          if (Date.now() - state.silenceStartedAt >= 1100) {
            state.speechStarted = false;
            state.silenceStartedAt = 0;
            state.utteranceStartedAt = 0;
            stopUtteranceRecorder(true);
          }
        }
        state.vadRaf = requestAnimationFrame(tick);
      };
      state.vadRaf = requestAnimationFrame(tick);
      ui.translationStatus.textContent = "Ouvindo... ao pausar ~1s a frase vai para o chat/IA.";
    } catch (error) {
      ui.translationStatus.textContent = error.message || "Não foi possível iniciar a captura de fala.";
    }
  })();
}

function startUtteranceRecorder(audioTrack, generation) {
  if (state.utteranceActive || generation !== state.transcriptionGeneration) return;
  const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
    .find((type) => MediaRecorder.isTypeSupported(type));
  const chunks = [];
  const recorder = new MediaRecorder(new MediaStream([audioTrack]), mimeType ? { mimeType } : undefined);
  state.utteranceChunks = chunks;
  state.utteranceRecorder = recorder;
  state.utteranceActive = true;
  state.recognition = recorder;
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.onstop = () => {
    state.utteranceActive = false;
    state.utteranceRecorder = null;
    if (!recorder._shouldFlush || generation !== state.transcriptionGeneration) return;
    if (!chunks.length) return;
    void transcribeChunk(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
  };
  try {
    recorder.start(250);
  } catch (error) {
    state.utteranceActive = false;
    ui.translationStatus.textContent = error.message || "Falha ao gravar a fala.";
  }
}

function stopUtteranceRecorder(shouldFlush) {
  const recorder = state.utteranceRecorder;
  if (!recorder) {
    state.utteranceActive = false;
    return;
  }
  recorder._shouldFlush = Boolean(shouldFlush);
  if (recorder.state === "recording") {
    try { recorder.requestData(); } catch { /* ignore */ }
    try { recorder.stop(); } catch { /* ignore */ }
  } else {
    state.utteranceActive = false;
    state.utteranceRecorder = null;
  }
}

function similarTranscript(a, b) {
  const x = String(a || "").toLowerCase().replace(/\s+/g, " ").trim();
  const y = String(b || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.abs(x.length - y.length) < 10 && (x.includes(y) || y.includes(x));
}

async function transcribeChunk(blob) {
  if (blob.size < 900) return;
  if (state.transcriptionBusy >= 2) return;
  state.transcriptionBusy += 1;
  ui.translationStatus.textContent = "Fechando frase e enviando para interpretação...";
  const form = new FormData();
  form.append("audio", blob, "speech.webm");
  form.append("language", state.language);
  form.append("model", selectedModels().sttModel);
  try {
    const response = await fetch(`${state.apiOrigin}/api/openai/transcribe`, {
      method: "POST",
      headers: { "x-openai-key": state.apiKey },
      body: form,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Falha na transcrição.");
    const text = String(payload.text || "").trim();
    if (text && !similarTranscript(text, state.lastTranscript)) {
      state.lastTranscript = text;
      // Show the user's own line immediately in chat.
      handleCaption({
        id: `local-${Date.now()}`,
        speakerId: state.socket.id,
        speakerName: state.name,
        text,
        sourceLanguage: state.language,
        targetLanguage: state.language,
        translated: false,
        isAi: false,
        createdAt: Date.now(),
      });
      state.socket.emit("transcript", { text, language: state.language });
      // Don't wait for the socket echo to ask the AI.
      scheduleAiResponse({
        speakerName: state.name,
        text,
        speakerId: state.socket.id,
        isAi: false,
      });
      ui.translationStatus.textContent = "Frase enviada · aguardando a IA...";
    } else {
      ui.translationStatus.textContent = "Aguardando próxima fala...";
    }
  } catch (error) {
    ui.translationStatus.textContent = error.message;
    showToast(error.message);
  } finally {
    state.transcriptionBusy = Math.max(0, state.transcriptionBusy - 1);
  }
}

async function processSourceCaption(source) {
  // Skip echoes we already handled locally.
  if (!source.isAi && source.speakerId === state.socket?.id) return;
  if (source.isAi && state.ai?.ownerId === state.socket?.id) return;
  // Only process audio/text from people still in this meeting (or the room AI).
  if (!source.isAi && !state.participants.some((person) => person.id === source.speakerId)) return;

  let text = source.text;
  let translated = false;
  if (source.sourceLanguage !== state.language) {
    try {
      const response = await fetch(`${state.apiOrigin}/api/openai/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-openai-key": state.apiKey },
        body: JSON.stringify({
          text: source.text,
          sourceLanguage: source.sourceLanguage,
          targetLanguage: state.language,
          model: selectedModels().chatModel,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Falha na tradução.");
      text = payload.text;
      translated = true;
    } catch (error) {
      ui.translationStatus.textContent = error.message;
    }
  }
  handleCaption({
    ...source,
    original: source.text,
    text,
    targetLanguage: state.language,
    translated,
    isAi: Boolean(source.isAi),
  });
}

function handleCaption(caption) {
  const text = String(caption.text || "").trim();
  if (!text) return;

  ui.captionSpeaker.textContent = caption.speakerName;
  ui.captionLanguage.textContent = caption.isAi
    ? "Poly AI"
    : caption.translated
      ? `Traduzido para ${LANGUAGE_LABELS[caption.targetLanguage]?.name}`
      : "Idioma original";
  ui.captionText.textContent = text;
  ui.liveCaption.classList.remove("hidden");
  clearTimeout(state.captionTimer);
  state.captionTimer = setTimeout(() => ui.liveCaption.classList.add("hidden"), 7000);
  appendChatMessage({ ...caption, text });

  // Always try to speak AI replies.
  if (caption.isAi) {
    queueSpeech(text, caption.targetLanguage || state.language, { preferAi: true });
    return;
  }

  if (!state.voiceEnabled) return;
  if (caption.speakerId === state.socket?.id) return;

  const foreignSpeech = caption.sourceLanguage && caption.sourceLanguage !== state.language;
  if (caption.translated || foreignSpeech) {
    queueSpeech(text, caption.targetLanguage || state.language);
  }
}

function formatChatTime(ms) {
  const date = new Date(ms || Date.now());
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function appendChatMessage(caption) {
  const text = String(caption.text || "").trim();
  if (!text) return;
  const last = state.chatMessages.at(-1);
  if (last && last.speakerId === caption.speakerId && similarTranscript(last.text, text)) return;

  const entry = {
    id: caption.id || `${caption.speakerId}-${Date.now()}`,
    speakerId: caption.speakerId,
    speakerName: caption.speakerName || "Participante",
    text,
    original: caption.original && caption.original !== text ? caption.original : "",
    translated: Boolean(caption.translated),
    isAi: Boolean(caption.isAi),
    createdAt: caption.createdAt || Date.now(),
  };
  state.chatMessages.push(entry);
  if (state.chatMessages.length > 300) state.chatMessages = state.chatMessages.slice(-300);
  renderChatLog(true);
}

function renderChatLog(stickToBottom = false) {
  if (!ui.chatLog) return;
  if (!state.chatMessages.length) {
    ui.chatLog.innerHTML = `<p class="chat-empty">As falas da reunião vão aparecer aqui.</p>`;
    return;
  }
  const nearBottom = ui.chatLog.scrollHeight - ui.chatLog.scrollTop - ui.chatLog.clientHeight < 80;
  ui.chatLog.innerHTML = state.chatMessages.map((message) => {
    const classes = ["chat-message"];
    if (message.speakerId === state.socket?.id) classes.push("self");
    if (message.isAi) classes.push("ai");
    return `
      <article class="${classes.join(" ")}">
        <div class="chat-message-meta">
          <strong>${escapeHtml(message.speakerName)}</strong>
          <time>${formatChatTime(message.createdAt)}</time>
          <span>${message.translated ? "Traduzido" : message.isAi ? "IA" : "Original"}</span>
        </div>
        <p>${escapeHtml(message.text)}</p>
        ${message.original ? `<p class="original">${escapeHtml(message.original)}</p>` : ""}
      </article>
    `;
  }).join("");
  if (stickToBottom || nearBottom) ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
}

function setChatOpen(open) {
  state.chatOpen = open;
  ui.chatOverlay.classList.toggle("hidden", !open);
  ui.chatOverlay.setAttribute("aria-hidden", open ? "false" : "true");
  ui.toggleChat.classList.toggle("active", open);
  ui.toggleChat.setAttribute("aria-pressed", open ? "true" : "false");
  ui.toggleChat.setAttribute("aria-label", open ? "Fechar transcrição" : "Abrir transcrição");
  if (open) {
    renderChatLog(true);
  }
}

ui.toggleChat?.addEventListener("click", () => setChatOpen(!state.chatOpen));
ui.closeChat?.addEventListener("click", () => setChatOpen(false));
ui.clearChat?.addEventListener("click", () => {
  state.chatMessages = [];
  renderChatLog();
  showToast("Transcrição limpa");
});
ui.copyChat?.addEventListener("click", async () => {
  if (!state.chatMessages.length) {
    showToast("Ainda não há falas para copiar");
    return;
  }
  const text = state.chatMessages
    .map((message) => `[${formatChatTime(message.createdAt)}] ${message.speakerName}: ${message.text}`)
    .join("\n");
  await navigator.clipboard.writeText(text);
  showToast("Transcrição copiada");
});

function selectedModels() {
  return {
    sttModel: ui.sttModel?.value || state.sttModel || "gpt-4o-mini-transcribe",
    chatModel: ui.chatModel?.value || state.chatModel || "gpt-4.1-nano",
    ttsModel: ui.ttsModel?.value || state.ttsModel || "tts-1",
  };
}

function persistModels() {
  const models = selectedModels();
  state.sttModel = models.sttModel;
  state.chatModel = models.chatModel;
  state.ttsModel = models.ttsModel;
  sessionStorage.setItem("polycall_stt_model", models.sttModel);
  sessionStorage.setItem("polycall_chat_model", models.chatModel);
  sessionStorage.setItem("polycall_tts_model", models.ttsModel);
}

ui.sttModel?.addEventListener("change", () => {
  persistModels();
  showToast(`Transcrição: ${state.sttModel}`);
});
ui.chatModel?.addEventListener("change", () => {
  persistModels();
  showToast(`Tradução/IA: ${state.chatModel}`);
});
ui.ttsModel?.addEventListener("change", () => {
  persistModels();
  showToast(`Voz: ${state.ttsModel}`);
});

function queueSpeech(text, language, options = {}) {
  if (!text?.trim()) return;
  if (!state.voiceEnabled) {
    setVoiceEnabled(true);
  }
  state.ttsQueue = [{ text, language, preferAi: Boolean(options.preferAi) }];
  if (state.ttsPlaying && state.ttsAudio) {
    try {
      state.ttsAudio.stop?.();
      state.ttsAudio.pause?.();
      state.ttsAudio.src = "";
    } catch { /* ignore */ }
    state.ttsAudio = null;
    state.ttsPlaying = false;
  }
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  applyRemoteVolumes();
  void playSpeechQueue();
}

async function ensureVoices() {
  const existing = window.speechSynthesis?.getVoices?.() || [];
  if (existing.length) return existing;
  await new Promise((resolve) => {
    const done = () => resolve();
    window.speechSynthesis?.addEventListener?.("voiceschanged", done, { once: true });
    setTimeout(done, 700);
  });
  return window.speechSynthesis?.getVoices?.() || [];
}

function pickBrowserVoice(lang) {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const wanted = String(lang || "pt-BR").replace("_", "-").toLowerCase();
  const prefix = wanted.slice(0, 2);
  return (
    voices.find((voice) => voice.lang.replace("_", "-").toLowerCase() === wanted) ||
    voices.find((voice) => voice.lang.replace("_", "-").toLowerCase().startsWith(prefix)) ||
    null
  );
}

function speakBrowser(text, language) {
  return new Promise(async (resolve) => {
    if (!window.speechSynthesis) {
      resolve(false);
      return;
    }
    await ensureVoices();
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = language || state.language || "pt-BR";
    utter.rate = 0.92;
    utter.volume = Math.max(0.2, Math.min(1, state.translatedVolume || 1));
    const voice = pickBrowserVoice(utter.lang);
    if (voice) utter.voice = voice;
    let finished = false;
    let started = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      resolve(ok);
    };
    utter.onstart = () => {
      started = true;
    };
    utter.onend = () => finish(true);
    utter.onerror = () => finish(false);
    window.speechSynthesis.speak(utter);
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (finished) {
        clearInterval(poll);
        return;
      }
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) started = true;
      if (started && !window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
        clearInterval(poll);
        finish(true);
        return;
      }
      // If synthesis never starts, fail fast so OpenAI TTS can take over.
      if (!started && Date.now() - startedAt > 1200) {
        clearInterval(poll);
        finish(false);
        return;
      }
      if (Date.now() - startedAt > 20000) {
        clearInterval(poll);
        finish(started);
      }
    }, 150);
  });
}

async function playBlobThroughElement(blob) {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.volume = Math.max(0.2, Math.min(1, state.translatedVolume || 1));
  state.ttsAudio = audio;
  try {
    await new Promise((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Falha ao reproduzir áudio"));
      void audio.play().then(() => {}).catch(reject);
    });
    return true;
  } finally {
    URL.revokeObjectURL(url);
    if (state.ttsAudio === audio) state.ttsAudio = null;
  }
}

async function playSpeechQueue() {
  if (state.ttsPlaying || !state.ttsQueue.length) return;
  state.ttsPlaying = true;
  // Drop any in-progress mic capture so TTS isn't transcribed as the user.
  if (state.utteranceActive) stopUtteranceRecorder(false);
  state.speechStarted = false;
  state.silenceStartedAt = 0;
  state.utteranceStartedAt = 0;
  applyRemoteVolumes();
  const item = state.ttsQueue.shift();
  let played = false;

  // OpenAI TTS first (more reliable than browser voices on many devices).
  try {
    ui.translationStatus.textContent = item.preferAi ? "Poly AI gerando voz..." : "Gerando voz traduzida...";
    const response = await fetch(`${state.apiOrigin}/api/openai/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-openai-key": state.apiKey },
      body: JSON.stringify({ text: item.text, language: item.language, model: selectedModels().ttsModel }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Falha ao gerar voz.");
    }
    played = await playBlobThroughElement(await response.blob());
    if (played) {
      ui.translationStatus.textContent = item.preferAi ? "Poly AI falando" : "Tradução falando";
      if (item.preferAi) showToast("Poly AI falando");
    }
  } catch (error) {
    ui.translationStatus.textContent = `${error.message} · tentando voz do navegador`;
  }

  if (!played) {
    played = await speakBrowser(item.text, item.language);
    if (played) {
      ui.translationStatus.textContent = item.preferAi
        ? "Poly AI falando (voz do navegador)"
        : "Tradução falando (voz do navegador)";
      if (item.preferAi) showToast("Poly AI falando");
    } else {
      ui.translationStatus.textContent = "Não foi possível reproduzir a voz. Confira crédito/chave OpenAI.";
      showToast("Sem áudio da IA");
    }
  }

  state.ttsPlaying = false;
  state.ttsAudio = null;
  state.listenCooldownUntil = Date.now() + 450;
  applyRemoteVolumes();
  void playSpeechQueue();
}

function duckLevelForPeer(peerId) {
  if (!state.voiceEnabled) return 1;
  // Only duck audio that belongs to someone still in this meeting.
  const participant = state.participants.find((person) => person.id === peerId);
  if (!participant) return 0;
  const level = Math.max(0, Math.min(1, state.originalVolume));
  if (state.ttsPlaying) return Math.min(level, 0.05);
  if (participant.language === state.language) return 1;
  return level;
}

function applyRemoteVolumes() {
  for (const [peerId, routed] of [...state.remoteGains.entries()]) {
    if (!state.participants.some((person) => person.id === peerId)) {
      disconnectRemoteAudio(routed);
      state.remoteGains.delete(peerId);
      continue;
    }
    const volume = duckLevelForPeer(peerId);
    try {
      routed.gain.gain.setTargetAtTime(volume, routed.gain.context.currentTime, 0.03);
    } catch {
      routed.gain.gain.value = volume;
    }
  }
  for (const participant of state.participants) {
    if (participant.id === state.socket?.id) continue;
    const video = document.querySelector(`[data-peer="${participant.id}"] video`);
    if (!video) continue;
    // Keep muted; Web Audio → HTMLAudioElement owns playback level.
    video.muted = true;
    video.volume = 0;
  }
  if (state.ttsAudio && typeof state.ttsAudio.volume === "number") {
    state.ttsAudio.volume = Math.max(0, Math.min(1, state.translatedVolume));
  }
}

function syncVolumeUi() {
  if (!ui.originalVolume || !ui.translatedVolume) return;
  ui.originalVolume.value = String(Math.round(state.originalVolume * 100));
  ui.translatedVolume.value = String(Math.round(state.translatedVolume * 100));
  ui.originalVolumeValue.textContent = `${ui.originalVolume.value}%`;
  ui.translatedVolumeValue.textContent = `${ui.translatedVolume.value}%`;
}

ui.copyInvite.addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}?room=${state.roomId}`;
  await navigator.clipboard.writeText(url);
  showToast("Link de convite copiado");
});

ui.meetingLanguage.addEventListener("change", () => {
  state.language = ui.meetingLanguage.value;
  ui.localLanguage.textContent = LANGUAGE_LABELS[state.language].short;
  state.socket.emit("update-language", state.language);
  startRecognition();
  applyRemoteVolumes();
  showToast(`Idioma alterado para ${LANGUAGE_LABELS[state.language].name}`);
});

function setVoiceEnabled(enabled) {
  state.voiceEnabled = Boolean(enabled);
  if (ui.voiceEnabled) ui.voiceEnabled.checked = state.voiceEnabled;
  if (ui.chatVoiceEnabled) ui.chatVoiceEnabled.checked = state.voiceEnabled;
  if (!state.voiceEnabled) {
    state.ttsQueue = [];
    if (state.ttsAudio) {
      state.ttsAudio.pause();
      state.ttsAudio = null;
    }
    window.speechSynthesis?.cancel();
  }
  applyRemoteVolumes();
}

ui.voiceEnabled?.addEventListener("change", () => setVoiceEnabled(ui.voiceEnabled.checked));
ui.chatVoiceEnabled?.addEventListener("change", () => setVoiceEnabled(ui.chatVoiceEnabled.checked));

ui.originalVolume?.addEventListener("input", () => {
  state.originalVolume = Number(ui.originalVolume.value) / 100;
  sessionStorage.setItem("polycall_original_volume", ui.originalVolume.value);
  ui.originalVolumeValue.textContent = `${ui.originalVolume.value}%`;
  applyRemoteVolumes();
});

ui.translatedVolume?.addEventListener("input", () => {
  state.translatedVolume = Number(ui.translatedVolume.value) / 100;
  sessionStorage.setItem("polycall_translated_volume", ui.translatedVolume.value);
  ui.translatedVolumeValue.textContent = `${ui.translatedVolume.value}%`;
  applyRemoteVolumes();
});

ui.toggleMic.addEventListener("click", () => {
  const track = state.stream.getAudioTracks()[0];
  if (!track) {
    showToast("Nenhum microfone disponível");
    return;
  }
  state.micEnabled = !state.micEnabled;
  track.enabled = state.micEnabled;
  ui.toggleMic.classList.toggle("off", !state.micEnabled);
  ui.toggleMic.setAttribute("aria-label", state.micEnabled ? "Desativar microfone" : "Ativar microfone");
  if (!state.micEnabled) {
    stopTranscription();
  } else {
    startRecognition();
  }
});

ui.toggleCamera.addEventListener("click", () => {
  const track = state.stream.getVideoTracks()[0];
  if (!track) {
    showToast("Nenhuma câmera disponível");
    return;
  }
  state.cameraEnabled = !state.cameraEnabled;
  track.enabled = state.cameraEnabled;
  ui.localTile.classList.toggle("has-video", state.cameraEnabled);
  ui.toggleCamera.classList.toggle("off", !state.cameraEnabled);
  ui.toggleCamera.setAttribute("aria-label", state.cameraEnabled ? "Desativar câmera" : "Ativar câmera");
});

ui.leaveMeeting.addEventListener("click", leaveMeeting);

function stopLocalStream() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
}

function stopTranscription() {
  state.recognitionActive = false;
  state.transcriptionGeneration += 1;
  clearTimeout(state.transcriptionTimer);
  cancelAnimationFrame(state.vadRaf);
  state.speechStarted = false;
  state.silenceStartedAt = 0;
  stopUtteranceRecorder(false);
}

function leaveMeeting() {
  stopTranscription();
  state.ttsQueue = [];
  state.chatMessages = [];
  setChatOpen(false);
  if (state.ttsAudio) {
    try {
      state.ttsAudio.pause?.();
      state.ttsAudio.stop?.();
      state.ttsAudio.src = "";
      state.ttsAudio.srcObject = null;
    } catch { /* ignore */ }
    state.ttsAudio = null;
  }
  state.ttsPlaying = false;
  for (const routed of state.remoteGains.values()) disconnectRemoteAudio(routed);
  state.remoteGains.clear();
  window.speechSynthesis?.cancel();
  clearInterval(state.timer);
  for (const peerId of state.peers.keys()) removePeer(peerId);
  state.socket?.disconnect();
  stopLocalStream();
  location.href = location.pathname;
}

window.addEventListener("beforeunload", () => {
  stopTranscription();
  state.socket?.disconnect();
  stopLocalStream();
});
