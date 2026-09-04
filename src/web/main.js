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
  audioCtx: null,
  analyser: null,
  vadRaf: 0,
  utteranceRecorder: null,
  utteranceChunks: [],
  utteranceActive: false,
  silenceStartedAt: 0,
  speechStarted: false,
  remoteGains: new Map(),
  ttsQueue: [],
  ttsPlaying: false,
  ttsAudio: null,
  ai: null,
  aiHistory: [],
  aiBuffer: [],
  aiTimer: null,
  aiBusy: false,
  chatOpen: false,
  chatMessages: [],
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

async function getLocalMedia() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    });
  } catch (videoError) {
    try {
      state.cameraEnabled = false;
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
    if (!source.isAi) scheduleAiResponse(source);
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

async function wireRemoteAudio(peerId, stream) {
  if (!stream.getAudioTracks().length) return;
  try {
    const ctx = await ensureAudioCtx();
    const previous = state.remoteGains.get(peerId);
    if (previous) {
      try { previous.source.disconnect(); previous.gain.disconnect(); } catch { /* ignore */ }
    }
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = duckLevelForPeer(peerId);
    source.connect(gain);
    gain.connect(ctx.destination);
    state.remoteGains.set(peerId, { source, gain, stream });
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
    try { routed.source.disconnect(); routed.gain.disconnect(); } catch { /* ignore */ }
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
  ui.translationStatus.textContent = "Fale normalmente. Após 2s de silêncio a frase fecha, entra no chat e a tradução fala com o original abaixado.";
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
      ? "A IA está ouvindo e responderá após cada fala."
      : `${state.ai.ownerName} adicionou a IA à conversa.`
    : "A IA responderá depois que você falar.";

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

ui.toggleAi.addEventListener("click", () => {
  const isOwner = state.ai?.ownerId === state.socket?.id;
  if (state.ai && !isOwner) return;
  ui.toggleAi.disabled = true;
  state.socket.emit("set-ai", {
    active: !state.ai,
    language: ui.aiLanguage.value,
    role: ui.aiRole.value,
  }, (result) => {
    ui.toggleAi.disabled = false;
    if (!result?.ok) showToast(result?.error || "Não foi possível alterar a IA.");
  });
});

function scheduleAiResponse(source) {
  if (!state.ai || state.ai.ownerId !== state.socket?.id) return;
  state.aiBuffer.push(`${source.speakerName}: ${source.text}`);
  state.aiBuffer = state.aiBuffer.slice(-4);
  clearTimeout(state.aiTimer);
  state.aiTimer = setTimeout(requestAiResponse, 450);
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
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "A IA não conseguiu responder.");
    if (payload.text) {
      state.aiHistory.push({ role: "user", content: message }, { role: "assistant", content: payload.text });
      state.aiHistory = state.aiHistory.slice(-10);
      state.socket.emit("ai-response", { text: payload.text });
    }
  } catch (error) {
    ui.translationStatus.textContent = error.message;
  } finally {
    state.aiBusy = false;
    document.querySelector(".ai-tile")?.classList.remove("thinking");
    if (state.ai?.ownerId === state.socket?.id) ui.aiHint.textContent = "A IA está ouvindo e responderá após cada fala.";
    if (state.aiBuffer.length) state.aiTimer = setTimeout(requestAiResponse, 500);
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
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const centered = (data[i] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        const speaking = rms > 0.025;

        if (speaking) {
          state.speechStarted = true;
          state.silenceStartedAt = 0;
          if (!state.utteranceActive) startUtteranceRecorder(audioTrack, generation);
        } else if (state.speechStarted) {
          if (!state.silenceStartedAt) state.silenceStartedAt = Date.now();
          if (Date.now() - state.silenceStartedAt >= 2000) {
            state.speechStarted = false;
            state.silenceStartedAt = 0;
            stopUtteranceRecorder(true);
          }
        }
        state.vadRaf = requestAnimationFrame(tick);
      };
      state.vadRaf = requestAnimationFrame(tick);
      ui.translationStatus.textContent = "Aguardando pausa de 2s para fechar a frase e falar a tradução.";
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
  if (blob.size < 1800) return;
  if (state.transcriptionBusy >= 2) return;
  state.transcriptionBusy += 1;
  ui.translationStatus.textContent = "Fechando frase e enviando para interpretação...";
  const form = new FormData();
  form.append("audio", blob, "speech.webm");
  form.append("language", state.language);
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
      state.socket.emit("transcript", { text, language: state.language });
      ui.translationStatus.textContent = "Frase completa enviada · aguardando tradução/voz";
    } else {
      ui.translationStatus.textContent = "Aguardando próxima fala...";
    }
  } catch (error) {
    ui.translationStatus.textContent = error.message;
  } finally {
    state.transcriptionBusy = Math.max(0, state.transcriptionBusy - 1);
  }
}

async function processSourceCaption(source) {
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
  });
}

function handleCaption(caption) {
  ui.captionSpeaker.textContent = caption.speakerName;
  ui.captionLanguage.textContent = caption.translated ? `Traduzido para ${LANGUAGE_LABELS[caption.targetLanguage]?.name}` : "Idioma original";
  ui.captionText.textContent = caption.text;
  ui.liveCaption.classList.remove("hidden");
  clearTimeout(state.captionTimer);
  state.captionTimer = setTimeout(() => ui.liveCaption.classList.add("hidden"), 7000);
  appendChatMessage(caption);

  const foreignSpeech = caption.sourceLanguage && caption.sourceLanguage !== state.language;
  const shouldSpeak = state.voiceEnabled
    && caption.speakerId !== state.socket.id
    && (caption.isAi || caption.translated || foreignSpeech);
  if (shouldSpeak) {
    queueSpeech(caption.text, caption.targetLanguage || state.language);
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

function queueSpeech(text, language) {
  if (!text?.trim()) return;
  state.ttsQueue = [{ text, language }];
  if (state.ttsPlaying && state.ttsAudio) {
    try {
      state.ttsAudio.pause();
      state.ttsAudio.src = "";
    } catch { /* ignore */ }
    state.ttsAudio = null;
    state.ttsPlaying = false;
  }
  applyRemoteVolumes();
  playSpeechQueue();
}

async function playSpeechQueue() {
  if (state.ttsPlaying || !state.ttsQueue.length || !state.voiceEnabled) return;
  state.ttsPlaying = true;
  applyRemoteVolumes();
  const item = state.ttsQueue.shift();
  try {
    await ensureAudioCtx();
    const response = await fetch(`${state.apiOrigin}/api/openai/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-openai-key": state.apiKey },
      body: JSON.stringify(item),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Falha ao gerar voz.");
    }
    const url = URL.createObjectURL(await response.blob());
    if (state.ttsAudio) {
      state.ttsAudio.pause();
      state.ttsAudio.src = "";
    }
    const audio = new Audio(url);
    state.ttsAudio = audio;
    audio.volume = Math.max(0, Math.min(1, state.translatedVolume));
    await new Promise((resolve) => {
      audio.onended = resolve;
      audio.onerror = resolve;
      audio.play().then(() => {
        ui.translationStatus.textContent = "Tradução falando · voz original abaixada";
      }).catch((error) => {
        ui.translationStatus.textContent = error?.message || "O navegador bloqueou o áudio traduzido.";
        resolve();
      });
    });
    URL.revokeObjectURL(url);
  } catch (error) {
    ui.translationStatus.textContent = error.message;
  } finally {
    state.ttsPlaying = false;
    state.ttsAudio = null;
    applyRemoteVolumes();
    playSpeechQueue();
  }
}

function duckLevelForPeer(peerId) {
  if (!state.voiceEnabled) return 1;
  const participant = state.participants.find((person) => person.id === peerId);
  const level = Math.max(0, Math.min(1, state.originalVolume));
  if (state.ttsPlaying) return Math.min(level, 0.05);
  if (participant && participant.language === state.language) return 1;
  return level;
}

function applyRemoteVolumes() {
  for (const [peerId, routed] of state.remoteGains.entries()) {
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
    // Keep muted; Web Audio GainNode owns playback level.
    video.muted = true;
    video.volume = 0;
  }
  if (state.ttsAudio) state.ttsAudio.volume = Math.max(0, Math.min(1, state.translatedVolume));
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

ui.voiceEnabled.addEventListener("change", () => {
  state.voiceEnabled = ui.voiceEnabled.checked;
  if (!state.voiceEnabled) {
    state.ttsQueue = [];
    if (state.ttsAudio) {
      state.ttsAudio.pause();
      state.ttsAudio = null;
    }
    window.speechSynthesis?.cancel();
  }
  applyRemoteVolumes();
});

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
    state.ttsAudio.pause();
    state.ttsAudio = null;
  }
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
