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
const { LinuxSystemCapture, listPlaybackSources } = require("./linux-audio");

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
    height: 720,
    minWidth: 380,
    minHeight: 560,
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
  return "en";
}

function cleanFreeTranslation(text) {
  return String(text || "")
    .replace(/^MYMEMORY WARNING:[^\n.]*[. ]*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function translateFree(source, language) {
  const from = sourceLang(language);
  if (from === "pt") return source;
  const chunk = source.slice(0, 480);
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${from}|pt-BR`;
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

  ipcMain.handle("transcribe:cloud", async (_event, payload) => {
    const { buffer, mime, apiKey, provider, language } = payload;
    const endpoint =
      provider === "openai"
        ? "https://api.openai.com/v1/audio/transcriptions"
        : "https://api.groq.com/openai/v1/audio/transcriptions";
    const model = provider === "openai" ? "whisper-1" : "whisper-large-v3";
    const lang = String(language || "pt-BR").startsWith("pt")
      ? "pt"
      : String(language).startsWith("es")
        ? "es"
        : "en";

    const fileName = (mime || "").includes("wav") ? "chunk.wav" : "chunk.webm";
    const file = new Blob([buffer], { type: mime || "audio/webm" });
    const body = new FormData();
    body.append("file", file, fileName);
    body.append("model", model);
    body.append("language", lang);
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
    const { text, apiKey, provider, engine, language } = payload;
    const source = String(text || "").trim();
    if (!source) return "";
    if (engine !== "cloud") {
      return translateFree(source, language);
    }
    const useOpenAI = provider === "openai" || String(apiKey || "").startsWith("sk-");
    const endpoint = useOpenAI
      ? "https://api.openai.com/v1/chat/completions"
      : "https://api.groq.com/openai/v1/chat/completions";
    const models = useOpenAI ? ["gpt-4.1-nano", "gpt-4o-mini"] : ["llama-3.1-8b-instant"];
    const bodyFor = (model) =>
      JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 180,
        messages: [
          {
            role: "system",
            content:
              "Traduza para português brasileiro. Responda só com a tradução, sem aspas e sem explicação.",
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
