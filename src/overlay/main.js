import { speakerHue } from "../lib/speakers.js";

const live = document.getElementById("live");
const time = document.getElementById("time");
const whoEl = document.getElementById("who");
const finalEl = document.getElementById("final");
const partialEl = document.getElementById("partial");
const stage = document.querySelector(".stage");

function formatClock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function currentSpeaker({ linesSpeakers, partialSpeaker }) {
  return partialSpeaker || linesSpeakers?.at(-1) || "";
}

function paintWho(name) {
  whoEl.textContent = name || "";
  whoEl.style.color = name ? `hsl(${speakerHue(name)} 72% 68%)` : "";
}

function render(_payload) {
  // Legenda do overlay desligada por enquanto — teste só com áudio da IA.
  // const last = _payload.lines?.at(-1) || "";
  // const hasText = Boolean(last || _payload.partial);
  // stage.dataset.active = _payload.running || hasText ? "true" : "false";
  // live.dataset.on = _payload.running ? "true" : "false";
  // live.textContent = _payload.running ? "ao vivo" : "aguardando";
  // time.textContent = formatClock(_payload.elapsed);
  // paintWho(currentSpeaker(_payload));
  // finalEl.textContent = _payload.partial || last;
  // partialEl.textContent = _payload.partial && last && _payload.partial !== last ? last : "";
  if (stage) stage.dataset.active = "false";
}

window.daily.onTranscript((payload) => {
  render(payload);
});

window.daily.onStatus((_payload) => {
  // Legenda desligada por enquanto.
  // live.dataset.on = _payload.running ? "true" : "false";
  // live.textContent = _payload.running ? "ao vivo" : "aguardando";
  // time.textContent = formatClock(_payload.elapsed);
  // if (_payload.running) stage.dataset.active = "true";
});
