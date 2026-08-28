const { spawn, execFileSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

const SAMPLE_RATE = 16000;
const CHANNELS = 2;
const HOP_SECONDS = 0.25;
const BYTES_PER_FRAME = CHANNELS * 2;
const HOP_BYTES = SAMPLE_RATE * BYTES_PER_FRAME * HOP_SECONDS;
const NODE_NAME = "daily-overlay-loopback";

const BIN = {
  record: "/usr/bin/pw-record",
  link: "/usr/bin/pw-link",
  dump: "/usr/bin/pw-dump",
};

function hasBin(file) {
  return fs.existsSync(file);
}

function run(file, args) {
  return execFileSync(file, args, { encoding: "utf8" });
}

const AUTO_KINDS = ["discord-voice", "teams", "meet", "zoom", "slack"];
const KIND_RANK = {
  "discord-voice": 0,
  teams: 1,
  meet: 2,
  zoom: 3,
  slack: 4,
  youtube: 5,
  browser: 6,
  app: 7,
  "discord-media": 8,
};

function pipewireGraph() {
  return JSON.parse(run(BIN.dump, []));
}

function classifySource(binary, mediaName, appName, nodeName) {
  const hay = `${binary} ${appName} ${mediaName} ${nodeName}`.toLowerCase();
  if (/discord/.test(hay) && /playstream|voiceengine/.test(hay)) {
    return { kind: "discord-voice", preferred: true, hint: "voz da call", app: "Discord" };
  }
  if (/discord/.test(hay)) {
    return { kind: "discord-media", preferred: false, hint: "UI/mídia", app: "Discord" };
  }
  if (/teams-for-linux|ms-teams|\bteams\b|microsoft teams|teams\.microsoft/.test(hay)) {
    return { kind: "teams", preferred: true, hint: "reunião", app: "Teams" };
  }
  if (/\bzoom\b/.test(hay)) {
    return { kind: "zoom", preferred: true, hint: "reunião", app: "Zoom" };
  }
  if (/\bslack\b/.test(hay)) {
    return { kind: "slack", preferred: true, hint: "huddle", app: "Slack" };
  }
  if (/meet\.google|google meet|\bmeet -|\bmeet$/.test(hay)) {
    return { kind: "meet", preferred: true, hint: "reunião", app: "Google Meet" };
  }
  if (/youtube|youtu\.be/.test(hay)) {
    return { kind: "youtube", preferred: false, hint: "vídeo", app: "YouTube" };
  }
  if (/chrome|chromium|firefox|brave|msedge|vivaldi|opera/.test(hay)) {
    return { kind: "browser", preferred: false, hint: "aba do navegador", app: prettyBrowser(binary, appName) };
  }
  return {
    kind: "app",
    preferred: false,
    hint: "app",
    app: binary || appName || "App",
  };
}

function prettyBrowser(binary, appName) {
  const hay = `${binary} ${appName}`.toLowerCase();
  if (/firefox/.test(hay)) return "Firefox";
  if (/brave/.test(hay)) return "Brave";
  if (/msedge|edge/.test(hay)) return "Edge";
  if (/vivaldi/.test(hay)) return "Vivaldi";
  if (/opera/.test(hay)) return "Opera";
  return "Chrome";
}

function sourceKey(kind, binary, mediaName) {
  return `${kind}|${binary}|${mediaName}`;
}

function pickSource(sources, requestedId, requestedKey) {
  if (requestedId) {
    const byId = sources.find((item) => Number(item.id) === Number(requestedId));
    if (byId) return byId;
  }
  if (requestedKey) {
    return sources.find((item) => item.key === requestedKey) || null;
  }
  for (const kind of AUTO_KINDS) {
    const hit = sources.find((item) => item.kind === kind);
    if (hit) return hit;
  }
  return sources.find((item) => item.kind !== "discord-media") || sources[0] || null;
}

function listPlaybackSources() {
  const dump = pipewireGraph();
  const nodes = [];
  for (const object of dump) {
    if (object.type !== "PipeWire:Interface:Node") continue;
    const props = object.info?.props || {};
    if (props["media.class"] !== "Stream/Output/Audio") continue;
    if (props["node.name"] === NODE_NAME) continue;
    const binary = String(props["application.process.binary"] || "");
    const mediaName = String(props["media.name"] || "");
    const appName = String(props["application.name"] || "");
    const nodeName = String(props["node.name"] || "");
    const classified = classifySource(binary, mediaName, appName, nodeName);
    const streamName = mediaName || nodeName || appName || binary || "áudio";
    nodes.push({
      id: object.id,
      binary: binary || appName || nodeName,
      mediaName: streamName,
      key: sourceKey(classified.kind, binary || appName || nodeName, streamName),
      label: `${classified.app} · ${streamName}`,
      preferred: classified.preferred,
      kind: classified.kind,
      hint: classified.hint,
      app: classified.app,
    });
  }
  nodes.sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || a.label.localeCompare(b.label));
  return nodes;
}

function outputPortIds(nodeId) {
  const dump = pipewireGraph();
  const ids = [];
  for (const object of dump) {
    if (object.type !== "PipeWire:Interface:Port") continue;
    const props = object.info?.props || {};
    if (Number(props["node.id"]) !== Number(nodeId)) continue;
    if (props["port.direction"] !== "out") continue;
    if (!String(props["port.name"] || "").startsWith("output_")) continue;
    ids.push({
      id: object.id,
      name: props["port.name"],
      channel: String(props["port.name"]).endsWith("FR") ? "FR" : "FL",
    });
  }
  return ids;
}

function recorderInputPorts() {
  const dump = pipewireGraph();
  const node = dump.find((object) => {
    if (object.type !== "PipeWire:Interface:Node") return false;
    return object.info?.props?.["node.name"] === NODE_NAME;
  });
  if (!node) return [];
  const ports = [];
  for (const object of dump) {
    if (object.type !== "PipeWire:Interface:Port") continue;
    const props = object.info?.props || {};
    if (Number(props["node.id"]) !== Number(node.id)) continue;
    if (props["port.direction"] !== "in") continue;
    ports.push({
      id: object.id,
      name: props["port.name"],
      channel: String(props["port.name"]).endsWith("FR") ? "FR" : "FL",
    });
  }
  return ports;
}

function pruneForeignLinks(overlayNodeId, allowedOutputNodeId) {
  const dump = pipewireGraph();
  for (const object of dump) {
    if (object.type !== "PipeWire:Interface:Link") continue;
    const props = object.info?.props || {};
    if (Number(props["link.input.node"]) !== Number(overlayNodeId)) continue;
    if (Number(props["link.output.node"]) === Number(allowedOutputNodeId)) continue;
    try {
      execFileSync(BIN.link, ["-d", String(object.id)], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
}

function overlayNodeId() {
  const dump = pipewireGraph();
  const node = dump.find((object) => {
    if (object.type !== "PipeWire:Interface:Node") return false;
    return object.info?.props?.["node.name"] === NODE_NAME;
  });
  return node?.id ?? null;
}

function linkPorts(fromId, toId) {
  try {
    execFileSync(BIN.link, [String(fromId), String(toId)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function s16StereoToMonoFloat32(buf) {
  const copy = Buffer.from(buf);
  const samples = new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
  const frames = Math.floor(samples.length / 2);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    mono[i] = (samples[i * 2] + samples[i * 2 + 1]) / 2 / 32768;
  }
  return mono;
}

function rms(float32) {
  if (!float32.length) return 0;
  let sum = 0;
  for (let i = 0; i < float32.length; i += 1) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

class LinuxSystemCapture extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.pending = Buffer.alloc(0);
    this.source = null;
    this.linked = 0;
    this.relinkTimer = null;
    this.requestedId = null;
    this.requestedKey = null;
  }

  get available() {
    return hasBin(BIN.record) && hasBin(BIN.link) && hasBin(BIN.dump);
  }

  start(sourceId) {
    if (this.child) this.stop();
    if (!this.available) {
      throw new Error("PipeWire não encontrado (/usr/bin/pw-record).");
    }

    const request = sourceId == null ? "" : String(sourceId).trim();
    this.requestedId = /^\d+$/.test(request) ? Number(request) : null;
    this.requestedKey = this.requestedId || !request ? null : request;
    const sources = listPlaybackSources();
    this.source = pickSource(sources, this.requestedId, this.requestedKey);
    if (!this.source) {
      throw new Error(
        this.requestedKey
          ? "Esse canal não está tocando agora. Abre o app (Discord, Teams, Meet, YouTube…) e escolhe de novo."
          : "Nenhum app tocando áudio. Abre Discord, Teams, Meet ou YouTube e escolhe em Canal de áudio.",
      );
    }

    this.pending = Buffer.alloc(0);
    this.linked = 0;
    this.child = spawn(
      BIN.record,
      [
        "-P",
        `node.name=${NODE_NAME} node.autoconnect=false`,
        "--target",
        "0",
        "--rate",
        String(SAMPLE_RATE),
        "--channels",
        String(CHANNELS),
        "--format",
        "s16",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.emit("stderr", text);
    });
    this.child.on("exit", (code) => {
      if (this.child) this.emit("exit", code);
    });

    this.#linkAll();
    this.relinkTimer = setInterval(() => this.#linkAll(), 3000);
    return { sinkName: this.source.label, source: this.source };
  }

  #linkAll() {
    if (!this.child) return;
    const sources = listPlaybackSources();
    const next = pickSource(sources, this.requestedId, this.requestedKey);
    if (next) this.source = next;
    if (!this.source) return;
    const overlayId = overlayNodeId();
    const outputs = outputPortIds(this.source.id);
    const inputs = recorderInputPorts();
    if (overlayId) pruneForeignLinks(overlayId, this.source.id);
    if (!outputs.length || !inputs.length) {
      this.linked = 0;
      this.emit("status", {
        sinkName: this.source.label,
        linked: 0,
        source: this.source,
      });
      return;
    }

    for (const output of outputs) {
      const input = inputs.find((port) => port.channel === output.channel) || inputs[0];
      linkPorts(output.id, input.id);
    }

    this.linked = outputs.length;
    this.emit("status", {
      sinkName: this.source.label,
      linked: this.linked,
      source: this.source,
    });
  }

  #onData(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= HOP_BYTES) {
      const slice = this.pending.subarray(0, HOP_BYTES);
      this.pending = this.pending.subarray(HOP_BYTES);
      const pcm = s16StereoToMonoFloat32(slice);
      const level = rms(pcm);
      this.emit("chunk", {
        samples: Array.from(pcm),
        rms: level,
        sinkName: this.source?.label,
        linked: this.linked,
      });
    }
  }

  stop() {
    if (this.relinkTimer) {
      clearInterval(this.relinkTimer);
      this.relinkTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.pending = Buffer.alloc(0);
    this.linked = 0;
    this.source = null;
    if (!child) return;
    child.stdout.destroy();
    child.kill("SIGINT");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 400);
  }
}

module.exports = { LinuxSystemCapture, listPlaybackSources };
