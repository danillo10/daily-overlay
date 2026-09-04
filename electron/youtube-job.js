const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const dns = require("node:dns");
const { app } = require("electron");

try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  /* older node */
}

const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
const CHUNK_SECONDS = 600;
const MAX_UPLOAD = 24 * 1024 * 1024;

function extractYoutubeId(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const watch = text.match(/[?&]v=([\w-]{11})/);
  if (watch) return watch[1];
  const short = text.match(/youtu\.be\/([\w-]{11})/i);
  if (short) return short[1];
  const pathId = text.match(/youtube\.com\/(?:embed|shorts|live|v)\/([\w-]{11})/i);
  if (pathId) return pathId[1];
  const bare = text.match(/^([\w-]{11})$/);
  return bare ? bare[1] : "";
}

function normalizeYoutubeUrl(raw) {
  const id = extractYoutubeId(raw);
  return id ? `https://www.youtube.com/watch?v=${id}` : "";
}

function binDir() {
  const dir = path.join(app.getPath("userData"), "bin");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function which(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function resolveFfmpeg() {
  try {
    const packed = require("ffmpeg-static");
    if (packed && fs.existsSync(packed)) return packed;
  } catch {
    /* optional */
  }
  return which("ffmpeg");
}

function ytdlpPath() {
  return path.join(binDir(), "yt-dlp");
}

async function downloadFile(url, dest) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Falha ao baixar ferramenta (${response.status})`);
  const data = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
  fs.chmodSync(dest, 0o755);
}

async function ensureYtdlp(onProgress) {
  const dest = ytdlpPath();
  if (fs.existsSync(dest)) return dest;
  const fromPath = which("yt-dlp");
  if (fromPath) return fromPath;
  onProgress?.("Baixando yt-dlp (primeira vez)…");
  await downloadFile(YTDLP_URL, dest);
  return dest;
}

function run(file, args, { onLog } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      onLog?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      onLog?.(text);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `comando falhou (${code})`).slice(-400)));
    });
  });
}

function srtTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function toSrt(cues) {
  return cues
    .map((cue, index) => {
      const lines = [cue.pt, cue.en].filter(Boolean).join("\n");
      return `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${lines}\n`;
    })
    .join("\n");
}

function targetLabel(language) {
  const value = String(language || "pt-BR");
  if (value.startsWith("pt")) return "português";
  if (value.startsWith("es")) return "espanhol";
  if (value.startsWith("fr")) return "francês";
  if (value.startsWith("de")) return "alemão";
  if (value.startsWith("it")) return "italiano";
  if (value.startsWith("ja")) return "japonês";
  if (value.startsWith("en")) return "inglês";
  return "português";
}

function ffmpegSubPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function nodeBin() {
  const exec = String(process.execPath || "");
  if (exec && !/electron/i.test(path.basename(exec))) return exec;
  return which("node") || process.env.npm_node_execpath || "";
}

function ytdlpBaseArgs(ffmpeg) {
  const args = ["--no-playlist", "--newline"];
  const node = nodeBin();
  if (node) args.push("--js-runtimes", `node:${node}`);
  if (ffmpeg) args.push("--ffmpeg-location", ffmpeg);
  args.push("--extractor-args", "youtube:player_client=android,default");
  return args;
}

async function fetchRetry(url, options, { tries = 3, label = "API" } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      last = error;
      const timeout = error?.cause?.code === "UND_ERR_CONNECT_TIMEOUT" || /fetch failed|timeout/i.test(String(error.message));
      if (!timeout || attempt === tries) break;
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
    }
  }
  const cause = last?.cause?.code || last?.message || "";
  throw new Error(`${label} não respondeu (timeout de rede). Confere a internet e tenta de novo. ${cause}`);
}

function probeMedia(ffmpeg, filePath) {
  try {
    execFileSync(ffmpeg, ["-hide_banner", "-i", filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { video: false, audio: false };
  } catch (error) {
    const text = String(error.stderr || "");
    return {
      video: /Stream #.+Video:/i.test(text),
      audio: /Stream #.+Audio:/i.test(text),
    };
  }
}

function findCompanionVideo(ffmpeg, dir, videoPath) {
  const skip = new Set([
    path.basename(videoPath).toLowerCase(),
  ]);
  const names = fs.readdirSync(dir).filter((name) => {
    const lower = name.toLowerCase();
    if (skip.has(lower)) return false;
    if (/legendado|dublado|merged/.test(lower)) return false;
    return /\.(mp4|mkv|webm|mov)$/i.test(name);
  });
  for (const name of names) {
    const full = path.join(dir, name);
    if (probeMedia(ffmpeg, full).video) return full;
  }
  return "";
}

async function ensureVideoFile(ffmpeg, videoPath, dir, onProgress) {
  if (probeMedia(ffmpeg, videoPath).video) return videoPath;
  const companion = findCompanionVideo(ffmpeg, dir, videoPath);
  if (!companion) {
    throw new Error("O YouTube veio sem imagem (só áudio). Tenta de novo; se repetir, o yt-dlp precisa atualizar.");
  }
  onProgress?.("Juntando vídeo e áudio…");
  const merged = path.join(dir, `${path.basename(videoPath, path.extname(videoPath))}.merged.mp4`);
  const hasAudio = probeMedia(ffmpeg, videoPath).audio;
  const args = ["-y", "-i", companion];
  if (hasAudio) {
    args.push("-i", videoPath, "-map", "0:v:0", "-map", "1:a:0");
  } else {
    args.push("-map", "0:v:0");
  }
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "160k", "-shortest", merged);
  await run(ffmpeg, args);
  const backup = `${videoPath}.audio`;
  if (fs.existsSync(videoPath)) fs.renameSync(videoPath, backup);
  fs.renameSync(merged, videoPath);
  return videoPath;
}

async function transcribeVerbose(filePath, { apiKey, provider, sttModel, onProgress }) {
  const endpoint =
    provider === "openai"
      ? "https://api.openai.com/v1/audio/transcriptions"
      : "https://api.groq.com/openai/v1/audio/transcriptions";
  const preferred =
    provider === "openai" && sttModel === "gpt-4o-transcribe"
      ? "gpt-4o-transcribe"
      : provider === "openai" && sttModel === "gpt-4o-mini-transcribe"
        ? "gpt-4o-mini-transcribe"
        : provider === "openai"
          ? "whisper-1"
          : "whisper-large-v3";
  const models =
    provider === "openai" && preferred !== "whisper-1" ? [preferred, "whisper-1"] : [preferred];

  let lastError = "";
  for (const model of models) {
    if (model !== preferred) onProgress?.("Esse modelo não devolve tempo da fala; usando whisper-1…");
    const buffer = fs.readFileSync(filePath);
    const blob = new Blob([buffer], { type: "audio/mpeg" });
    const body = new FormData();
    body.append("file", blob, path.basename(filePath));
    body.append("model", model);
    body.append("response_format", "verbose_json");
    const response = await fetchRetry(
      endpoint,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
      },
      { tries: 3, label: "Whisper" }
    );
    if (!response.ok) {
      lastError = await response.text();
      continue;
    }
    const json = await response.json();
    const segments = (json.segments || []).map((segment) => ({
      start: Number(segment.start) || 0,
      end: Number(segment.end) || 0,
      text: String(segment.text || "").replace(/\s+/g, " ").trim(),
    }));
    if (segments.length) return segments;
    lastError = "sem segmentos";
  }
  throw new Error(`Whisper no vídeo falhou: ${String(lastError).slice(0, 180)}`);
}

async function splitAudio(ffmpeg, audioPath, workDir) {
  const size = fs.statSync(audioPath).size;
  if (size <= MAX_UPLOAD) return [{ path: audioPath, offset: 0 }];
  const parts = [];
  let index = 0;
  for (let offset = 0; ; index += 1, offset += CHUNK_SECONDS) {
    const part = path.join(workDir, `chunk-${index}.mp3`);
    await run(ffmpeg, [
      "-y",
      "-i",
      audioPath,
      "-ss",
      String(offset),
      "-t",
      String(CHUNK_SECONDS),
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      part,
    ]);
    if (!fs.existsSync(part) || fs.statSync(part).size < 2000) {
      if (fs.existsSync(part)) fs.unlinkSync(part);
      break;
    }
    parts.push({ path: part, offset });
  }
  return parts.length ? parts : [{ path: audioPath, offset: 0 }];
}

function mergeCuesForDub(cues, maxGap = 0.4, maxChars = 240) {
  const out = [];
  for (const cue of cues) {
    const line = String(cue.pt || "").trim();
    if (!line) continue;
    const last = out[out.length - 1];
    if (last && cue.start - last.end <= maxGap && `${last.pt} ${line}`.length <= maxChars) {
      last.pt = `${last.pt} ${line}`.replace(/\s+/g, " ").trim();
      last.end = Math.max(last.end, cue.end);
    } else {
      out.push({ start: cue.start, end: cue.end, pt: line });
    }
  }
  return out;
}

function mediaDuration(ffmpeg, filePath) {
  try {
    execFileSync(ffmpeg, ["-hide_banner", "-i", filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return 0;
  } catch (error) {
    const text = String(error.stderr || "");
    const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return 0;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
}

function duckPcm(buffer, gain) {
  const out = Buffer.from(buffer);
  for (let i = 0; i + 1 < out.length; i += 2) {
    out.writeInt16LE(Math.round(out.readInt16LE(i) * gain), i);
  }
  return out;
}

function mixPcm(master, clip, startSec, sampleRate) {
  const offset = Math.max(0, Math.round(startSec * sampleRate));
  for (let i = 0; i + 1 < clip.length; i += 2) {
    const dest = (offset + i / 2) * 2;
    if (dest + 1 >= master.length) break;
    const mixed = master.readInt16LE(dest) + clip.readInt16LE(i);
    master.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), dest);
  }
}

async function toPcm(ffmpeg, input, dest) {
  await run(ffmpeg, ["-y", "-i", input, "-ac", "1", "-ar", "24000", "-f", "s16le", dest]);
}

async function silentPcm(ffmpeg, dest, seconds) {
  await run(ffmpeg, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=24000:cl=mono",
    "-t",
    String(Math.max(0.2, seconds)),
    "-f",
    "s16le",
    dest,
  ]);
}

async function dubVideo(ffmpeg, { videoPath, clips, workDir, outputPath, onProgress }) {
  const duration = mediaDuration(ffmpeg, videoPath) || clips.at(-1)?.end + 1 || 1;
  const origPcm = path.join(workDir, "orig.s16");
  const mixPcmPath = path.join(workDir, "dub.s16");
  try {
    await toPcm(ffmpeg, videoPath, origPcm);
  } catch {
    await silentPcm(ffmpeg, origPcm, duration);
  }
  const master = duckPcm(fs.readFileSync(origPcm), 0.16);
  const needed = Math.max(master.length, Math.ceil(duration * 24000) * 2);
  const mix = Buffer.alloc(needed);
  master.copy(mix, 0, 0, Math.min(master.length, mix.length));

  for (let i = 0; i < clips.length; i += 1) {
    onProgress?.(`Encaixando voz ${i + 1}/${clips.length}…`);
    const pcmPath = `${clips[i].path}.s16`;
    await toPcm(ffmpeg, clips[i].path, pcmPath);
    mixPcm(mix, fs.readFileSync(pcmPath), clips[i].start, 24000);
    fs.unlinkSync(pcmPath);
  }
  fs.writeFileSync(mixPcmPath, mix);

  const videoSource = probeMedia(ffmpeg, videoPath).video
    ? videoPath
    : findCompanionVideo(ffmpeg, workDir, videoPath);
  if (!videoSource) {
    throw new Error("O arquivo baixado não tem imagem, só áudio. Não deu pra montar o MP4 dublado.");
  }

  await run(ffmpeg, [
    "-y",
    "-i",
    videoSource,
    "-f",
    "s16le",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-i",
    mixPcmPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-shortest",
    outputPath,
  ]);
}

function workFolder(title) {
  const safe = String(title || "youtube")
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "youtube";
  const root = path.join(app.getPath("videos") || os.homedir(), "Daily Overlay");
  const dir = path.join(root, safe);
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir, safe };
}

async function runYoutubeJob({
  url,
  language,
  apiKey,
  provider,
  translateEngine,
  sttModel,
  dubVoice,
  translateText,
  speakText,
  onProgress,
}) {
  const source = normalizeYoutubeUrl(url);
  if (!source) {
    throw new Error("Cola um link do YouTube (youtube.com ou youtu.be). Pode ser sem https.");
  }
  if (!apiKey) {
    throw new Error("Cola a API key do Whisper para transcrever o vídeo.");
  }

  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    throw new Error("FFmpeg não encontrado. Roda npm install e tenta de novo.");
  }
  const ytdlp = await ensureYtdlp(onProgress);

  onProgress?.("Lendo o vídeo…");
  let metaRaw = "";
  try {
    metaRaw = execFileSync(
      ytdlp,
      [...ytdlpBaseArgs(ffmpeg), "--dump-json", "--no-download", source],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    const detail = String(error.stderr || error.message || "").replace(/\s+/g, " ").trim();
    throw new Error(`Não deu pra ler esse YouTube. ${detail.slice(0, 220) || "Tenta outro link."}`);
  }
  const meta = JSON.parse(metaRaw.split("\n").find((line) => line.startsWith("{")) || metaRaw);
  const title = meta.title || meta.id || "youtube";
  const { dir, safe } = workFolder(title);
  const videoPath = path.join(dir, `${safe}.mp4`);
  const audioPath = path.join(dir, `${safe}.mp3`);
  const srtPath = path.join(dir, `${safe}.srt`);
  const outputPath = path.join(dir, `${safe}.legendado.mp4`);
  const dubbedPathReady = path.join(dir, `${safe}.dublado.mp4`);
  if (dubVoice && fs.existsSync(dubbedPathReady) && probeMedia(ffmpeg, dubbedPathReady).video) {
    onProgress?.("Esse vídeo já está dublado.");
    return {
      title,
      folder: dir,
      video: videoPath,
      output: dubbedPathReady,
      captions: outputPath,
      dubbed: dubbedPathReady,
      srt: srtPath,
      lines: [],
      linesPt: [],
      text: "",
    };
  }

  onProgress?.("Baixando o vídeo…");
  const hasGoodVideo = fs.existsSync(videoPath) && probeMedia(ffmpeg, videoPath).video;
  if (!hasGoodVideo) {
    await run(
      ytdlp,
      [
        ...ytdlpBaseArgs(ffmpeg),
        "-f",
        "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
        "--merge-output-format",
        "mp4",
        "-o",
        videoPath,
        source,
      ],
      {
        onLog: (text) => {
          const match = text.match(/(\d{1,3}(?:\.\d+)?)%/);
          if (match) onProgress?.(`Baixando ${match[1]}%`);
        },
      },
    );
  }
  if (!fs.existsSync(videoPath)) {
    const found = fs.readdirSync(dir).find((name) => {
      const lower = name.toLowerCase();
      return /\.(mp4|mkv|webm)$/i.test(name) && !lower.includes("legendado") && !lower.includes("dublado");
    });
    if (!found) throw new Error("O download terminou, mas o arquivo de vídeo não apareceu.");
    fs.renameSync(path.join(dir, found), videoPath);
  }
  await ensureVideoFile(ffmpeg, videoPath, dir, onProgress);

  onProgress?.("Extraindo o áudio…");
  await run(ffmpeg, ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audioPath]);

  onProgress?.("Transcrevendo com Whisper…");
  const parts = await splitAudio(ffmpeg, audioPath, dir);
  const cues = [];
  for (let i = 0; i < parts.length; i += 1) {
    onProgress?.(`Transcrevendo parte ${i + 1}/${parts.length}…`);
    const segments = await transcribeVerbose(parts[i].path, { apiKey, provider, sttModel, onProgress });
    for (const segment of segments) {
      if (!segment.text) continue;
      cues.push({
        start: segment.start + parts[i].offset,
        end: Math.max(segment.end + parts[i].offset, segment.start + parts[i].offset + 0.8),
        en: segment.text,
        pt: "",
      });
    }
  }
  if (!cues.length) throw new Error("O Whisper não achou fala nesse vídeo.");

  onProgress?.(`Traduzindo para ${targetLabel(language)}…`);
  for (let i = 0; i < cues.length; i += 1) {
    if (i % 8 === 0) onProgress?.(`Traduzindo ${i + 1}/${cues.length}…`);
    try {
      cues[i].pt = await translateText(cues[i].en);
    } catch {
      cues[i].pt = cues[i].en;
    }
  }

  const srt = toSrt(cues);
  fs.writeFileSync(srtPath, srt, "utf8");
  fs.writeFileSync(path.join(dir, `${safe}.en.srt`), toSrt(cues.map((cue) => ({ ...cue, pt: "" }))), "utf8");
  fs.writeFileSync(path.join(dir, `${safe}.pt.srt`), toSrt(cues.map((cue) => ({ ...cue, en: "" }))), "utf8");

  onProgress?.("Gravando as legendas no vídeo…");
  await run(ffmpeg, [
    "-y",
    "-i",
    videoPath,
    "-vf",
    `subtitles='${ffmpegSubPath(srtPath)}':force_style='FontName=DejaVu Sans,FontSize=18,Outline=2,Shadow=1,Alignment=2,MarginV=28'`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    outputPath,
  ]);

  let dubbedPath = "";
  if (dubVoice) {
    if (!speakText) {
      onProgress?.("Dublagem precisa de voz OpenAI. Gravei só as legendas.");
    } else {
      const lines = mergeCuesForDub(cues);
      const clips = [];
      for (let i = 0; i < lines.length; i += 1) {
        onProgress?.(`Gerando voz ${i + 1}/${lines.length}…`);
        try {
          const spoken = await speakText(lines[i].pt);
          if (!spoken?.base64) continue;
          const clipPath = path.join(dir, `tts-${String(i).padStart(3, "0")}.mp3`);
          fs.writeFileSync(clipPath, Buffer.from(spoken.base64, "base64"));
          clips.push({ path: clipPath, start: lines[i].start, end: lines[i].end });
        } catch (error) {
          onProgress?.(error.message || `Falha na voz ${i + 1}`);
        }
      }
      if (!clips.length) {
        onProgress?.("Não deu pra gerar a voz. O vídeo legendado está pronto.");
      } else {
        dubbedPath = path.join(dir, `${safe}.dublado.mp4`);
        onProgress?.("Misturando a dublagem no vídeo…");
        await dubVideo(ffmpeg, {
          videoPath,
          clips,
          workDir: dir,
          outputPath: dubbedPath,
          onProgress,
        });
        for (const clip of clips) {
          if (fs.existsSync(clip.path)) fs.unlinkSync(clip.path);
        }
      }
    }
  }

  return {
    title,
    folder: dir,
    video: videoPath,
    output: dubbedPath || outputPath,
    captions: outputPath,
    dubbed: dubbedPath,
    srt: srtPath,
    lines: cues.map((cue) => cue.en),
    linesPt: cues.map((cue) => cue.pt),
    text: cues.map((cue) => `${cue.en}\n→ ${cue.pt}`).join("\n\n"),
  };
}

module.exports = { runYoutubeJob, resolveFfmpeg };
