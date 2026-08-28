import {
  createBlobRecorder,
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
  translateEngine: $("translateEngine"),
  translateOpacity: $("translateOpacity"),
  cloudFields: $("cloudFields"),
  provider: $("provider"),
  apiKey: $("apiKey"),
  status: $("status"),
  engineStatus: $("engineStatus"),
  partial: $("partial"),
  transcript: $("transcript"),
  copy: $("copy"),
  clear: $("clear"),
  mark: document.querySelector(".mark"),
  meterBar: $("meterBar"),
};

const session = {
  running: false,
  startedAt: null,
  lines: [],
  linesPt: [],
  partial: "",
  translation: "",
  translateTimer: null,
  translateSeq: 0,
  lastTranslateSent: "",
  lastTranslateAt: 0,
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
};

function selectedEngine() {
  const key = ui.apiKey.value.trim();
  const raw = ui.engine.value;
  if (key && raw !== "local" && raw !== "speech") return "cloud";
  if (raw === "cloud") return key ? "cloud" : "local";
  if (raw === "speech") return ui.source.value === "mic" ? "speech" : "local";
  return "local";
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
      const pt = session.linesPt[i];
      return pt ? `${en}\n→ ${pt}` : en;
    })
    .join("\n\n");
}

function publish() {
  const payload = {
    running: session.running,
    elapsed: session.startedAt ? Date.now() - session.startedAt : 0,
    partial: session.partial,
    lines: session.lines,
    linesPt: session.linesPt,
    translation: session.translation || "",
    text: formatAta(),
  };
  ui.partial.textContent = [session.partial, session.translation].filter(Boolean).join("\n");
  ui.transcript.textContent = payload.text;
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
  window.daily.sendTranscript(payload);
  window.daily.sendStatus({
    running: session.running,
    elapsed: payload.elapsed,
    engine: selectedEngine(),
  });
}

function pushFinal(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return;
  const last = session.lines[session.lines.length - 1];
  if (last && last.includes(clean)) return;
  if (last && clean.includes(last) && clean.length - last.length < 80) {
    session.lines[session.lines.length - 1] = clean;
  } else {
    session.lines.push(clean);
    session.linesPt.push("");
  }
  session.partial = "";
  publish();
  maybeTranslate(clean, { immediate: true });
}

function maybeTranslate(text, { immediate = false } = {}) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  clearTimeout(session.translateTimer);
  if (!ui.translatePt?.checked) {
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
  const prev = session.lastTranslateSent;
  if (source === prev) return;
  if (
    !immediate &&
    prev &&
    source.startsWith(prev) &&
    source.length - prev.length < 20 &&
    Date.now() - session.lastTranslateAt < 2000
  ) {
    return;
  }
  const run = async () => {
    if (source === session.lastTranslateSent) return;
    const seq = (session.translateSeq += 1);
    session.lastTranslateSent = source;
    session.lastTranslateAt = Date.now();
    try {
      const pt = await window.daily.translateText({
        text: source,
        apiKey: ui.apiKey.value.trim(),
        provider: ui.provider.value,
        engine: ui.translateEngine?.value || "free",
        language: ui.language.value,
      });
      if (seq !== session.translateSeq) return;
      session.translation = pt;
      const lastIndex = session.lines.length - 1;
      const last = session.lines[lastIndex];
      if (last && (source === last || last.includes(source) || source.includes(last))) {
        session.linesPt[lastIndex] = pt;
      }
      publish();
    } catch (error) {
      if (seq !== session.translateSeq) return;
      setStatus(error.message || "Falha ao traduzir");
    }
  };
  if (immediate) run();
  else session.translateTimer = setTimeout(run, 1400);
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
    translateEngine: ui.translateEngine?.value || "free",
    translateOpacity: Number(ui.translateOpacity?.value || 0) / 100,
    provider: ui.provider.value,
    apiKey: ui.apiKey.value,
    displayId: ui.display.value === "follow" ? null : Number(ui.display.value),
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
}

function setMeter(level) {
  if (!ui.meterBar) return;
  const pct = Math.min(100, Math.round(Math.sqrt(Math.max(0, level)) * 220));
  ui.meterBar.style.width = `${pct}%`;
}

function looksLikeJunk(text) {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (t.length < 2) return true;
  return /♪|♫|thanks for watching|subtitle|legenda da|opening credits|theme song/.test(t);
}

const CLOUD_HOP = 9600;
const CLOUD_FLUSH = 28800;

async function flushCloudAudio() {
  if (!session.running || session.busy || session.cloudPcm.length < 8000) return;
  const pcm = Float32Array.from(session.cloudPcm);
  session.cloudPcm = [];
  session.busy = true;
  try {
    const wav = floatToWavBlob(pcm);
    const text = await transcribeCloud(wav, {
      apiKey: ui.apiKey.value.trim(),
      provider: ui.provider.value,
      language: ui.language.value,
    });
    if (text && !looksLikeJunk(text)) {
      session.partial = text;
      publish();
      pushFinal(text);
    }
    setStatus("Ao vivo", ui.provider.value);
  } catch (error) {
    setStatus(error.message || "Falha na API");
  } finally {
    session.busy = false;
  }
}

function ingestCloudHop(pcm) {
  const hop = pcm.length > CLOUD_HOP ? pcm.subarray(pcm.length - CLOUD_HOP) : pcm;
  for (let i = 0; i < hop.length; i += 1) session.cloudPcm.push(hop[i]);
  if (session.cloudPcm.length >= CLOUD_FLUSH) flushCloudAudio();
}

const LIVE_SAMPLES = 16000;
const LIVE_MAX = 16000 * 1.4;

function liveRms(pcm) {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

function updateLiveCaption(text) {
  const prev = session.partial;
  if (!prev) {
    session.partial = text;
    publish();
    maybeTranslate(text);
    return;
  }
  if (text.includes(prev) || prev.endsWith(text) || text.startsWith(prev.slice(0, Math.min(18, prev.length)))) {
    session.partial = text.length >= prev.length ? text : prev;
    publish();
    maybeTranslate(session.partial);
    return;
  }
  if (prev.split(" ").length >= 5) pushFinal(prev);
  session.partial = text;
  publish();
  maybeTranslate(text);
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
  session.jobs = [{ pcm, origin }];
  pumpJobs();
}

async function pumpJobs() {
  if (session.busy || !session.running) return;
  const job = session.jobs.shift();
  if (!job) return;
  session.busy = true;
  try {
    const text = await transcribeLocal(job.pcm, ui.language.value, (progress) => {
      if (progress.status === "progress") {
        setStatus(`Baixando modelo ${Math.round(progress.progress || 0)}%`, "whisper-tiny");
      }
      if (progress.status === "ready") {
        setStatus("Ao vivo", "whisper-tiny");
      }
    });
    if (text && !looksLikeJunk(text)) {
      updateLiveCaption(text);
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
    ? "Auto (Discord / Teams / Meet / Zoom)"
    : "Auto · nenhum app tocando agora";
  ui.audioApp.append(auto);
  for (const source of sources) {
    const option = document.createElement("option");
    option.value = source.key || String(source.id);
    option.dataset.id = String(source.id);
    option.textContent = source.hint ? `${source.label} · ${source.hint}` : source.label;
    ui.audioApp.append(option);
  }
  const match = [...ui.audioApp.options].find(
    (option) =>
      option.value === String(previous) ||
      option.dataset.id === String(previous) ||
      option.value === previous,
  );
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

  session.running = true;
  session.startedAt = Date.now();
  session.jobs = [];
  session.cloudPcm = [];
  session.liveBuf = [];
  session.usingLinuxAudio = false;
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
    if (linux?.sinkName) {
      setStatus(`Capturando ${linux.sinkName}`, engineLabel(engine));
    }

    session.offLinuxChunk = window.daily.onLinuxAudioChunk((payload) => {
      if (!session.running) return;
      const pcm = Float32Array.from(payload.samples || []);
      setMeter(payload.rms || 0);
      setStatus(
        `Sinal ${(payload.rms || 0).toFixed(3)} · ${payload.linked || 0} links`,
        payload.sinkName || "pipewire",
      );
      if ((payload.rms || 0) > 0.003 && pcm.length) {
        if (engine === "cloud") ingestCloudHop(pcm);
        else ingestLiveHop(pcm, payload.sinkName || "pipewire");
      } else if ((payload.rms || 0) < 0.003 && session.partial) {
        if (engine === "cloud") flushCloudAudio();
        else {
          pushFinal(session.partial);
          session.liveBuf = [];
        }
      }
    });
    session.offLinuxStatus = window.daily.onLinuxAudioStatus((payload) => {
      if (!session.running) return;
      setStatus(
        payload.linked
          ? `Só voz Discord (${payload.sinkName})`
          : "Discord voz não linkada — entra na call e espera",
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
        session.recorder = createBlobRecorder(mixed, {
          intervalMs: 1800,
          onBlob: async (blob) => {
            if (session.busy || !session.running) return;
            session.busy = true;
            try {
              const text = await transcribeCloud(blob, {
                apiKey: ui.apiKey.value.trim(),
                provider: ui.provider.value,
                language: ui.language.value,
              });
              if (text && !looksLikeJunk(text)) {
                session.partial = text;
                publish();
                pushFinal(text);
              }
              setStatus("Ao vivo", ui.provider.value);
            } catch (error) {
              setStatus(error.message || "Falha na API");
            } finally {
              session.busy = false;
            }
          },
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
  session.translation = "";
  session.lastTranslateSent = "";
  clearTimeout(session.translateTimer);
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
  session.partial = "";
  session.translation = "";
  session.lastTranslateSent = "";
  session.translateSeq += 1;
  publish();
});

for (const el of [
  ui.language,
  ui.source,
  ui.engine,
  ui.audioApp,
  ui.provider,
  ui.apiKey,
  ui.follow,
  ui.overlayVisible,
  ui.clickThrough,
  ui.hideCapture,
  ui.translatePt,
  ui.translateEngine,
  ui.translateOpacity,
  ui.display,
]) {
  if (!el) continue;
  el.addEventListener("change", async () => {
    syncCloudVisibility();
    await persistSettings();
    if (el === ui.overlayVisible) await window.daily.setOverlayVisible(ui.overlayVisible.checked);
    if (el === ui.clickThrough) await window.daily.setClickThrough(ui.clickThrough.checked);
    if (el === ui.hideCapture) await window.daily.setHideFromCapture(ui.hideCapture.checked);
    if (el === ui.follow || el === ui.display) await applyDisplayChoice();
    if (el === ui.audioApp && session.running && session.usingLinuxAudio) {
      try {
        await window.daily.stopLinuxAudio();
        const linux = await window.daily.startLinuxAudio(ui.audioApp.value || null);
        if (linux?.sinkName) setStatus(`Capturando ${linux.sinkName}`, engineLabel(selectedEngine()));
      } catch (error) {
        setStatus(error.message || "Falha ao trocar o canal de áudio");
      }
    }
    if (el === ui.translatePt) {
      if (ui.translatePt.checked && ui.translateEngine?.value === "cloud" && !ui.apiKey.value.trim()) {
        setStatus("Tradução paga precisa da API key (OpenAI ou Groq)");
      }
      await window.daily.setTranslateVisible(ui.translatePt.checked);
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

ui.apiKey.addEventListener("input", () => {
  persistSettings();
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

async function boot() {
  const state = await window.daily.getState();
  const settings = state.settings || {};
  ui.language.value = settings.language || "pt-BR";
  ui.source.value = settings.source === "mic" ? "mic" : "system";
  ui.apiKey.value = settings.apiKey || "";
  ui.provider.value = settings.provider || "groq";
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
  ui.overlayVisible.checked = settings.overlayVisible !== false;
  ui.clickThrough.checked = settings.clickThrough !== false;
  ui.hideCapture.checked = Boolean(settings.hideCapture);
  ui.translatePt.checked = Boolean(settings.translatePt);
  if (ui.translateEngine) ui.translateEngine.value = settings.translateEngine || "free";
  if (ui.translateOpacity) {
    ui.translateOpacity.value = String(Math.round((Number(settings.translateOpacity) || 0) * 100));
  }
  fillDisplays(state.displays, settings);
  await fillAudioApps(settings.audioApp);
  syncCloudVisibility();
  await window.daily.setOverlayVisible(ui.overlayVisible.checked);
  await window.daily.setClickThrough(ui.clickThrough.checked);
  await window.daily.setHideFromCapture(ui.hideCapture.checked);
  await window.daily.setTranslateVisible(ui.translatePt.checked);
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
