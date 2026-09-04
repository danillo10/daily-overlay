import {
  createPcmCollector,
  floatToWavBlob,
  getLoopbackStream,
  getMicrophoneStream,
  mixStreams,
  stopStream,
} from "../lib/audio.js";
import {
  createSpeechRecognizer,
  loadWhisper,
  transcribeCloud,
  transcribeLocal,
} from "../lib/transcribe.js";
import { createSpeakerRoster } from "../lib/speakers.js";

const $ = (id) => document.getElementById(id);

const ui = {
  toggle: $("toggle"),
  clock: $("clock"),
  hint: $("hint"),
  language: $("language"),
  source: $("source"),
  engine: $("engine"),
  audioApp: $("audioApp"),
  display: $("display"),
  follow: $("follow"),
  overlayVisible: $("overlayVisible"),
  clickThrough: $("clickThrough"),
  hideCapture: $("hideCapture"),
  translatePt: $("translatePt"),
  voiceTranslate: $("voiceTranslate"),
  originalVolume: $("originalVolume"),
  aiVolume: $("aiVolume"),
  translateEngine: $("translateEngine"),
  translateOpacity: $("translateOpacity"),
  cloudFields: $("cloudFields"),
  provider: $("provider"),
  apiKey: $("apiKey"),
  openaiModels: $("openaiModels"),
  sttModel: $("sttModel"),
  chatModel: $("chatModel"),
  ttsModel: $("ttsModel"),
  status: $("status"),
  engineStatus: $("engineStatus"),
  partial: $("partial"),
  transcript: $("transcript"),
  copy: $("copy"),
  clear: $("clear"),
  youtubeUrl: $("youtubeUrl"),
  youtubeGo: $("youtubeGo"),
  youtubeHint: $("youtubeHint"),
  youtubeDub: $("youtubeDub"),
  mark: document.querySelector(".mark"),
  meterBar: $("meterBar"),
};

const session = {
  running: false,
  startedAt: null,
  lines: [],
  linesPt: [],
  linesSpeakers: [],
  partial: "",
  partialSpeaker: "",
  translation: "",
  roster: createSpeakerRoster(),
  lastVoicePcm: null,
  translateTimer: null,
  translateSeq: 0,
  lastTranslateSent: "",
  lastTranslateAt: 0,
  translateQueue: [],
  translateBusy: false,
  translateCurrent: null,
  sttQueue: [],
  segBuf: [],
  quietHops: 0,
  streams: [],
  mixer: null,
  collector: null,
  recorder: null,
  speech: null,
  clockTimer: null,
  busy: false,
  jobs: [],
  liveBuf: [],
  usingLinuxAudio: false,
  cloudPcm: [],
  offLinuxChunk: null,
  offLinuxError: null,
  offLinuxStatus: null,
  speakSeq: 0,
  lastSpoken: "",
  ttsQueue: [],
  ttsPlaying: false,
  ttsCurrent: null,
  ttsPlayId: 0,
  ttsAudio: null,
  ttsUrl: null,
  ttsSource: null,
  ttsCtx: null,
  gptBlocked: false,
  gptBlockedMsg: "",
};

function wantsLiveTranslate() {
  return Boolean(ui.translatePt?.checked || ui.voiceTranslate?.checked);
}

function selectedEngine() {
  const key = ui.apiKey.value.trim();
  const raw = ui.engine.value;
  if (key && raw !== "local" && raw !== "speech") return "cloud";
  if (raw === "cloud") return key ? "cloud" : "local";
  if (raw === "speech") {
    if (wantsLiveTranslate() || ui.source.value !== "mic") return "local";
    return "speech";
  }
  return "local";
}

function selectedModels() {
  return {
    sttModel: ui.sttModel?.value || "gpt-4o-mini-transcribe",
    chatModel: ui.chatModel?.value || "gpt-4.1-nano",
    ttsModel: ui.ttsModel?.value || "tts-1",
  };
}

function cloudTranscribeOpts() {
  return {
    apiKey: ui.apiKey.value.trim(),
    provider: ui.provider.value,
    language: ui.language.value,
    detectLanguage: wantsLiveTranslate(),
    ...selectedModels(),
  };
}

function localTranscribeLang() {
  return wantsLiveTranslate() ? "auto" : ui.language.value;
}

function duckLevel() {
  return Math.max(0.08, Math.min(0.7, Number(ui.originalVolume?.value || 12) / 100));
}

function aiGain() {
  return Math.max(1.2, Math.min(5, Number(ui.aiVolume?.value || 320) / 100));
}

function rememberVoice(pcm) {
  if (pcm?.length) session.lastVoicePcm = pcm;
}

function nameSpeaker(pcm) {
  const sample = pcm?.length ? pcm : session.lastVoicePcm;
  if (!sample?.length) return session.partialSpeaker || session.linesSpeakers.at(-1) || "";
  const name = session.roster.assign(sample);
  if (name) session.partialSpeaker = name;
  return name || session.partialSpeaker || "";
}

async function applySourceDuck() {
  if (!window.daily.setSourceDuck) return;
  const on = session.running && session.usingLinuxAudio && Boolean(ui.voiceTranslate?.checked);
  await window.daily.setSourceDuck(on ? duckLevel() : null);
}

function stopTtsPlayback() {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
  if (session.ttsSource) {
    try {
      session.ttsSource.stop();
    } catch {
      /* already stopped */
    }
    session.ttsSource = null;
  }
  if (session.ttsAudio) {
    session.ttsAudio.pause();
    session.ttsAudio.src = "";
    session.ttsAudio = null;
  }
  if (session.ttsUrl) {
    URL.revokeObjectURL(session.ttsUrl);
    session.ttsUrl = null;
  }
}

function clearSpeechQueue() {
  session.ttsQueue = [];
  session.ttsPlayId += 1;
  session.ttsPlaying = false;
  session.ttsCurrent = null;
  session.lastSpoken = "";
  stopTtsPlayback();
}

function similarText(a, b) {
  const x = String(a || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const y = String(b || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.abs(x.length - y.length) < 8 && (x.includes(y) || y.includes(x));
}

function pickBrowserVoice(lang) {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const wanted = String(lang || "pt-BR").replace("_", "-");
  const prefix = wanted.slice(0, 2).toLowerCase();
  return (
    voices.find((voice) => voice.lang.replace("_", "-").toLowerCase() === wanted.toLowerCase()) ||
    voices.find((voice) => voice.lang.replace("_", "-").toLowerCase().startsWith(prefix)) ||
    null
  );
}

function catchupSpeed() {
  const waiting = session.ttsQueue.length + (session.ttsPlaying ? 1 : 0);
  if (waiting >= 6) return 1.42;
  if (waiting >= 4) return 1.28;
  if (waiting >= 2) return 1.14;
  return 1.04;
}

function speakBrowser(text, lang) {
  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang || ui.language.value || "pt-BR";
    utter.rate = Math.min(1.6, catchupSpeed() + 0.02);
    utter.volume = 1;
    utter.pitch = 1;
    const voice = pickBrowserVoice(utter.lang);
    if (voice) utter.voice = voice;
    const done = () => resolve();
    utter.onend = done;
    utter.onerror = done;
    window.speechSynthesis.speak(utter);
  });
}

async function ensureTtsCtx() {
  if (session.ttsCtx && session.ttsCtx.state !== "closed") {
    if (session.ttsCtx.state === "suspended") await session.ttsCtx.resume();
    return session.ttsCtx;
  }
  const ctx = new AudioContext();
  session.ttsCtx = ctx;
  if (ctx.state === "suspended") await ctx.resume();
  return ctx;
}

function playTtsBase64(base64, mime) {
  return (async () => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const ctx = await ensureTtsCtx();
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    try {
      const buffer = await ctx.decodeAudioData(copy);
      await new Promise((resolve) => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = aiGain();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -16;
        comp.knee.value = 8;
        comp.ratio.value = 3.5;
        comp.attack.value = 0.003;
        comp.release.value = 0.12;
        source.connect(gain);
        gain.connect(comp);
        comp.connect(ctx.destination);
        session.ttsSource = source;
        const done = () => {
          if (session.ttsSource === source) session.ttsSource = null;
          resolve();
        };
        source.onended = done;
        source.playbackRate.value = catchupSpeed();
        source.start();
      });
      return;
    } catch {
      /* fall through to element playback */
    }
    const blob = new Blob([bytes], { type: mime || "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    session.ttsUrl = url;
    const audio = new Audio(url);
    const source = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    gain.gain.value = aiGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 8;
    comp.ratio.value = 3.5;
    source.connect(gain);
    gain.connect(comp);
    comp.connect(ctx.destination);
    session.ttsAudio = audio;
    audio.playbackRate = catchupSpeed();
    await new Promise((resolve) => {
      const done = () => {
        if (session.ttsUrl === url) {
          URL.revokeObjectURL(url);
          session.ttsUrl = null;
        }
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });
  })();
}

async function fetchSpeechAudio(text, speaker) {
  const spoken = text;
  const result = await window.daily.speakText({
    text: spoken,
    apiKey: ui.apiKey.value.trim(),
    provider: ui.provider.value,
    language: ui.language.value,
    speed: catchupSpeed(),
    ...selectedModels(),
  });
  return { spoken, result };
}

async function playFetchedSpeech({ spoken, result }) {
  if (result?.browser || !result?.base64) {
    const lang = result?.language || ui.language.value;
    if (!(window.speechSynthesis?.getVoices?.() || []).length) {
      await new Promise((resolve) => {
        window.speechSynthesis?.addEventListener?.("voiceschanged", resolve, { once: true });
        setTimeout(resolve, 400);
      });
    }
    await speakBrowser(spoken, lang);
    return;
  }
  await playTtsBase64(result.base64, result.mime);
}

function enqueueSpeech(text, speaker = "") {
  if (!ui.voiceTranslate?.checked || !session.running) return;
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  if (session.ttsCurrent && clean === session.ttsCurrent.text) return;
  const last = session.ttsQueue.at(-1);
  if (last && last.speaker === speaker && clean === last.text) return;
  session.ttsQueue.push({ text: clean, speaker, audio: null, gen: 0, fetching: false });
  prefetchNextSpeech();
  pumpSpeechQueue();
}

async function prefetchNextSpeech() {
  const playId = session.ttsPlayId;
  for (const item of session.ttsQueue.slice(0, 2)) {
    if (!item || item.audio || item.fetching) continue;
    item.fetching = true;
    const gen = item.gen || 0;
    try {
      const audio = await fetchSpeechAudio(item.text, item.speaker);
      if (playId !== session.ttsPlayId || item.gen !== gen) continue;
      item.audio = audio;
    } catch {
      if (item.gen === gen) item.audio = null;
    } finally {
      if (item.gen === gen) item.fetching = false;
    }
  }
}

async function pumpSpeechQueue() {
  if (session.ttsPlaying) return;
  session.ttsPlaying = true;
  const item = session.ttsQueue.shift();
  if (!item) {
    session.ttsPlaying = false;
    return;
  }
  session.ttsCurrent = item;
  session.lastSpoken = item.text;
  const playId = session.ttsPlayId;
  prefetchNextSpeech();
  try {
    const fetched = item.audio || (await fetchSpeechAudio(item.text, item.speaker));
    if (playId !== session.ttsPlayId || !session.running || !ui.voiceTranslate?.checked) return;
    await playFetchedSpeech(fetched);
  } catch (error) {
    if (playId !== session.ttsPlayId) return;
    try {
      await speakBrowser(item.text, ui.language.value);
    } catch {
      setStatus(error.message || "Falha na voz da IA");
    }
  } finally {
    if (playId !== session.ttsPlayId) return;
    session.ttsPlaying = false;
    session.ttsCurrent = null;
    if (session.running && ui.voiceTranslate?.checked) pumpSpeechQueue();
  }
}

function setStatus(text, engineText = "") {
  ui.status.textContent = text;
  ui.engineStatus.textContent = engineText;
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatAta() {
  return session.lines
    .map((en, i) => {
      const who = session.linesSpeakers[i];
      const pt = session.linesPt[i];
      const head = who ? `${who}\n${en}` : en;
      return pt ? `${head}\n→ ${pt}` : head;
    })
    .join("\n\n");
}

function publish() {
  const payload = {
    running: session.running,
    elapsed: session.startedAt ? Date.now() - session.startedAt : 0,
    partial: session.partial,
    partialSpeaker: session.partialSpeaker || "",
    lines: session.lines,
    linesPt: session.linesPt,
    linesSpeakers: session.linesSpeakers,
    translation: session.translation || "",
    text: formatAta(),
  };
  ui.partial.textContent = "";
  ui.transcript.textContent = "";
  // Legenda na tela de controle desligada por enquanto — teste só com áudio.
  // ui.partial.textContent = [session.partial, session.translation].filter(Boolean).join("\n");
  // ui.transcript.textContent = payload.text;
  // ui.transcript.scrollTop = ui.transcript.scrollHeight;
  window.daily.sendTranscript(payload);
  window.daily.sendStatus({
    running: session.running,
    elapsed: payload.elapsed,
    engine: selectedEngine(),
  });
}

function pushFinal(text, pcm) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return;
  if (pcm) rememberVoice(pcm);
  const speaker = nameSpeaker(pcm);
  const last = session.lines[session.lines.length - 1];
  const lastSpeaker = session.linesSpeakers[session.linesSpeakers.length - 1];
  if (last && lastSpeaker === speaker && last === clean) return;
  if (last && lastSpeaker === speaker && clean.startsWith(last) && clean.length - last.length < 80) {
    session.lines[session.lines.length - 1] = clean;
  } else {
    session.lines.push(clean);
    session.linesPt.push("");
    session.linesSpeakers.push(speaker);
  }
  const lineIndex = session.lines.length - 1;
  session.partial = "";
  session.partialSpeaker = speaker;
  publish();
  maybeTranslate(clean, { immediate: true, speaker, lineIndex });
}

function enqueueTranslate(source, who, speak, lineIndex = null) {
  const last = session.translateQueue.at(-1);
  if (last && last.source === source && last.who === who) return;
  if (session.translateCurrent && session.translateCurrent.source === source) return;
  session.translateQueue.push({ source, who, speak, lineIndex });
  pumpTranslate();
}

async function pumpTranslate() {
  if (session.translateBusy || !session.running) return;
  const item = session.translateQueue.shift();
  if (!item) return;
  session.translateBusy = true;
  session.translateCurrent = item;
  try {
    const pt = await window.daily.translateText({
      text: item.source,
      apiKey: ui.apiKey.value.trim(),
      provider: ui.provider.value,
      engine: ui.translateEngine?.value || "free",
      language: ui.language.value,
      ...selectedModels(),
    });
    if (!session.running) return;
    session.translation = pt;
    const lineIndex = Number.isInteger(item.lineIndex) ? item.lineIndex : session.lines.length - 1;
    const line = session.lines[lineIndex];
    if (line && (item.source === line || line.includes(item.source) || item.source.includes(line))) {
      session.linesPt[lineIndex] = pt;
    }
    publish();
    if (item.speak && pt) {
      enqueueSpeech(pt, item.who);
    }
  } catch (error) {
    setStatus(error.message || "Falha ao traduzir");
  } finally {
    session.translateBusy = false;
    session.translateCurrent = null;
    if (session.running) pumpTranslate();
  }
}

function maybeTranslate(text, { immediate = false, speaker = "", lineIndex = null } = {}) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  const who = speaker || session.partialSpeaker || session.linesSpeakers.at(-1) || "";
  clearTimeout(session.translateTimer);
  if (!wantsLiveTranslate()) {
    if (session.translation) {
      session.translation = "";
      publish();
    }
    return;
  }
  if (!ui.apiKey.value.trim() && ui.translateEngine?.value === "cloud") {
    session.translation = "";
    return;
  }
  if (!source) {
    session.translation = "";
    publish();
    return;
  }
  if (!immediate && ui.voiceTranslate?.checked) return;
  if (!immediate) {
    session.translateTimer = setTimeout(() => enqueueTranslate(source, who, false, lineIndex), 1400);
    return;
  }
  enqueueTranslate(source, who, true, lineIndex);
}

async function persistSettings() {
  await window.daily.saveSettings({
    language: ui.language.value,
    source: ui.source.value,
    engine: ui.engine.value,
    audioApp: ui.audioApp.value,
    follow: ui.follow.checked,
    overlayVisible: ui.overlayVisible.checked,
    clickThrough: ui.clickThrough.checked,
    hideCapture: Boolean(ui.hideCapture?.checked),
    translatePt: Boolean(ui.translatePt?.checked),
    voiceTranslate: Boolean(ui.voiceTranslate?.checked),
    originalVolume: Number(ui.originalVolume?.value || 12),
    aiVolume: Number(ui.aiVolume?.value || 320),
    translateEngine: ui.translateEngine?.value || "free",
    translateOpacity: Number(ui.translateOpacity?.value || 0) / 100,
    provider: ui.provider.value,
    apiKey: ui.apiKey.value,
    youtubeUrl: ui.youtubeUrl?.value || "",
    youtubeDub: ui.youtubeDub?.checked !== false,
    displayId: ui.display.value === "follow" ? null : Number(ui.display.value),
    ...selectedModels(),
  });
}

function fillDisplays(displays, settings) {
  const follow = settings?.follow !== false;
  ui.display.innerHTML = "";
  const followOption = document.createElement("option");
  followOption.value = "follow";
  followOption.textContent = "Seguir o cursor";
  ui.display.append(followOption);
  for (const display of displays) {
    const option = document.createElement("option");
    option.value = String(display.id);
    option.textContent = `${display.label}${display.active ? " · ativa" : ""}`;
    ui.display.append(option);
  }
  ui.display.value = follow ? "follow" : String(settings?.displayId || "follow");
}

async function applyDisplayChoice() {
  if (ui.display.value === "follow" || ui.follow.checked) {
    ui.follow.checked = true;
    await window.daily.setFollowDisplay(true);
  } else {
    ui.follow.checked = false;
    await window.daily.setFollowDisplay(false);
    await window.daily.setDisplay(Number(ui.display.value));
  }
}

function syncCloudVisibility() {
  ui.cloudFields.hidden = false;
  if (ui.openaiModels) ui.openaiModels.hidden = ui.provider.value !== "openai";
}

function setMeter(level) {
  if (!ui.meterBar) return;
  const pct = Math.min(100, Math.round(Math.sqrt(Math.max(0, level)) * 220));
  ui.meterBar.style.width = `${pct}%`;
}

function looksLikeJunk(text) {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length < 2) return true;
  if (/♪|♫|thanks for watching|subtitle|legenda da|opening credits|theme song/.test(t)) return true;
  if (/(me (diga|mande|envie|fala|fale)|o que (voce|vc) quer|como posso|estou (pronto|aqui)|pode (me )?(enviar|mandar)).{0,48}traduz/.test(t)) {
    return true;
  }
  if (/(claro|ok|certo|oi|ola)[,!. ]{0,6}(me (diga|mande|envie)|pode (falar|mandar|enviar)|estou (pronto|aqui)|o que (voce|vc) quer)/.test(t)) {
    return true;
  }
  return /how can i help|what (would you like|do you want) (me to )?translat|send me (the )?(text|audio)|tell me what (to|you)|please (provide|send|paste)|ready when you are/.test(t);
}

const SAMPLE_RATE = 16000;
const SEG_MIN = Math.round(SAMPLE_RATE * 0.7);
const SEG_MAX = Math.round(SAMPLE_RATE * 8);
const SEG_OVERLAP = Math.round(SAMPLE_RATE * 0.18);
const VOICE_RMS = 0.0022;

function cutSpeechSegment({ keepOverlap = false } = {}) {
  if (session.segBuf.length < SEG_MIN) return;
  const pcm = Float32Array.from(session.segBuf);
  session.segBuf = keepOverlap ? session.segBuf.slice(-SEG_OVERLAP) : [];
  session.quietHops = 0;
  if (liveRms(pcm) < VOICE_RMS) return;
  session.sttQueue.push({ pcm });
  pumpStt();
}

function useOpenAIInterpreter() {
  return Boolean(
    ui.voiceTranslate?.checked &&
      ui.provider.value === "openai" &&
      ui.apiKey.value.trim().startsWith("sk-")
  );
}

function gptInterpreterFatal(message) {
  return /não está funcionando|não está liberado|não liberou|inválida|sem permissão|401|403|does not exist|not have access/i.test(
    String(message || "")
  );
}

function recordInterpreted(text, pcm) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const speaker = nameSpeaker(pcm);
  const last = session.lines[session.lines.length - 1];
  const lastSpeaker = session.linesSpeakers[session.linesSpeakers.length - 1];
  if (last && lastSpeaker === speaker && last === clean) return speaker;
  session.lines.push(clean);
  session.linesPt.push(clean);
  session.linesSpeakers.push(speaker);
  session.translation = clean;
  session.partial = "";
  session.partialSpeaker = speaker;
  publish();
  return speaker;
}

function enqueueInterpretedAudio(text, speaker, result) {
  if (!result?.base64) {
    enqueueSpeech(text, speaker);
    return;
  }
  session.ttsQueue.push({
    text,
    speaker,
    audio: { spoken: text, result },
    gen: 0,
    fetching: false,
  });
  pumpSpeechQueue();
}

async function pumpStt() {
  if (!session.running || session.busy) return;
  if (useOpenAIInterpreter() && session.gptBlocked) {
    session.sttQueue = [];
    setStatus(session.gptBlockedMsg || "GPT não está funcionando nesta key", "openai");
    return;
  }
  const item = session.sttQueue.shift();
  if (!item) return;
  const pcm = item.pcm || null;
  session.busy = true;
  if (pcm) rememberVoice(pcm);
  try {
    const audio = item.blob || floatToWavBlob(pcm);
    if (useOpenAIInterpreter() && window.daily.interpretAudio) {
      if (!pcm) throw new Error("O intérprete precisa de áudio PCM.");
      const buffer = await audio.arrayBuffer();
        const interpreted = await window.daily.interpretAudio({
          buffer,
          apiKey: ui.apiKey.value.trim(),
          language: ui.language.value,
          ...selectedModels(),
        });
      const spoken = String(interpreted?.text || "").trim();
      if (spoken && !looksLikeJunk(spoken)) {
        const speaker = recordInterpreted(spoken, pcm);
        enqueueInterpretedAudio(spoken, speaker, interpreted);
      }
      const waiting = session.sttQueue.length;
      setStatus(waiting ? `Intérprete · ${waiting} na fila` : "Intérprete GPT", selectedModels().sttModel);
    } else {
      const text = await transcribeCloud(audio, cloudTranscribeOpts());
      if (text && !looksLikeJunk(text)) {
        session.partial = text;
        publish();
        pushFinal(text, pcm);
      }
      const waiting = session.sttQueue.length;
      setStatus(waiting ? `Ao vivo · ${waiting} na fila` : "Ao vivo", ui.provider.value);
    }
  } catch (error) {
    const message = error.message || "Falha na API";
    setStatus(message, useOpenAIInterpreter() ? "openai" : "");
    if (useOpenAIInterpreter() && gptInterpreterFatal(message)) {
      session.gptBlocked = true;
      session.gptBlockedMsg = message;
      session.sttQueue = [];
    }
  } finally {
    session.busy = false;
    if (session.running) pumpStt();
  }
}

function ingestCloudHop(pcm) {
  if (!pcm?.length) return;
  rememberVoice(pcm);
  const voiced = liveRms(pcm) >= VOICE_RMS;
  for (let i = 0; i < pcm.length; i += 1) session.segBuf.push(pcm[i]);
  if (voiced) {
    session.quietHops = 0;
    if (session.segBuf.length >= SEG_MAX) cutSpeechSegment({ keepOverlap: true });
    return;
  }
  session.quietHops += 1;
  if (session.quietHops >= 2 && session.segBuf.length >= SEG_MIN) cutSpeechSegment();
}

const LIVE_SAMPLES = 12000;
const LIVE_MAX = 16000 * 1.2;

function liveRms(pcm) {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

function updateLiveCaption(text, pcm) {
  if (pcm) {
    rememberVoice(pcm);
    session.partialSpeaker = nameSpeaker(pcm) || session.partialSpeaker;
  }
  const prev = session.partial;
  if (!prev) {
    session.partial = text;
    publish();
    maybeTranslate(text, { speaker: session.partialSpeaker });
    return;
  }
  if (text.includes(prev) || prev.endsWith(text) || text.startsWith(prev.slice(0, Math.min(18, prev.length)))) {
    session.partial = text.length >= prev.length ? text : prev;
    publish();
    maybeTranslate(session.partial, { speaker: session.partialSpeaker });
    return;
  }
  pushFinal(prev, pcm);
  session.partial = text;
  publish();
  maybeTranslate(text, { speaker: session.partialSpeaker });
}

function ingestLiveHop(pcm, origin) {
  for (let i = 0; i < pcm.length; i += 1) session.liveBuf.push(pcm[i]);
  if (session.liveBuf.length > LIVE_MAX) {
    session.liveBuf.splice(0, session.liveBuf.length - LIVE_MAX);
  }
  const window = session.liveBuf.slice(-LIVE_SAMPLES);
  if (session.liveBuf.length < 8000) return;
  if (liveRms(window) > 0.004) enqueuePcm(Float32Array.from(window), origin);
}

function enqueuePcm(pcm, origin) {
  if (!session.running) return;
  rememberVoice(pcm);
  session.jobs.push({ pcm, origin });
  pumpJobs();
}

async function pumpJobs() {
  if (session.busy || !session.running) return;
  const job = session.jobs.shift();
  if (!job) return;
  session.busy = true;
  try {
    const text = await transcribeLocal(job.pcm, localTranscribeLang(), (progress) => {
      if (progress.status === "progress") {
        setStatus(`Baixando modelo ${Math.round(progress.progress || 0)}%`, "whisper-tiny");
      }
      if (progress.status === "ready") {
        setStatus("Ao vivo", "whisper-tiny");
      }
    });
    if (text && !looksLikeJunk(text)) {
      updateLiveCaption(text, job.pcm);
      setStatus("Ao vivo", job.origin || "whisper-tiny");
    }
  } catch (error) {
    setStatus(error.message || "Falha no Whisper local");
  } finally {
    session.busy = false;
    if (session.running) pumpJobs();
  }
}

async function fillAudioApps(selectedId) {
  if (!ui.audioApp) return;
  let sources = [];
  try {
    sources = await window.daily.listLinuxAudioSources();
  } catch {
    sources = [];
  }
  const previous = selectedId ?? ui.audioApp.value;
  ui.audioApp.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = sources.length
    ? "Auto (trava no primeiro: Discord/Teams/Meet ou o Chrome que estiver tocando)"
    : "Auto · nenhum app tocando agora";
  ui.audioApp.append(auto);
  for (const source of sources) {
    const option = document.createElement("option");
    option.value = source.key || String(source.id);
    option.dataset.id = String(source.id);
    option.dataset.stable = source.stableKey || "";
    option.textContent = source.hint ? `${source.label} · ${source.hint}` : source.label;
    ui.audioApp.append(option);
  }
  const match = [...ui.audioApp.options].find((option) => {
    if (!previous) return false;
    if (option.value === previous || option.dataset.id === String(previous)) return true;
    const stable = option.dataset.stable;
    return Boolean(stable && (previous === stable || String(previous).startsWith(`${stable}|`)));
  });
  if (match) ui.audioApp.value = match.value;
}

async function startAudio() {
  const source = ui.source.value;
  const streams = [];
  let linux = null;

  if (source === "mic") {
    streams.push(await getMicrophoneStream({ pickupSpeakers: false }));
  }

  if (source === "system" || source === "both") {
    const canLinux = await window.daily.linuxAudioAvailable();
    if (canLinux) {
      linux = await window.daily.startLinuxAudio(ui.audioApp.value || null);
      session.usingLinuxAudio = true;
    } else if (source === "both") {
      streams.push(await getMicrophoneStream({ pickupSpeakers: false }));
    } else {
      try {
        const loopback = await getLoopbackStream();
        for (const track of loopback.getVideoTracks()) track.enabled = false;
        if (!loopback.getAudioTracks().length) {
          stopStream(loopback);
          if (source === "system") {
            throw new Error("Sem áudio da reunião. No Linux o app usa o monitor do PipeWire.");
          }
        } else {
          streams.push(loopback);
        }
      } catch (error) {
        if (source === "system") throw error;
        setStatus("Sem áudio do sistema, usando só o microfone");
      }
    }
  }

  session.streams = streams;
  let mixed = null;
  if (streams.length > 1) {
    session.mixer = mixStreams(streams);
    mixed = session.mixer.stream;
  } else if (streams[0]) {
    mixed = streams[0];
  }
  return { mixed, linux };
}

function startLocalWhisper(mixed) {
  if (session.collector || !session.running || !mixed) return;
  session.collector = createPcmCollector(mixed, {
    intervalMs: 1200,
    onLevel: setMeter,
    onChunk: (pcm) => ingestLiveHop(pcm, "microfone"),
  });
}

async function startSession() {
  if (session.running) return;
  const engine = selectedEngine();
  if (engine === "cloud" && !ui.apiKey.value.trim()) {
    setStatus("Coloque uma API key para o Whisper na nuvem");
    return;
  }
  if (ui.provider.value === "openai" && ui.voiceTranslate?.checked && !ui.apiKey.value.trim().startsWith("sk-")) {
    setStatus("GPT precisa de uma key OpenAI (sk-…). Esta key não é GPT.");
    return;
  }

  session.running = true;
  session.startedAt = Date.now();
  session.jobs = [];
  session.cloudPcm = [];
  session.liveBuf = [];
  session.sttQueue = [];
  session.segBuf = [];
  session.quietHops = 0;
  session.translateQueue = [];
  session.translateBusy = false;
  session.translateCurrent = null;
  session.lastVoicePcm = null;
  session.partialSpeaker = "";
  session.roster.reset();
  session.ttsQueue = [];
  session.ttsPlaying = false;
  session.ttsCurrent = null;
  session.lastSpoken = "";
  session.usingLinuxAudio = false;
  session.gptBlocked = false;
  session.gptBlockedMsg = "";
  ui.toggle.textContent = "Parar transcrição";
  ui.toggle.classList.add("live");
  ui.mark.dataset.live = "true";
  setStatus("Escutando a reunião", engineLabel(engine));
  publish();

  session.clockTimer = setInterval(() => {
    ui.clock.textContent = formatClock(Date.now() - session.startedAt);
    window.daily.sendStatus({
      running: true,
      elapsed: Date.now() - session.startedAt,
      engine,
    });
  }, 500);

  try {
    if (engine !== "cloud") {
      setStatus("Carregando Whisper local (primeira vez pode demorar)", "whisper-tiny");
      loadWhisper((progress) => {
        if (progress.status === "progress") {
          setStatus(`Baixando modelo ${Math.round(progress.progress || 0)}%`, "whisper-tiny");
        }
      }).catch((error) => setStatus(error.message || "Falha ao carregar Whisper"));
    }

    await fillAudioApps(ui.audioApp.value);
    const { mixed, linux } = await startAudio();
    if (linux?.waiting) {
      setStatus("Aguardando o vídeo ou app começar a tocar", engineLabel(engine));
    } else if (linux?.sinkName) {
      setStatus(`Capturando ${linux.sinkName}`, engineLabel(engine));
    }
    await applySourceDuck();

    session.offLinuxChunk = window.daily.onLinuxAudioChunk((payload) => {
      if (!session.running) return;
      const pcm = Float32Array.from(payload.samples || []);
      setMeter(payload.rms || 0);
      if (pcm.length) rememberVoice(pcm);
      if (engine === "cloud") {
        ingestCloudHop(pcm);
      } else if ((payload.rms || 0) > 0.003 && pcm.length) {
        ingestLiveHop(pcm, payload.sinkName || "pipewire");
      } else if ((payload.rms || 0) < 0.003 && session.partial) {
        pushFinal(session.partial, session.lastVoicePcm);
        session.liveBuf = [];
      }
    });
    session.offLinuxStatus = window.daily.onLinuxAudioStatus((payload) => {
      if (!session.running) return;
      setStatus(
        payload.linked
          ? `Capturando ${payload.sinkName}`
          : `Aguardando áudio de ${payload.sinkName || "um vídeo ou app"}`,
        payload.sinkName || "pipewire",
      );
    });
    session.offLinuxError = window.daily.onLinuxAudioError((message) => {
      if (message && !/interrupted|SIGINT/i.test(message)) setStatus(message);
    });

    if (!mixed?.getAudioTracks().length && !session.usingLinuxAudio) {
      throw new Error("Nenhuma faixa de áudio capturada. Autorize o microfone.");
    }

    const useSpeech = engine === "speech" && ui.source.value === "mic" && !session.usingLinuxAudio;
    const useCloud = engine === "cloud";
    const useLocal = !useCloud;

    if (useSpeech) {
      session.speech = createSpeechRecognizer({
        language: ui.language.value,
        onPartial: (text) => {
          session.partial = text;
          publish();
          maybeTranslate(text);
        },
        onFinal: pushFinal,
        onError: (error) => {
          setStatus(`Web Speech: ${error}`, "trocando para Whisper local");
          startLocalWhisper(mixed);
        },
      });
      if (session.speech) {
        session.speech.start();
      } else {
        setStatus("Web Speech indisponível neste Electron", "Whisper local");
      }
    }

    if (useLocal && !useCloud) startLocalWhisper(mixed);

    if (useCloud) {
      if (mixed) {
        session.collector = createPcmCollector(mixed, {
          intervalMs: 250,
          overlapMs: 0,
          emitSilence: true,
          onLevel: setMeter,
          onChunk: ingestCloudHop,
        });
      } else if (!session.usingLinuxAudio) {
        throw new Error("A API na nuvem precisa de áudio do Discord ou do microfone.");
      }
    }
  } catch (error) {
    await stopSession();
    setStatus(error.message || "Não foi possível capturar o áudio");
  }
}

async function stopSession() {
  clearSpeechQueue();
  session.running = false;
  session.jobs = [];
  session.cloudPcm = [];
  session.liveBuf = [];
  ui.toggle.textContent = "Iniciar transcrição";
  ui.toggle.classList.remove("live");
  ui.mark.dataset.live = "false";
  setMeter(0);
  clearInterval(session.clockTimer);
  session.speech?.stop();
  session.speech = null;
  session.recorder?.stop();
  session.recorder = null;
  await session.collector?.close();
  session.collector = null;
  session.offLinuxChunk?.();
  session.offLinuxError?.();
  session.offLinuxStatus?.();
  session.offLinuxChunk = null;
  session.offLinuxError = null;
  session.offLinuxStatus = null;
  if (session.usingLinuxAudio) {
    await applySourceDuck();
    await window.daily.stopLinuxAudio();
    session.usingLinuxAudio = false;
  }
  if (session.mixer?.audioContext && session.mixer.audioContext.state !== "closed") {
    await session.mixer.audioContext.close();
  }
  session.mixer = null;
  for (const stream of session.streams) stopStream(stream);
  session.streams = [];
  session.partial = "";
  session.partialSpeaker = "";
  session.translation = "";
  session.lastTranslateSent = "";
  session.lastVoicePcm = null;
  session.sttQueue = [];
  session.segBuf = [];
  session.quietHops = 0;
  session.translateQueue = [];
  session.translateBusy = false;
  session.translateCurrent = null;
  clearTimeout(session.translateTimer);
  if (session.ttsCtx && session.ttsCtx.state !== "closed") {
    await session.ttsCtx.close();
  }
  session.ttsCtx = null;
  publish();
  setStatus("Pronto");
}

function engineLabel(engine) {
  if (engine === "speech") return "Web Speech";
  if (engine === "cloud") return ui.provider.value;
  return "whisper-tiny";
}

ui.toggle.addEventListener("click", () => {
  if (session.running) stopSession();
  else startSession();
});

ui.copy.addEventListener("click", async () => {
  await window.daily.writeClipboard(formatAta());
  setStatus("Ata copiada");
});

ui.clear.addEventListener("click", () => {
  session.lines = [];
  session.linesPt = [];
  session.linesSpeakers = [];
  session.partial = "";
  session.partialSpeaker = "";
  session.translation = "";
  session.lastTranslateSent = "";
  session.translateSeq += 1;
  clearSpeechQueue();
  publish();
});

window.daily.onYoutubeProgress(({ message }) => {
  if (ui.youtubeHint) ui.youtubeHint.textContent = message;
  setStatus(message, "youtube");
});

ui.youtubeGo?.addEventListener("click", async () => {
  const url = ui.youtubeUrl.value.trim();
  if (!url) {
    setStatus("Cola o link do YouTube");
    return;
  }
  if (!ui.apiKey.value.trim()) {
    setStatus("Cola a API key do Whisper para transcrever o vídeo");
    return;
  }
  ui.youtubeGo.disabled = true;
  ui.youtubeGo.textContent = "Trabalhando…";
  persistSettings();
  try {
    const result = await window.daily.youtubeCaption({
      url,
      language: ui.language.value,
      apiKey: ui.apiKey.value.trim(),
      provider: ui.provider.value,
      translateEngine: ui.translateEngine?.value || "free",
      dubVoice: ui.youtubeDub?.checked !== false,
      ...selectedModels(),
    });
    session.lines = result.lines || [];
    session.linesPt = result.linesPt || [];
    session.linesSpeakers = (result.lines || []).map(() => "Vídeo");
    session.partial = "";
    session.translation = session.linesPt.at(-1) || "";
    publish();
    setStatus(result.dubbed ? `Dublado: ${result.output}` : `Legendado: ${result.output}`, "youtube");
    if (ui.youtubeHint) {
      ui.youtubeHint.textContent = result.dubbed
        ? `Pronto. Dublado: ${result.dubbed}`
        : `Pronto. Legendado: ${result.output}`;
    }
  } catch (error) {
    const message = error.message || "Falha no YouTube";
    setStatus(message);
    if (ui.youtubeHint) ui.youtubeHint.textContent = message;
  } finally {
    ui.youtubeGo.disabled = false;
    ui.youtubeGo.textContent = "Baixar, legendas e dublagem";
  }
});

for (const el of [
  ui.language,
  ui.source,
  ui.engine,
  ui.audioApp,
  ui.provider,
  ui.apiKey,
  ui.sttModel,
  ui.chatModel,
  ui.ttsModel,
  ui.youtubeDub,
  ui.follow,
  ui.overlayVisible,
  ui.clickThrough,
  ui.hideCapture,
  ui.translatePt,
  ui.voiceTranslate,
  ui.originalVolume,
  ui.aiVolume,
  ui.translateEngine,
  ui.translateOpacity,
  ui.display,
]) {
  if (!el) continue;
  el.addEventListener("change", async () => {
    syncCloudVisibility();
    await persistSettings();
    if (el === ui.overlayVisible) {
      // Legenda desligada por enquanto.
      // await window.daily.setOverlayVisible(ui.overlayVisible.checked);
      await window.daily.setOverlayVisible(false);
    }
    if (el === ui.clickThrough) await window.daily.setClickThrough(ui.clickThrough.checked);
    if (el === ui.hideCapture) await window.daily.setHideFromCapture(ui.hideCapture.checked);
    if (el === ui.follow || el === ui.display) await applyDisplayChoice();
    if (el === ui.audioApp && session.running && session.usingLinuxAudio) {
      try {
        await window.daily.stopLinuxAudio();
        const linux = await window.daily.startLinuxAudio(ui.audioApp.value || null);
        if (linux?.sinkName) setStatus(`Capturando ${linux.sinkName}`, engineLabel(selectedEngine()));
        await applySourceDuck();
      } catch (error) {
        setStatus(error.message || "Falha ao trocar o canal de áudio");
      }
    }
    if (el === ui.provider || el === ui.apiKey || el === ui.voiceTranslate || el === ui.sttModel || el === ui.chatModel || el === ui.ttsModel) {
      session.gptBlocked = false;
      session.gptBlockedMsg = "";
    }
    if (el === ui.voiceTranslate) {
      await applySourceDuck();
      if (!ui.voiceTranslate.checked) {
        clearSpeechQueue();
      } else if (session.running) {
        session.lastTranslateSent = "";
        maybeTranslate(session.partial || session.lines.at(-1) || "", { immediate: true });
      }
    }
    if (el === ui.language && session.running && wantsLiveTranslate()) {
      session.lastTranslateSent = "";
      maybeTranslate(session.partial || session.lines.at(-1) || "", { immediate: true });
    }
    if (el === ui.translatePt) {
      if (ui.translatePt.checked && ui.translateEngine?.value === "cloud" && !ui.apiKey.value.trim()) {
        setStatus("Tradução paga precisa da API key (OpenAI ou Groq)");
      }
      await window.daily.setTranslateVisible(false);
      // Legenda desligada por enquanto.
      // await window.daily.setTranslateVisible(ui.translatePt.checked);
      maybeTranslate(session.partial || session.lines.at(-1) || "", { immediate: true });
    }
    if (el === ui.translateEngine) {
      maybeTranslate(session.partial || session.lines.at(-1) || "", { immediate: true });
    }
    if (el === ui.translateOpacity) {
      await window.daily.setTranslateOpacity(Number(ui.translateOpacity.value) / 100);
    }
  });
}

ui.audioApp?.addEventListener("focus", () => {
  fillAudioApps(ui.audioApp.value);
});

ui.translateOpacity?.addEventListener("input", () => {
  window.daily.setTranslateOpacity(Number(ui.translateOpacity.value) / 100);
});

ui.originalVolume?.addEventListener("input", () => {
  applySourceDuck();
  persistSettings();
});

ui.aiVolume?.addEventListener("input", () => {
  persistSettings();
});

ui.apiKey.addEventListener("input", () => {
  persistSettings();
  session.gptBlocked = false;
  session.gptBlockedMsg = "";
  if (ui.apiKey.value.trim().startsWith("sk-")) ui.provider.value = "openai";
});

window.daily.onHotkeyToggle(() => {
  if (session.running) stopSession();
  else startSession();
});

window.daily.onOverlayVisibility(({ visible }) => {
  ui.overlayVisible.checked = visible;
});

window.daily.onClickThrough(({ clickThrough }) => {
  ui.clickThrough.checked = clickThrough;
});

window.daily.onTranslateVisibility(({ visible }) => {
  ui.translatePt.checked = visible;
  persistSettings();
});

function restoreSelect(el, value, fallback) {
  if (!el) return;
  const next = value || fallback;
  el.value = next;
  if (el.value !== next) el.value = fallback;
}

async function boot() {
  const state = await window.daily.getState();
  const settings = state.settings || {};
  ui.language.value = settings.language || "pt-BR";
  ui.source.value = settings.source === "mic" ? "mic" : "system";
  ui.apiKey.value = settings.apiKey || "";
  ui.provider.value = settings.provider || "groq";
  restoreSelect(ui.sttModel, settings.sttModel, "gpt-4o-mini-transcribe");
  restoreSelect(ui.chatModel, settings.chatModel, "gpt-4.1-nano");
  restoreSelect(ui.ttsModel, settings.ttsModel, "tts-1");
  if (ui.apiKey.value.trim()) {
    ui.engine.value = "cloud";
    if (ui.apiKey.value.trim().startsWith("sk-")) ui.provider.value = "openai";
  } else {
    const savedEngine = settings.engine || "auto";
    if (savedEngine === "cloud" || (savedEngine === "speech" && ui.source.value !== "mic")) {
      ui.engine.value = "auto";
    } else {
      ui.engine.value = savedEngine;
    }
  }
  ui.follow.checked = settings.follow !== false;
  // Legenda desligada por enquanto — só áudio da IA.
  ui.overlayVisible.checked = false;
  // ui.overlayVisible.checked = settings.overlayVisible !== false;
  ui.clickThrough.checked = settings.clickThrough !== false;
  ui.hideCapture.checked = Boolean(settings.hideCapture);
  ui.translatePt.checked = Boolean(settings.translatePt);
  if (ui.voiceTranslate) ui.voiceTranslate.checked = Boolean(settings.voiceTranslate);
  if (ui.originalVolume) ui.originalVolume.value = String(settings.originalVolume || 12);
  if (ui.aiVolume) ui.aiVolume.value = String(settings.aiVolume || 320);
  if (ui.translateEngine) ui.translateEngine.value = settings.translateEngine || "free";
  if (ui.translateOpacity) {
    ui.translateOpacity.value = String(Math.round((Number(settings.translateOpacity) || 0) * 100));
  }
  if (ui.youtubeUrl) ui.youtubeUrl.value = settings.youtubeUrl || "";
  if (ui.youtubeDub) ui.youtubeDub.checked = settings.youtubeDub !== false;
  fillDisplays(state.displays, settings);
  await fillAudioApps(settings.audioApp);
  syncCloudVisibility();
  await window.daily.setOverlayVisible(false);
  // await window.daily.setOverlayVisible(ui.overlayVisible.checked);
  await window.daily.setClickThrough(ui.clickThrough.checked);
  await window.daily.setHideFromCapture(ui.hideCapture.checked);
  await window.daily.setTranslateVisible(false);
  // await window.daily.setTranslateVisible(ui.translatePt.checked);
  if (ui.translateOpacity) {
    await window.daily.setTranslateOpacity(Number(ui.translateOpacity.value) / 100);
  }
  await applyDisplayChoice();
  await persistSettings();
  publish();
  setInterval(() => {
    if (!session.running) fillAudioApps(ui.audioApp.value);
  }, 4000);
}

boot();
