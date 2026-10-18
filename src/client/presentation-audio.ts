export interface PresentationAudio {
  start(): Promise<void>;
  setVolume(value: number): void;
  setMuted(muted: boolean): void;
  stop(): void;
  cue(rank: number): void;
}

type Voice = { sources: Set<AudioScheduledSourceNode>; nodes: AudioNode[] };
type Session = {
  context: AudioContext;
  nodes: Set<AudioNode>;
  voices: Set<Voice>;
  master: GainNode;
  bus: GainNode;
  send: GainNode;
  noise: AudioBuffer;
  timer: ReturnType<typeof setInterval> | null;
  ready: boolean;
  disposed: boolean;
  nextTime: number;
  step: number;
  lastCue: number;
  closing: Promise<void> | null;
};

const BEAT = 60 / 96;
const STEP = BEAT / 4;
const PROGRESSION = [
  { root: 41, notes: [57, 60, 64, 67] },
  { root: 45, notes: [55, 60, 64, 69] },
  { root: 38, notes: [53, 57, 60, 64] },
  { root: 46, notes: [57, 60, 62, 65] },
  { root: 43, notes: [57, 58, 62, 65] },
  { root: 36, notes: [58, 62, 64, 69] },
  { root: 41, notes: [57, 60, 64, 67] },
  { root: 36, notes: [58, 62, 65, 69] },
  { root: 38, notes: [57, 60, 64, 65] },
  { root: 45, notes: [55, 60, 64, 67] },
  { root: 46, notes: [57, 60, 62, 65] },
  { root: 36, notes: [58, 62, 64, 69] },
  { root: 41, notes: [57, 60, 64, 67] },
  { root: 38, notes: [57, 60, 64, 65] },
  { root: 43, notes: [57, 58, 62, 65] },
  { root: 36, notes: [58, 62, 64, 69] },
] as const;

type MelodyNote = readonly [step: number, midi: number, length: number];
const MELODIES: readonly (readonly MelodyNote[])[] = [
  [[2, 72, 2], [5, 76, 2], [10, 79, 3]],
  [[1, 76, 3], [7, 72, 2], [12, 71, 2]],
  [[2, 69, 3], [8, 72, 2], [11, 76, 3]],
  [[0, 74, 3], [6, 72, 2], [10, 69, 4]],
  [[3, 70, 2], [6, 74, 3], [12, 77, 2]],
  [[2, 76, 3], [8, 74, 2], [11, 72, 3]],
  [[0, 69, 3], [5, 72, 2], [9, 67, 4]],
  [[2, 70, 2], [6, 69, 2], [10, 67, 3]],
];

const frequency = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

function disconnect(node: AudioNode): void {
  try { node.disconnect(); } catch { }
}

function dispose(session: Session): void {
  if (session.disposed) return;
  session.disposed = true;
  session.ready = false;
  if (session.timer !== null) clearInterval(session.timer);
  session.timer = null;
  for (const voice of session.voices) {
    for (const source of voice.sources) {
      source.onended = null;
      try { source.stop(); } catch { }
    }
    for (const node of voice.nodes) disconnect(node);
    voice.sources.clear();
  }
  session.voices.clear();
  for (const node of session.nodes) disconnect(node);
  session.nodes.clear();
  try {
    session.closing = session.context.close().catch(() => undefined);
  } catch {
    session.closing = Promise.resolve();
  }
}

function voice(session: Session): Voice {
  const result: Voice = { sources: new Set(), nodes: [] };
  session.voices.add(result);
  return result;
}

function node<T extends AudioNode>(part: Voice, value: T): T {
  part.nodes.push(value);
  return value;
}

function playSource(session: Session, part: Voice, source: AudioScheduledSourceNode, start: number, end: number): void {
  part.sources.add(source);
  part.nodes.push(source);
  source.onended = () => {
    source.onended = null;
    part.sources.delete(source);
    disconnect(source);
    if (!part.sources.size) {
      for (const value of part.nodes) disconnect(value);
      part.nodes.length = 0;
      session.voices.delete(part);
    }
  };
  source.start(start);
  source.stop(end);
}

function envelope(gain: AudioParam, time: number, peak: number, attack: number, hold: number, release: number): number {
  gain.setValueAtTime(0, time);
  gain.linearRampToValueAtTime(peak, time + attack);
  gain.linearRampToValueAtTime(peak * 0.65, time + attack + hold);
  gain.linearRampToValueAtTime(0, time + attack + hold + release);
  return time + attack + hold + release + 0.015;
}

function pad(session: Session, notes: readonly number[], time: number, quiet: boolean): void {
  const { context } = session;
  const part = voice(session);
  const filter = node(part, context.createBiquadFilter());
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(quiet ? 1050 : 1450, time);
  filter.Q.value = 0.45;
  const gain = node(part, context.createGain());
  const end = envelope(gain.gain, time, quiet ? 0.052 : 0.065, 0.22, BEAT * 2.65, 0.48);
  filter.connect(gain);
  gain.connect(session.bus);
  for (const [index, midi] of notes.entries()) {
    const oscillator = context.createOscillator();
    oscillator.type = index % 2 ? "sine" : "triangle";
    oscillator.frequency.value = frequency(midi);
    oscillator.detune.value = index % 2 ? 4 : -4;
    oscillator.connect(filter);
    playSource(session, part, oscillator, time, end);
  }
}

function bass(session: Session, midi: number, time: number, length: number, soft = false): void {
  const { context } = session;
  const part = voice(session);
  const filter = node(part, context.createBiquadFilter());
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(620, time);
  filter.frequency.exponentialRampToValueAtTime(210, time + 0.18);
  const gain = node(part, context.createGain());
  const end = envelope(gain.gain, time, soft ? 0.105 : 0.15, 0.014, length, 0.12);
  const oscillator = context.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.value = frequency(midi);
  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(session.bus);
  playSource(session, part, oscillator, time, end);
}

function bell(session: Session, midi: number, time: number, length: number, level: number): void {
  const { context } = session;
  const part = voice(session);
  const gain = node(part, context.createGain());
  const end = envelope(gain.gain, time, level, 0.012, length, 0.34);
  gain.connect(session.bus);
  gain.connect(session.send);
  const fundamental = context.createOscillator();
  fundamental.type = "sine";
  fundamental.frequency.value = frequency(midi);
  fundamental.connect(gain);
  const overtoneGain = node(part, context.createGain());
  overtoneGain.gain.value = 0.16;
  overtoneGain.connect(gain);
  const overtone = context.createOscillator();
  overtone.type = "sine";
  overtone.frequency.value = frequency(midi + 12);
  overtone.connect(overtoneGain);
  playSource(session, part, fundamental, time, end);
  playSource(session, part, overtone, time, end);
}

function kick(session: Session, time: number, soft: boolean): void {
  const { context } = session;
  const part = voice(session);
  const gain = node(part, context.createGain());
  const end = envelope(gain.gain, time, soft ? 0.17 : 0.24, 0.005, 0.015, 0.21);
  const oscillator = context.createOscillator();
  oscillator.frequency.setValueAtTime(125, time);
  oscillator.frequency.exponentialRampToValueAtTime(47, time + 0.14);
  oscillator.connect(gain);
  gain.connect(session.bus);
  playSource(session, part, oscillator, time, end);
}

function percussion(session: Session, time: number, snare: boolean, open: boolean, level: number): void {
  const { context } = session;
  const part = voice(session);
  const filter = node(part, context.createBiquadFilter());
  filter.type = snare ? "bandpass" : "highpass";
  filter.frequency.value = snare ? 1750 : 6900;
  filter.Q.value = snare ? 0.65 : 0.5;
  const gain = node(part, context.createGain());
  const end = envelope(gain.gain, time, level, 0.003, 0.008, snare ? 0.13 : open ? 0.11 : 0.035);
  const source = context.createBufferSource();
  source.buffer = session.noise;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(session.bus);
  playSource(session, part, source, time, end);
  if (snare) bass(session, 50, time, 0.015, true);
}

function arrange(session: Session, step: number, time: number): void {
  const bar = Math.floor(step / 16);
  const position = step % 16;
  const chord = PROGRESSION[bar]!;
  const intro = bar < 2;
  const airy = bar === 8 || bar === 9;
  if (position === 0) pad(session, chord.notes, time, intro || airy);
  const bassSteps = intro ? [0, 10] : [0, 6, 10, 14];
  if (bassSteps.includes(position)) {
    const pitch = chord.root + (position === 10 ? 7 : position === 14 && bar % 2 === 1 ? 12 : 0);
    bass(session, pitch, time, BEAT * (position === 0 ? 0.6 : 0.3), intro || airy);
  }
  if (position === 0 || (!airy && position === 8) || (!intro && !airy && bar % 2 === 1 && position === 14)) {
    kick(session, time, intro || airy);
  }
  if (!intro && !airy && (position === 4 || position === 12)) percussion(session, time, true, false, 0.075);
  if ((!intro || bar === 1) && position % 2 === 0 && (!airy || position % 4 === 2)) {
    percussion(session, time + (position % 4 === 2 ? 0.017 : 0), false, position === 14, position % 4 === 0 ? 0.025 : 0.018);
  }
  if (bar === 0 || bar === 8) return;
  const phrase = MELODIES[bar % 8]!;
  for (const [onset, midi, length] of phrase) {
    if (position !== onset || (bar === 1 && onset < 7)) continue;
    const variation = bar >= 12 && onset === phrase[0]![0] ? 12 : 0;
    bell(session, midi + variation, time, length * STEP * 0.65, airy ? 0.043 : 0.057);
  }
}

function schedule(session: Session): void {
  if (session.disposed || !session.ready || session.context.state !== "running") return;
  const now = session.context.currentTime;
  if (session.nextTime < now - 0.25) {
    const skipped = Math.ceil((now + 0.025 - session.nextTime) / STEP);
    session.step = (session.step + skipped) % 256;
    session.nextTime += skipped * STEP;
  }
  let count = 0;
  while (session.nextTime < now + 0.2 && count < 4) {
    arrange(session, session.step, Math.max(session.nextTime, now + 0.005));
    session.nextTime += STEP;
    session.step = (session.step + 1) % 256;
    count += 1;
  }
}

export function createPresentationAudio(): PresentationAudio {
  let current: Session | null = null;
  let pending: Promise<void> | null = null;
  let volume = 0.28;
  let muted = false;

  function updateGain(): void {
    if (!current || current.disposed) return;
    current.master.gain.setTargetAtTime(muted ? 0 : volume * 0.65, current.context.currentTime, 0.035);
  }

  function start(): Promise<void> {
    if (pending) return pending;
    if (current?.ready) return Promise.resolve();
    let context: AudioContext | null = null;
    let session: Session;
    const nodes = new Set<AudioNode>();
    try {
      const Constructor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) throw new Error("Web Audio is not supported in this browser.");
      context = new Constructor();
      const track = <T extends AudioNode>(value: T): T => { nodes.add(value); return value; };
      const master = track(context.createGain());
      master.gain.value = 0;
      const bus = track(context.createGain());
      const highpass = track(context.createBiquadFilter());
      highpass.type = "highpass";
      highpass.frequency.value = 28;
      const lowpass = track(context.createBiquadFilter());
      lowpass.type = "lowpass";
      lowpass.frequency.value = 8500;
      const compressor = track(context.createDynamicsCompressor());
      compressor.threshold.value = -18;
      compressor.knee.value = 18;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.012;
      compressor.release.value = 0.22;
      bus.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(compressor);
      compressor.connect(master);
      master.connect(context.destination);
      const send = track(context.createGain());
      send.gain.value = 0.23;
      const delay = track(context.createDelay(1));
      delay.delayTime.value = BEAT * 0.75;
      const tone = track(context.createBiquadFilter());
      tone.type = "lowpass";
      tone.frequency.value = 2600;
      const feedback = track(context.createGain());
      feedback.gain.value = 0.23;
      send.connect(delay);
      delay.connect(tone);
      tone.connect(bus);
      tone.connect(feedback);
      feedback.connect(delay);
      const noise = context.createBuffer(1, Math.ceil(context.sampleRate), context.sampleRate);
      const data = noise.getChannelData(0);
      let seed = 17391;
      for (let index = 0; index < data.length; index += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        data[index] = seed / 2147483648 - 1;
      }
      session = { context, nodes, voices: new Set(), master, bus, send, noise, timer: null, ready: false,
        disposed: false, nextTime: 0, step: 0, lastCue: -Infinity, closing: null };
      current = session;
    } catch (error) {
      for (const value of nodes) disconnect(value);
      const failure = error instanceof Error ? error : new Error("Unable to initialize presentation audio.");
      if (context) {
        try {
          return context.close().catch(() => undefined).then(() => { throw failure; });
        } catch { }
      }
      return Promise.reject(failure);
    }

    let resumed: Promise<void>;
    try { resumed = session.context.resume(); } catch (error) { resumed = Promise.reject(error); }
    const task = resumed.then(() => {
      if (current !== session || session.disposed) return;
      if (session.context.state !== "running") throw new Error("The browser did not allow audio playback.");
      session.ready = true;
      session.nextTime = session.context.currentTime + 0.04;
      updateGain();
      schedule(session);
      session.timer = setInterval(() => {
        try { schedule(session); } catch {
          if (current === session) { current = null; pending = null; }
          dispose(session);
        }
      }, 100);
    }).catch(async (error: unknown) => {
      if (current === session) current = null;
      dispose(session);
      await session.closing;
      throw new Error("Unable to start presentation audio.", { cause: error });
    }).finally(() => {
      if (pending === task) pending = null;
    });
    pending = task;
    return task;
  }

  return {
    start,
    setVolume(value) {
      if (!Number.isFinite(value)) return;
      volume = Math.min(1, Math.max(0, value));
      updateGain();
    },
    setMuted(value) { muted = value; updateGain(); },
    stop() {
      const session = current;
      current = null;
      pending = null;
      if (session) dispose(session);
    },
    cue(rank) {
      const session = current;
      if (!session?.ready || session.disposed || session.context.state !== "running" || !Number.isFinite(rank)) return;
      const now = session.context.currentTime;
      if (now - session.lastCue < 0.8) return;
      session.lastCue = now;
      const bar = Math.floor(((session.step + 255) % 256) / 16);
      const notes = PROGRESSION[bar]!.notes;
      const accent = rank === 1 ? [0, 1, 2, 3] : [0, 2, 3];
      for (const [index, degree] of accent.entries()) {
        bell(session, notes[degree]! + 12, now + 0.015 + index * STEP * 0.5, 0.2, 0.07);
      }
    },
  };
}
