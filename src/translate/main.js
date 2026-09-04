import { speakerHue } from "../lib/speakers.js";

const live = document.getElementById("live");
const time = document.getElementById("time");
const historyEl = document.getElementById("history");
const drag = document.getElementById("drag");
const closeBtn = document.getElementById("close");

let stickToBottom = true;
let pendingBounds = null;
let boundsRaf = 0;

function formatClock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function render({ running, elapsed, lines, linesPt, linesSpeakers, partial, partialSpeaker, translation }) {
  live.dataset.on = running ? "true" : "false";
  live.textContent = running ? "ao vivo" : "aguardando";
  time.textContent = formatClock(elapsed);

  const rows = [];
  const originals = lines || [];
  const translated = linesPt || [];
  const speakers = linesSpeakers || [];
  for (let i = 0; i < originals.length; i += 1) {
    rows.push({ en: originals[i], pt: translated[i] || "", who: speakers[i] || "" });
  }
  const last = originals.at(-1) || "";
  if (partial && partial !== last) {
    rows.push({ en: partial, pt: translation || "", live: true, who: partialSpeaker || speakers.at(-1) || "" });
  } else if (translation && rows.length) {
    rows[rows.length - 1] = {
      en: rows[rows.length - 1].en,
      pt: translation || rows[rows.length - 1].pt,
      live: Boolean(partial),
      who: rows[rows.length - 1].who || partialSpeaker || "",
    };
  } else if (translation && !rows.length) {
    rows.push({ en: partial || "", pt: translation, live: true, who: partialSpeaker || "" });
  }

  const grouped = [];
  for (const row of rows) {
    const prev = grouped.at(-1);
    if (prev && prev.who && prev.who === row.who) {
      prev.items.push(row);
    } else {
      grouped.push({ who: row.who || "", items: [row] });
    }
  }

  historyEl.innerHTML = "";
  /* Legenda da janela de tradução desligada por enquanto — teste só com áudio.
  historyEl.innerHTML = grouped
    .map(
      (group) => `
        <section class="speaker">
          ${group.who ? `<p class="who" style="color:hsl(${speakerHue(group.who)} 72% 68%)">${escapeHtml(group.who)}</p>` : ""}
          ${group.items
            .map(
              (row) => `
            <article class="line${row.live ? " live" : ""}">
              ${row.en ? `<p class="en">${escapeHtml(row.en)}</p>` : ""}
              ${row.pt ? `<p class="pt">${escapeHtml(row.pt)}</p>` : ""}
            </article>`,
            )
            .join("")}
        </section>`,
    )
    .join("");
  */

  if (stickToBottom) historyEl.scrollTop = historyEl.scrollHeight;
}

historyEl.addEventListener("scroll", () => {
  stickToBottom = historyEl.scrollHeight - historyEl.scrollTop - historyEl.clientHeight < 56;
});

function applyOpacity(opacity) {
  const value = Math.max(0, Math.min(0.9, Number(opacity) || 0));
  document.querySelector(".panel")?.style.setProperty("--bg-alpha", String(value));
}

window.daily.onTranslateOpacity(({ opacity }) => applyOpacity(opacity));
window.daily.getState().then((state) => {
  applyOpacity(state.settings?.translateOpacity);
});
window.daily.onTranscript((payload) => render(payload));
window.daily.onStatus((payload) => {
  live.dataset.on = payload.running ? "true" : "false";
  live.textContent = payload.running ? "ao vivo" : "aguardando";
  time.textContent = formatClock(payload.elapsed);
});

closeBtn.addEventListener("click", () => {
  window.daily.setTranslateVisible(false);
});

const MIN_W = 260;
const MIN_H = 160;

function attachPointerOp(el, kind, edge) {
  el.addEventListener("pointerdown", async (event) => {
    if (kind === "move" && event.target.closest("button")) return;
    event.preventDefault();
    el.setPointerCapture(event.pointerId);
    const start = await window.daily.getWindowBounds();
    const ox = event.screenX;
    const oy = event.screenY;

    const onMove = (ev) => {
      const dx = ev.screenX - ox;
      const dy = ev.screenY - oy;
      const next = { ...start };
      if (kind === "move") {
        next.x = start.x + dx;
        next.y = start.y + dy;
      } else {
        if (edge.includes("e")) next.width = Math.max(MIN_W, start.width + dx);
        if (edge.includes("s")) next.height = Math.max(MIN_H, start.height + dy);
        if (edge.includes("w")) {
          const width = Math.max(MIN_W, start.width - dx);
          next.x = start.x + (start.width - width);
          next.width = width;
        }
        if (edge.includes("n")) {
          const height = Math.max(MIN_H, start.height - dy);
          next.y = start.y + (start.height - height);
          next.height = height;
        }
      }
      pendingBounds = next;
      if (!boundsRaf) {
        boundsRaf = requestAnimationFrame(() => {
          boundsRaf = 0;
          if (pendingBounds) window.daily.setWindowBounds(pendingBounds);
        });
      }
    };

    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  });
}

attachPointerOp(drag, "move");
for (const el of document.querySelectorAll("[data-edge]")) {
  attachPointerOp(el, "resize", el.dataset.edge);
}
