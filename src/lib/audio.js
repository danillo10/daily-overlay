export async function getMicrophoneStream({ pickupSpeakers = false } = {}) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: !pickupSpeakers,
      noiseSuppression: !pickupSpeakers,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });
}

export async function getLoopbackStream() {
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: 1,
      width: 16,
      height: 16,
    },
    audio: true,
    preferCurrentTab: false,
  });
}

export function mixStreams(streams) {
  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();
  const sources = [];

  for (const stream of streams) {
    if (!stream.getAudioTracks().length) continue;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(destination);
    sources.push(source);
  }

  return { audioContext, stream: destination.stream, sources };
}

export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

function downsample(buffer, inputRate, outputRate = 16000) {
  if (inputRate === outputRate) return buffer;
  const ratio = inputRate / outputRate;
  const length = Math.round(buffer.length / ratio);
  const result = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), buffer.length);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += buffer[j];
      count += 1;
    }
    result[i] = count ? sum / count : 0;
  }
  return result;
}

export function createPcmCollector(
  stream,
  { intervalMs = 2800, overlapMs = 400, emitSilence = false, onChunk, onLevel },
) {
  const audioContext = new AudioContext();
  if (audioContext.state === "suspended") void audioContext.resume();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const inputRate = audioContext.sampleRate;
  let pending = [];
  let pendingSamples = 0;
  const intervalSamples = Math.round(inputRate * (intervalMs / 1000));
  const overlapSamples = Math.round(inputRate * (overlapMs / 1000));

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    pending.push(new Float32Array(input));
    pendingSamples += input.length;

    if (pendingSamples >= intervalSamples) {
      const merged = new Float32Array(pendingSamples);
      let offset = 0;
      for (const part of pending) {
        merged.set(part, offset);
        offset += part.length;
      }

      const chunk = downsample(merged, inputRate, 16000);
      const level = Math.sqrt(chunk.reduce((sum, value) => sum + value * value, 0) / chunk.length);
      if (typeof onLevel === "function") onLevel(level);
      if (emitSilence || level > 0.004) onChunk(chunk);

      const keepFrom = Math.max(0, merged.length - overlapSamples);
      const overlap = merged.slice(keepFrom);
      pending = [overlap];
      pendingSamples = overlap.length;
    }
  };

  const mute = audioContext.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(audioContext.destination);

  return {
    async close() {
      processor.disconnect();
      source.disconnect();
      mute.disconnect();
      if (audioContext.state !== "closed") await audioContext.close();
    },
  };
}

export function createBlobRecorder(stream, { intervalMs = 4000, onBlob }) {
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  let recorder = null;
  let timer = null;
  let stopped = false;

  const startSlice = () => {
    if (stopped) return;
    recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 1200) onBlob(event.data);
    };
    recorder.start();
    timer = setTimeout(() => {
      if (recorder && recorder.state === "recording") recorder.stop();
      startSlice();
    }, intervalMs);
  };

  startSlice();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (recorder && recorder.state === "recording") recorder.stop();
    },
  };
}

export function floatToWavBlob(float32, sampleRate = 16000) {
  const frames = float32.length;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, frames * 2, true);
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}
