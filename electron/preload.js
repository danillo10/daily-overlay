const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("daily", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  setOverlayVisible: (visible) => ipcRenderer.invoke("overlay:set-visible", visible),
  setClickThrough: (enabled) => ipcRenderer.invoke("overlay:set-click-through", enabled),
  setFollowDisplay: (enabled) => ipcRenderer.invoke("overlay:set-follow-display", enabled),
  setDisplay: (displayId) => ipcRenderer.invoke("overlay:set-display", displayId),
  setHideFromCapture: (enabled) => ipcRenderer.invoke("overlay:set-hide-from-capture", enabled),
  setTranslateVisible: (visible) => ipcRenderer.invoke("translate:set-visible", visible),
  setTranslateOpacity: (opacity) => ipcRenderer.invoke("translate:set-opacity", opacity),
  getWindowBounds: () => ipcRenderer.invoke("window:get-bounds"),
  setWindowBounds: (bounds) => ipcRenderer.invoke("window:set-bounds", bounds),
  listDisplays: () => ipcRenderer.invoke("overlay:list-displays"),
  writeClipboard: (text) => ipcRenderer.invoke("clipboard:write", text),
  listSources: () => ipcRenderer.invoke("desktop:sources"),
  transcribeCloud: (payload) => ipcRenderer.invoke("transcribe:cloud", payload),
  translateText: (payload) => ipcRenderer.invoke("translate:text", payload),
  linuxAudioAvailable: () => ipcRenderer.invoke("linux-audio:available"),
  listLinuxAudioSources: () => ipcRenderer.invoke("linux-audio:sources"),
  startLinuxAudio: (sourceId) => ipcRenderer.invoke("linux-audio:start", sourceId),
  stopLinuxAudio: () => ipcRenderer.invoke("linux-audio:stop"),
  onLinuxAudioChunk: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("linux-audio:chunk", listener);
    return () => ipcRenderer.removeListener("linux-audio:chunk", listener);
  },
  onLinuxAudioStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("linux-audio:status", listener);
    return () => ipcRenderer.removeListener("linux-audio:status", listener);
  },
  onLinuxAudioError: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on("linux-audio:error", listener);
    return () => ipcRenderer.removeListener("linux-audio:error", listener);
  },
  sendTranscript: (payload) => ipcRenderer.send("transcript:update", payload),
  sendStatus: (payload) => ipcRenderer.send("session:status", payload),
  onTranscript: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("transcript:update", listener);
    return () => ipcRenderer.removeListener("transcript:update", listener);
  },
  onStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("session:status", listener);
    return () => ipcRenderer.removeListener("session:status", listener);
  },
  onHotkeyToggle: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("hotkey:toggle-listen", listener);
    return () => ipcRenderer.removeListener("hotkey:toggle-listen", listener);
  },
  onOverlayVisibility: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("overlay:visibility", listener);
    return () => ipcRenderer.removeListener("overlay:visibility", listener);
  },
  onClickThrough: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("overlay:click-through", listener);
    return () => ipcRenderer.removeListener("overlay:click-through", listener);
  },
  onTranslateVisibility: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("translate:visibility", listener);
    return () => ipcRenderer.removeListener("translate:visibility", listener);
  },
  onTranslateOpacity: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("translate:opacity", listener);
    return () => ipcRenderer.removeListener("translate:opacity", listener);
  },
});
