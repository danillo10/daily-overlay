const NAMES = [
  "Nico",
  "Luma",
  "Kai",
  "Bia",
  "Theo",
  "Nalu",
  "Ari",
  "Sol",
  "Davi",
  "Kim",
  "Gabi",
  "Zoe",
  "Lana",
  "Ivo",
  "Maya",
  "Milo",
  "Cris",
  "Nanda",
  "Gui",
  "Pri",
  "Mel",
  "Caio",
  "Nina",
  "Leo",
];

const BANDS = 16;
const MAX_SPEAKERS = 8;

function rms(pcm) {
  if (!pcm?.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

function loudestWindow(pcm, size = 2048) {
  if (!pcm?.length) return pcm;
  if (pcm.length <= size) return pcm;
  let best = 0;
  let bestAt = 0;
  let acc = 0;
  for (let i = 0; i < size; i += 1) acc += pcm[i] * pcm[i];
  best = acc;
  for (let i = size; i < pcm.length; i += 1) {
    acc += pcm[i] * pcm[i] - pcm[i - size] * pcm[i - size];
    if (acc > best) {
      best = acc;
      bestAt = i - size + 1;
    }
  }
  return pcm.subarray(bestAt, bestAt + size);
}

function estimatePitch(pcm, sampleRate = 16000) {
  const minLag = Math.round(sampleRate / 380);
  const maxLag = Math.round(sampleRate / 70);
  let bestLag = 0;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    const n = pcm.length - lag;
    for (let i = 0; i < n; i += 2) sum += pcm[i] * pcm[i + lag];
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  if (!bestLag || best < 0.01) return 0;
  return sampleRate / bestLag;
}

function goertzel(pcm, freq, sampleRate = 16000) {
  const n = pcm.length;
  const k = Math.round((freq * n) / sampleRate);
  const w = (Math.PI * 2 * k) / n;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    s0 = pcm[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.log1p(Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)));
}

function bandVector(pcm) {
  const n = pcm.length;
  const vec = new Float64Array(BANDS + 2);
  for (let b = 0; b < BANDS; b += 1) {
    const freq = 90 * 1.28 ** b;
    vec[b] = goertzel(pcm, Math.min(3800, freq));
  }
  let zcr = 0;
  for (let i = 1; i < n; i += 1) {
    if (pcm[i - 1] >= 0 !== pcm[i] >= 0) zcr += 1;
  }
  vec[BANDS] = zcr / n;
  let centroidNum = 0;
  let centroidDen = 0;
  for (let b = 0; b < BANDS; b += 1) {
    centroidNum += (b + 1) * vec[b];
    centroidDen += vec[b];
  }
  vec[BANDS + 1] = centroidDen ? centroidNum / centroidDen / BANDS : 0;
  return vec;
}

function normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const mag = Math.sqrt(sum) || 1;
  const out = new Float64Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / mag;
  return out;
}

function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function pitchScore(a, b) {
  if (!a || !b) return 0.4;
  const diff = Math.abs(a - b);
  return Math.max(0, 1 - diff / 90);
}

function mixScore(spec, pitchA, pitchB) {
  return spec * 0.58 + pitchScore(pitchA, pitchB) * 0.42;
}

function extract(pcm) {
  const window = loudestWindow(pcm, 1536);
  if (rms(window) < 0.006) return null;
  return {
    vec: normalize(bandVector(window)),
    pitch: estimatePitch(window),
  };
}

function blend(target, next, amount) {
  for (let i = 0; i < target.length; i += 1) {
    target[i] = target[i] * (1 - amount) + next[i] * amount;
  }
}

export function speakerHue(name) {
  let hash = 0;
  for (let i = 0; i < String(name || "").length; i += 1) {
    hash = (hash * 33 + name.charCodeAt(i)) % 360;
  }
  return hash;
}

export function createSpeakerRoster() {
  const people = [];
  const taken = new Set();
  let lastName = "";

  function nextName() {
    const pool = NAMES.filter((name) => !taken.has(name));
    const pick = (pool.length ? pool : NAMES)[Math.floor(Math.random() * (pool.length || NAMES.length))];
    taken.add(pick);
    return pick;
  }

  function update(person, feat) {
    blend(person.vec, feat.vec, person.count < 3 ? 0.45 : 0.18);
    if (feat.pitch) {
      person.pitch = person.pitch ? person.pitch * 0.7 + feat.pitch * 0.3 : feat.pitch;
    }
    person.count += 1;
    person.lastAt = Date.now();
  }

  function create(feat) {
    const person = {
      name: nextName(),
      vec: Float64Array.from(feat.vec),
      pitch: feat.pitch || 0,
      count: 1,
      lastAt: Date.now(),
    };
    people.push(person);
    if (people.length > MAX_SPEAKERS) people.shift();
    return person;
  }

  function assign(pcm) {
    const feat = extract(pcm);
    if (!feat) return lastName || "";

    let best = null;
    let bestScore = -1;
    for (const person of people) {
      const score = mixScore(cosine(feat.vec, person.vec), feat.pitch, person.pitch);
      if (score > bestScore) {
        bestScore = score;
        best = person;
      }
    }

    const last = people.find((person) => person.name === lastName);
    const lastScore = last ? mixScore(cosine(feat.vec, last.vec), feat.pitch, last.pitch) : -1;

    if (last && lastScore >= 0.62 && lastScore + 0.05 >= bestScore) {
      update(last, feat);
      lastName = last.name;
      return last.name;
    }

    if (best && bestScore >= 0.7) {
      update(best, feat);
      lastName = best.name;
      return best.name;
    }

    if (best && people.length >= MAX_SPEAKERS) {
      update(best, feat);
      lastName = best.name;
      return best.name;
    }

    const person = create(feat);
    lastName = person.name;
    return person.name;
  }

  function reset() {
    people.length = 0;
    taken.clear();
    lastName = "";
  }

  return {
    assign,
    reset,
    names: () => people.map((person) => person.name),
  };
}
