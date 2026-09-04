const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  screen,
  session,
  desktopCapturer,
  Tray,
  Menu,
  nativeImage,
  clipboard,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const dns = require("node:dns");
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  /* older node */
}
const { LinuxSystemCapture, listPlaybackSources } = require("./linux-audio");
const { runYoutubeJob } = require("./youtube-job");

const isDev = process.env.VITE_DEV_SERVER === "1";
const DEV_URL = "http://127.0.0.1:5173";

let controlWindow = null;
let overlayWindow = null;
let translateWindow = null;
let tray = null;
let followDisplayTimer = null;
let overlayBounds = null;
let translateBoundsTimer = null;
let quitting = false;
const linuxCapture = new LinuxSystemCapture();

const state = {
  overlayVisible: true,
  clickThrough: true,
  followCursorDisplay: true,
  hideFromCapture: false,
  selectedDisplayId: null,
};

function rendererUrl(page) {
  if (isDev) return `${DEV_URL}/${page}/index.html`;
  return path.join(__dirname, "..", "dist", page, "index.html");
}

function loadWindow(win, page) {
  if (isDev) {
    win.loadURL(rendererUrl(page));
  } else {
    win.loadFile(rendererUrl(page));
  }
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(next) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 420,
    height: 820,
    minWidth: 380,
    minHeight: 620,
    backgroundColor: "#101114",
    title: "Daily Overlay",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

  loadWindow(controlWindow, "control");
  controlWindow.on("closed", () => {
    controlWindow = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
    if (translateWindow && !translateWindow.isDestroyed()) {
      translateWindow.removeAllListeners("close");
      translateWindow.destroy();
    }
  });
}

function overlayDisplay() {
  const displays = screen.getAllDisplays();
  if (state.followCursorDisplay) {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }
  if (state.selectedDisplayId != null) {
    return displays.find((d) => d.id === state.selectedDisplayId) || screen.getPrimaryDisplay();
  }
  return screen.getPrimaryDisplay();
}

function computeOverlayBounds(display) {
  const { x, y, width, height } = display.workArea;
  const overlayHeight = Math.round(Math.min(280, Math.max(160, height * 0.22)));
  return {
    x,
    y: y + height - overlayHeight - 12,
    width,
    height: overlayHeight,
  };
}

function applyOverlayPlacement() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const bounds = computeOverlayBounds(overlayDisplay());
  overlayBounds = bounds;
  overlayWindow.setBounds(bounds, false);
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function createOverlayWindow() {
  const bounds = computeOverlayBounds(overlayDisplay());
  overlayBounds = bounds;

  overlayWindow = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  if (typeof overlayWindow.setContentProtection === "function") {
    overlayWindow.setContentProtection(state.hideFromCapture);
  }

  loadWindow(overlayWindow, "overlay");
  overlayWindow.once("ready-to-show", () => {
    applyOverlayPlacement();
    if (state.overlayVisible) overlayWindow.showInactive();
  });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

function startFollowDisplay() {
  stopFollowDisplay();
  followDisplayTimer = setInterval(() => {
    if (!state.followCursorDisplay) return;
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const next = computeOverlayBounds(overlayDisplay());
    if (
      !overlayBounds ||
      next.x !== overlayBounds.x ||
      next.y !== overlayBounds.y ||
      next.width !== overlayBounds.width
    ) {
      applyOverlayPlacement();
    }
  }, 700);
}

function stopFollowDisplay() {
  if (followDisplayTimer) {
    clearInterval(followDisplayTimer);
    followDisplayTimer = null;
  }
}

function listDisplays() {
  const cursor = screen.getCursorScreenPoint();
  const active = screen.getDisplayNearestPoint(cursor);
  return screen.getAllDisplays().map((d, index) => ({
    id: d.id,
    label: `Monitor ${index + 1} · ${d.size.width}×${d.size.height}`,
    bounds: d.bounds,
    primary: d.id === screen.getPrimaryDisplay().id,
    active: d.id === active.id,
  }));
}

function broadcast(channel, payload) {
  for (const win of [controlWindow, overlayWindow, translateWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function defaultTranslateBounds() {
  const { x, y, width, height } = overlayDisplay().workArea;
  const w = Math.min(480, Math.max(320, Math.round(width * 0.28)));
  const h = Math.min(520, Math.max(240, Math.round(height * 0.42)));
  return { x: x + width - w - 20, y: y + 48, width: w, height: h };
}

function clampBoundsToDisplays(bounds) {
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
    return defaultTranslateBounds();
  }
  const displays = screen.getAllDisplays();
  const visible = displays.some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + Math.min(bounds.width, 80) > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + Math.min(bounds.height, 80) > area.y
    );
  });
  return visible
    ? {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.max(260, Math.round(bounds.width)),
        height: Math.max(160, Math.round(bounds.height)),
      }
    : defaultTranslateBounds();
}

function persistTranslateBoundsSoon() {
  if (!translateWindow || translateWindow.isDestroyed()) return;
  clearTimeout(translateBoundsTimer);
  translateBoundsTimer = setTimeout(() => {
    if (!translateWindow || translateWindow.isDestroyed()) return;
    const current = loadSettings();
    saveSettings({ ...current, translateBounds: translateWindow.getBounds() });
  }, 250);
}

function setTranslateVisible(visible) {
  const show = Boolean(visible);
  if (show && (!translateWindow || translateWindow.isDestroyed())) {
    createTranslateWindow();
  }
  if (translateWindow && !translateWindow.isDestroyed()) {
    if (show) {
      translateWindow.showInactive();
      translateWindow.setAlwaysOnTop(true, "screen-saver");
    } else {
      persistTranslateBoundsSoon();
      translateWindow.hide();
    }
  }
  const current = loadSettings();
  saveSettings({ ...current, translatePt: show });
  broadcast("translate:visibility", { visible: show });
  return show;
}

function createTranslateWindow() {
  const saved = loadSettings().translateBounds;
  const bounds = clampBoundsToDisplays(saved);

  translateWindow = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    alwaysOnTop: true,
    minWidth: 260,
    minHeight: 160,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  translateWindow.setAlwaysOnTop(true, "screen-saver");
  translateWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (typeof translateWindow.setContentProtection === "function") {
    translateWindow.setContentProtection(state.hideFromCapture);
  }

  loadWindow(translateWindow, "translate");
  translateWindow.webContents.once("did-finish-load", () => {
    const opacity = Math.max(0, Math.min(0.9, Number(loadSettings().translateOpacity) || 0));
    translateWindow.webContents.send("translate:opacity", { opacity });
  });
  translateWindow.on("moved", persistTranslateBoundsSoon);
  translateWindow.on("resized", persistTranslateBoundsSoon);
  translateWindow.on("resize", persistTranslateBoundsSoon);
  translateWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    setTranslateVisible(false);
  });
  translateWindow.on("closed", () => {
    translateWindow = null;
  });
}

function createTray() {
  const png = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAAA7ElEQVR4nO2WMQ6DMAxFcwJGbsDIFRi5Qq/AzRijR8jI6MjI6OiZ+gqpVClNGidpB/iSZfnZ/2E7NqAoioKZcQ0gA3gAeAYwA7gB2AFsmXl3rjsC2Jj5cK4bANyZ+XKu6wHszHw61zUAwwrA2szv7gJYAVhXANYVgHUFYF0BWFcA1hWAdQVgXQH4S8ARwBHAEcARwBHA8Y8Apnvd0A2Z+d3dAGa+M/PTjWFynZkPNzqZ+c7MLzeGyXVmPt3oZOY7M7/dGCbXmflyo5OZ78z8cWOYXGfm040AZj6Z+eXGMLnOzC83OveZ+dON7j8A/gXwBYrfN1/pS5cTAAAAAElFTkSuQmCC",
  );
  tray = new Tray(png.resize({ width: 16, height: 16 }));
  tray.setToolTip("Daily Overlay");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Mostrar painel",
        click: () => {
          if (!controlWindow) createControlWindow();
          else {
            controlWindow.show();
            controlWindow.focus();
          }
        },
      },
      {
        label: "Mostrar / ocultar overlay",
        click: () => {
          state.overlayVisible = !state.overlayVisible;
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            state.overlayVisible ? overlayWindow.showInactive() : overlayWindow.hide();
          }
          broadcast("overlay:visibility", { visible: state.overlayVisible });
        },
      },
      {
        label: "Mostrar / ocultar tradução",
        click: () => {
          const visible = !(translateWindow && translateWindow.isVisible());
          setTranslateVisible(visible);
        },
      },
      { type: "separator" },
      { label: "Sair", click: () => app.quit() },
    ]),
  );
}

function registerShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+D", () => {
    broadcast("hotkey:toggle-listen");
  });
  globalShortcut.register("CommandOrControl+Shift+O", () => {
    state.overlayVisible = !state.overlayVisible;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      state.overlayVisible ? overlayWindow.showInactive() : overlayWindow.hide();
    }
    broadcast("overlay:visibility", { visible: state.overlayVisible });
  });
  globalShortcut.register("CommandOrControl+Shift+L", () => {
    state.clickThrough = !state.clickThrough;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(state.clickThrough, { forward: true });
      overlayWindow.setFocusable(!state.clickThrough);
    }
    broadcast("overlay:click-through", { clickThrough: state.clickThrough });
  });
  globalShortcut.register("CommandOrControl+Shift+T", () => {
    const visible = !(translateWindow && translateWindow.isVisible());
    setTranslateVisible(visible);
  });
}

function sourceLang(language) {
  const value = String(language || "en");
  if (value.startsWith("pt")) return "pt";
  if (value.startsWith("es")) return "es";
  if (value.startsWith("fr")) return "fr";
  if (value.startsWith("de")) return "de";
  if (value.startsWith("it")) return "it";
  if (value.startsWith("ja")) return "ja";
  return "en";
}

function targetName(language) {
  const value = String(language || "pt-BR");
  if (value.startsWith("pt")) return "português brasileiro";
  if (value.startsWith("es")) return "espanhol";
  if (value.startsWith("fr")) return "francês";
  if (value.startsWith("de")) return "alemão";
  if (value.startsWith("it")) return "italiano";
  if (value.startsWith("ja")) return "japonês";
  if (value.startsWith("en")) return "inglês";
  return "português brasileiro";
}

function myMemoryTarget(language) {
  const value = String(language || "pt-BR");
  if (value.startsWith("pt")) return "pt-BR";
  if (value.startsWith("es")) return "es";
  if (value.startsWith("fr")) return "fr";
  if (value.startsWith("de")) return "de";
  if (value.startsWith("it")) return "it";
  if (value.startsWith("ja")) return "ja";
  return "en-US";
}

function cleanFreeTranslation(text) {
  return String(text || "")
    .replace(/^MYMEMORY WARNING:[^\n.]*[. ]*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function translateFree(source, language) {
  const to = myMemoryTarget(language);
  const chunk = String(source || "").slice(0, 480);
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=Autodetect|${to}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Tradução grátis falhou (${response.status}). Tenta de novo ou usa a opção paga.`);
  }
  const json = await response.json();
  const translated = cleanFreeTranslation(json.responseData?.translatedText);
  if (!translated) {
    throw new Error("Tradução grátis sem resultado. Se passar do limite do dia, usa a opção paga.");
  }
  return translated;
}

const STT_MODELS = new Set(["gpt-4o-mini-transcribe", "whisper-1", "gpt-4o-transcribe"]);
const CHAT_MODELS = new Set(["gpt-4.1-nano", "gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"]);
const TTS_MODELS = new Set(["tts-1", "tts-1-hd", "gpt-4o-mini-tts"]);

function pickModel(value, allowed, fallback) {
  const id = String(value || "").trim();
  return allowed.has(id) ? id : fallback;
}

async function translateCloud(source, { apiKey, provider, language, chatModel }) {
  const useOpenAI = provider === "openai" || String(apiKey || "").startsWith("sk-");
  const endpoint = useOpenAI
    ? "https://api.openai.com/v1/chat/completions"
    : "https://api.groq.com/openai/v1/chat/completions";
  const chosen = useOpenAI ? pickModel(chatModel, CHAT_MODELS, "gpt-4.1-nano") : "llama-3.1-8b-instant";
  const models = useOpenAI ? [chosen] : [chosen];
  const dest = targetName(language);
  const bodyFor = (model) =>
    JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 180,
      messages: [
        {
          role: "system",
          content: `Traduza para ${dest}. O texto de origem pode estar em qualquer idioma. Responda só com a tradução, sem aspas e sem explicação.`,
        },
        { role: "user", content: source },
      ],
    });

  let lastError = "";
  for (const model of models) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: bodyFor(model),
    });
    if (response.ok) {
      const json = await response.json();
      return String(json.choices?.[0]?.message?.content || "")
        .replace(/\s+/g, " ")
        .trim();
    }
    lastError = await response.text();
    if (response.status !== 404) {
      throw new Error(`Falha ao traduzir (${response.status}): ${lastError.slice(0, 180)}`);
    }
  }
  throw new Error(`Falha ao traduzir: ${lastError.slice(0, 180)}`);
}

async function translateAny(source, { apiKey, provider, engine, language, chatModel }) {
  const text = String(source || "").trim();
  if (!text) return "";
  if (engine !== "cloud") return translateFree(text, language);
  return translateCloud(text, { apiKey, provider, language, chatModel });
}

let interpretKey = "";
let interpretUnavailable = "";

function modelUnavailable(status, body) {
  if (status === 401 || status === 403) return false;
  if (status === 404) return true;
  return status === 400 && /does not exist|not have access|invalid model|unknown model/i.test(String(body));
}

function resetInterpretCache(apiKey, modelsKey) {
  const key = `${apiKey}|${modelsKey || ""}`;
  if (interpretKey === key) return;
  interpretKey = key;
  interpretUnavailable = "";
}

function looksLikeInterpreterChat(text) {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  if (/(me (diga|mande|envie|fala|fale)|o que (voce|vc) quer|como posso|estou (pronto|aqui)|pode (me )?(enviar|mandar)).{0,48}traduz/.test(t)) {
    return true;
  }
  if (/(claro|ok|certo|oi|ola)[,!. ]{0,6}(me (diga|mande|envie)|pode (falar|mandar|enviar)|estou (pronto|aqui)|o que (voce|vc) quer)/.test(t)) {
    return true;
  }
  return /how can i help|what (would you like|do you want) (me to )?translat|send me (the )?(text|audio)|tell me what (to|you)|i('d| would) be happy to translat|please (provide|send|paste)|ready when you are/.test(t);
}

function silentInterpret(model) {
  return { text: "", base64: "", mime: "audio/mpeg", model };
}

async function transcribeOpenAI(wav, apiKey, sttModel) {
  const model = pickModel(sttModel, STT_MODELS, "gpt-4o-mini-transcribe");
  const file = new Blob([wav], { type: "audio/wav" });
  const body = new FormData();
  body.append("file", file, "chunk.wav");
  body.append("model", model);
  body.append("response_format", "json");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
  });
  const detail = await response.text();
  if (response.ok) {
    const json = JSON.parse(detail);
    return String(json.text || "")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (response.status === 401 || response.status === 403) {
    interpretUnavailable = "Key OpenAI inválida ou sem permissão. GPT não está funcionando.";
    throw new Error(interpretUnavailable);
  }
  if (modelUnavailable(response.status, detail)) {
    throw new Error(`O modelo ${model} não está liberado nesta key. Escolhe outro.`);
  }
  throw new Error(`GPT transcrição falhou (${response.status}): ${detail.slice(0, 180)}`);
}

async function translateMeetingLine(source, { apiKey, language, chatModel }) {
  const dest = targetName(language);
  const model = pickModel(chatModel, CHAT_MODELS, "gpt-4.1-nano");
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 180,
      messages: [
        {
          role: "system",
          content: [
            `You are a television dubbing translator, not an assistant.`,
            `The user message is a line spoken on a live broadcast or meeting.`,
            `Write only the dubbed line in ${dest}.`,
            `Do not answer the speaker. Do not greet. Do not ask questions. Do not offer help. Do not comment.`,
            `If there is nothing to translate, output nothing.`,
          ].join(" "),
        },
        { role: "user", content: source },
      ],
    }),
  });
  if (response.ok) {
    const json = await response.json();
    return String(json.choices?.[0]?.message?.content || "")
      .replace(/\s+/g, " ")
      .trim();
  }
  const lastError = await response.text();
  if (modelUnavailable(response.status, lastError)) {
    throw new Error(`O modelo ${model} não está liberado nesta key. Escolhe outro.`);
  }
  throw new Error(`GPT tradução falhou (${response.status}): ${lastError.slice(0, 180)}`);
}

function ttsVoice(model) {
  return model === "gpt-4o-mini-tts" ? "coral" : "nova";
}

async function speakOpenAI(text, apiKey, ttsModel) {
  const model = pickModel(ttsModel, TTS_MODELS, "tts-1");
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      voice: ttsVoice(model),
      input: text.slice(0, 700),
      response_format: "mp3",
    }),
  });
  if (response.ok) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.toString("base64");
  }
  const lastDetail = await response.text();
  if (modelUnavailable(response.status, lastDetail)) {
    throw new Error(`O modelo ${model} não está liberado nesta key. Escolhe outro.`);
  }
  throw new Error(`GPT voz falhou (${response.status}): ${lastDetail.slice(0, 180)}`);
}

async function interpretSpeech(buffer, { apiKey, language, sttModel, chatModel, ttsModel }) {
  resetInterpretCache(apiKey, `${sttModel}|${chatModel}|${ttsModel}`);
  if (interpretUnavailable) throw new Error(interpretUnavailable);

  const wav = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const source = await transcribeOpenAI(wav, apiKey, sttModel);
  if (!source || looksLikeInterpreterChat(source)) {
    return silentInterpret("openai-interpret");
  }

  const translated = await translateMeetingLine(source, { apiKey, language, chatModel });
  if (!translated || looksLikeInterpreterChat(translated)) {
    return silentInterpret("openai-interpret");
  }

  const base64 = await speakOpenAI(translated, apiKey, ttsModel);
  return {
    text: translated,
    base64,
    mime: "audio/mpeg",
    model: "openai-interpret",
  };
}

function registerIpc() {
  ipcMain.handle("app:get-state", () => ({
    ...state,
    displays: listDisplays(),
    settings: loadSettings(),
    platform: process.platform,
  }));

  ipcMain.handle("settings:save", (_event, next) => {
    const current = loadSettings();
    const merged = { ...current, ...next };
    saveSettings(merged);
    return merged;
  });

  ipcMain.handle("overlay:set-visible", (_event, visible) => {
    state.overlayVisible = Boolean(visible);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      state.overlayVisible ? overlayWindow.showInactive() : overlayWindow.hide();
    }
    return state.overlayVisible;
  });

  ipcMain.handle("overlay:set-click-through", (_event, enabled) => {
    state.clickThrough = Boolean(enabled);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(state.clickThrough, { forward: true });
      overlayWindow.setFocusable(!state.clickThrough);
    }
    return state.clickThrough;
  });

  ipcMain.handle("overlay:set-follow-display", (_event, enabled) => {
    state.followCursorDisplay = Boolean(enabled);
    applyOverlayPlacement();
    return state.followCursorDisplay;
  });

  ipcMain.handle("overlay:set-display", (_event, displayId) => {
    state.selectedDisplayId = displayId;
    state.followCursorDisplay = false;
    applyOverlayPlacement();
    return listDisplays();
  });

  ipcMain.handle("overlay:set-hide-from-capture", (_event, enabled) => {
    state.hideFromCapture = Boolean(enabled);
    if (overlayWindow && !overlayWindow.isDestroyed() && typeof overlayWindow.setContentProtection === "function") {
      overlayWindow.setContentProtection(state.hideFromCapture);
    }
    if (translateWindow && !translateWindow.isDestroyed() && typeof translateWindow.setContentProtection === "function") {
      translateWindow.setContentProtection(state.hideFromCapture);
    }
    return state.hideFromCapture;
  });

  ipcMain.handle("overlay:list-displays", () => listDisplays());

  ipcMain.handle("translate:set-visible", (_event, visible) => setTranslateVisible(visible));

  ipcMain.handle("translate:set-opacity", (_event, opacity) => {
    const value = Math.max(0, Math.min(0.9, Number(opacity) || 0));
    const current = loadSettings();
    saveSettings({ ...current, translateOpacity: value });
    broadcast("translate:opacity", { opacity: value });
    return value;
  });

  ipcMain.handle("window:get-bounds", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.getBounds() : null;
  });

  ipcMain.handle("window:set-bounds", (event, bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !bounds) return null;
    const current = win.getBounds();
    win.setBounds(
      {
        x: Math.round(bounds.x ?? current.x),
        y: Math.round(bounds.y ?? current.y),
        width: Math.max(260, Math.round(bounds.width ?? current.width)),
        height: Math.max(160, Math.round(bounds.height ?? current.height)),
      },
      false,
    );
    if (win === translateWindow) persistTranslateBoundsSoon();
    return win.getBounds();
  });

  ipcMain.handle("clipboard:write", (_event, text) => {
    clipboard.writeText(String(text || ""));
    return true;
  });

  ipcMain.handle("linux-audio:available", () => linuxCapture.available);

  ipcMain.handle("linux-audio:sources", () => {
    try {
      return listPlaybackSources();
    } catch {
      return [];
    }
  });

  ipcMain.handle("linux-audio:start", (_event, sourceId) => {
    linuxCapture.removeAllListeners();
    linuxCapture.on("chunk", (payload) => {
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send("linux-audio:chunk", payload);
      }
    });
    linuxCapture.on("stderr", (message) => {
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send("linux-audio:error", message);
      }
    });
    linuxCapture.on("status", (payload) => {
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send("linux-audio:status", payload);
      }
    });
    const started = linuxCapture.start(sourceId);
    console.log("linux audio:", started);
    return started;
  });

  ipcMain.handle("linux-audio:stop", () => {
    linuxCapture.stop();
    return true;
  });

  ipcMain.handle("linux-audio:duck", (_event, volume) => {
    linuxCapture.setDuckVolume(volume == null ? null : Number(volume));
    return true;
  });

  ipcMain.handle("speak:text", async (_event, payload) => {
    const text = String(payload?.text || "").trim();
    const apiKey = String(payload?.apiKey || "").trim();
    if (!text) return { browser: true };
    const useOpenAI = apiKey.startsWith("sk-") || payload?.provider === "openai";
    if (!useOpenAI || !apiKey) return { browser: true, language: payload?.language || "pt-BR" };
    const model = pickModel(payload?.ttsModel, TTS_MODELS, "tts-1");
    const body = {
      model,
      voice: payload?.voice || ttsVoice(model),
      input: text.slice(0, 700),
      response_format: "mp3",
    };
    if (model === "tts-1" || model === "tts-1-hd") {
      body.speed = Math.max(0.85, Math.min(1.5, Number(payload?.speed) || 1));
    }
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Falha na voz da IA (${response.status}): ${detail.slice(0, 160)}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      mime: "audio/mpeg",
      base64: buffer.toString("base64"),
      language: payload?.language || "pt-BR",
    };
  });

  ipcMain.handle("interpret:audio", async (_event, payload) => {
    const apiKey = String(payload?.apiKey || "").trim();
    if (!apiKey) throw new Error("API key da OpenAI necessária para o intérprete.");
    return interpretSpeech(payload?.buffer, {
      apiKey,
      language: payload?.language || "pt-BR",
      sttModel: payload?.sttModel,
      chatModel: payload?.chatModel,
      ttsModel: payload?.ttsModel,
    });
  });

  ipcMain.handle("transcribe:cloud", async (_event, payload) => {
    const { buffer, mime, apiKey, provider, language, sttModel } = payload;
    const endpoint =
      provider === "openai"
        ? "https://api.openai.com/v1/audio/transcriptions"
        : "https://api.groq.com/openai/v1/audio/transcriptions";
    const model =
      provider === "openai" ? pickModel(sttModel, STT_MODELS, "gpt-4o-mini-transcribe") : "whisper-large-v3";
    const detect = payload.detectLanguage === true || language == null || language === "auto";
    const lang = String(language || "pt-BR").startsWith("pt")
      ? "pt"
      : String(language).startsWith("es")
        ? "es"
        : String(language).startsWith("fr")
          ? "fr"
          : String(language).startsWith("de")
            ? "de"
            : String(language).startsWith("it")
              ? "it"
              : String(language).startsWith("ja")
                ? "ja"
                : "en";

    const fileName = (mime || "").includes("wav") ? "chunk.wav" : "chunk.webm";
    const file = new Blob([buffer], { type: mime || "audio/webm" });
    const body = new FormData();
    body.append("file", file, fileName);
    body.append("model", model);
    if (!detect) body.append("language", lang);
    body.append("response_format", "json");

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Falha na API (${response.status}): ${detail.slice(0, 180)}`);
    }
    const json = await response.json();
    return String(json.text || "")
      .replace(/\s+/g, " ")
      .trim();
  });

  ipcMain.handle("translate:text", async (_event, payload) => {
    const { text, apiKey, provider, engine, language, chatModel } = payload;
    return translateAny(text, { apiKey, provider, engine, language, chatModel });
  });

  ipcMain.handle("youtube:caption", async (event, payload) => {
    const { url, language, apiKey, provider, translateEngine, sttModel, chatModel, ttsModel, dubVoice } = payload || {};
    const sendProgress = (message) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("youtube:progress", { message });
      }
    };
    const result = await runYoutubeJob({
      url,
      language,
      apiKey,
      provider,
      translateEngine,
      sttModel,
      dubVoice: dubVoice !== false,
      translateText: (text) =>
        translateAny(text, {
          apiKey,
          provider,
          engine: translateEngine || "free",
          language,
          chatModel,
        }),
      speakText:
        dubVoice !== false && (provider === "openai" || String(apiKey || "").startsWith("sk-"))
          ? async (text) => {
              const base64 = await speakOpenAI(text, apiKey, ttsModel);
              return { mime: "audio/mpeg", base64 };
            }
          : null,
      onProgress: sendProgress,
    });
    if (result.folder) shell.openPath(result.folder);
    return result;
  });

  ipcMain.handle("desktop:sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      display_id: source.display_id,
      thumbnail: source.thumbnail.toDataURL(),
    }));
  });

  ipcMain.on("transcript:update", (_event, payload) => {
    broadcast("transcript:update", payload);
  });

  ipcMain.on("session:status", (_event, payload) => {
    broadcast("session:status", payload);
  });
}

function setupDisplayMedia() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(["media", "display-capture", "audioCapture", "mediaKeySystem"].includes(permission));
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      const display = overlayDisplay();
      const match =
        sources.find((source) => String(source.display_id) === String(display.id)) || sources[0];

      if (!match) {
        callback({});
        return;
      }

      callback({
        video: match,
        audio: process.platform === "win32" ? "loopback" : undefined,
      });
    } catch (error) {
      console.warn("display media:", error.message);
      callback({});
    }
  });
}

function enableLinuxCapture() {
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer");
    app.commandLine.appendSwitch("ozone-platform-hint", "auto");
    if (!app.isPackaged) {
      app.commandLine.appendSwitch("no-sandbox");
    }
  }
}

enableLinuxCapture();
app.setName("Daily Overlay");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (controlWindow) {
      if (controlWindow.isMinimized()) controlWindow.restore();
      controlWindow.show();
      controlWindow.focus();
    }
  });

  app.whenReady().then(() => {
    setupDisplayMedia();
    registerIpc();
    createControlWindow();
    createOverlayWindow();
    createTranslateWindow();
    createTray();
    registerShortcuts();
    startFollowDisplay();
    screen.on("display-added", applyOverlayPlacement);
    screen.on("display-removed", applyOverlayPlacement);
    screen.on("display-metrics-changed", applyOverlayPlacement);
  });
}

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  stopFollowDisplay();
  app.quit();
});

app.on("will-quit", () => {
  quitting = true;
  globalShortcut.unregisterAll();
  stopFollowDisplay();
  linuxCapture.stop();
});

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
});
