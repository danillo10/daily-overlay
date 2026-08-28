const live = document.getElementById("live");
const time = document.getElementById("time");
const finalEl = document.getElementById("final");
const partialEl = document.getElementById("partial");
const stage = document.querySelector(".stage");

function formatClock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function render({ running, elapsed, lines, partial }) {
  const last = lines?.at(-1) || "";
  const hasText = Boolean(last || partial);
  stage.dataset.active = running || hasText ? "true" : "false";
  live.dataset.on = running ? "true" : "false";
  live.textContent = running ? "ao vivo" : "aguardando";
  time.textContent = formatClock(elapsed);
  finalEl.textContent = partial || last;
  partialEl.textContent = partial && last && partial !== last ? last : "";
}

window.daily.onTranscript((payload) => {
  render(payload);
});

window.daily.onStatus((payload) => {
  live.dataset.on = payload.running ? "true" : "false";
  live.textContent = payload.running ? "ao vivo" : "aguardando";
  time.textContent = formatClock(payload.elapsed);
  if (payload.running) stage.dataset.active = "true";
});
