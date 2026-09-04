const WHISPER_LANG = {
  "pt-BR": "portuguese",
  "en-US": "english",
  "es-ES": "spanish",
  "fr-FR": "french",
  "de-DE": "german",
  "it-IT": "italian",
  "ja-JP": "japanese",
};

let transcriberPromise = null;

async function loadTransformers() {
  let transformers;
  try {
    transformers = await import("@xenova/transformers");
  } catch {
    transformers = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
  }
  transformers.env.allowLocalModels = false;
  transformers.env.useBrowserCache = true;
  transformers.env.backends.onnx.wasm.numThreads = Math.min(2, navigator.hardwareConcurrency || 2);
  transformers.env.backends.onnx.wasm.wasmPaths =
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/";
  return transformers;
}

export function whisperSupported() {
  return typeof WebAssembly !== "undefined";
}

export async function loadWhisper(onProgress) {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline } = await loadTransformers();
      return pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", {
        quantized: true,
        progress_callback: (data) => {
          if (typeof onProgress === "function") onProgress(data);
        },
      });
    })().catch((error) => {
      transcriberPromise = null;
      throw error;
    });
  }
  return transcriberPromise;
}

export async function transcribeLocal(float32, language, onProgress) {
  const transcriber = await loadWhisper(onProgress);
  const options = {
    task: "transcribe",
    condition_on_previous_text: false,
    no_speech_threshold: 0.4,
  };
  if (language && language !== "auto") {
    options.language = WHISPER_LANG[language] || null;
  }
  const result = await transcriber(float32, options);
  return String(result?.text || "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function transcribeCloud(blob, { apiKey, provider, language, detectLanguage, sttModel }) {
  const buffer = await blob.arrayBuffer();
  return window.daily.transcribeCloud({
    buffer,
    mime: blob.type || "audio/webm",
    apiKey,
    provider,
    language,
    detectLanguage,
    sttModel,
  });
}

export function createSpeechRecognizer({ language, onPartial, onFinal, onError }) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = language;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let partial = "";
    const finals = [];
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript?.trim();
      if (!text) continue;
      if (result.isFinal) finals.push(text);
      else partial += `${text} `;
    }
    if (partial.trim()) onPartial(partial.trim());
    for (const text of finals) onFinal(text);
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    if (["network", "not-allowed", "service-not-allowed", "audio-capture"].includes(event.error)) {
      recognition._keepAlive = false;
    }
    onError(event.error);
  };

  recognition.onend = () => {
    if (recognition._keepAlive) {
      try {
        recognition.start();
      } catch {
        /* already started */
      }
    }
  };

  return {
    start() {
      recognition._keepAlive = true;
      recognition.start();
    },
    stop() {
      recognition._keepAlive = false;
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
    },
  };
}
