import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPresentationAudio, type PresentationAudio } from "../src/client/presentation-audio";

class FakeParam {
  value = 0;
  setValueAtTime = vi.fn((value: number, _time: number) => this.assign(value));
  linearRampToValueAtTime = vi.fn((value: number, _time: number) => this.assign(value));
  exponentialRampToValueAtTime = vi.fn((value: number, _time: number) => this.assign(value));
  setTargetAtTime = vi.fn((value: number, _time: number, _constant: number) => this.assign(value));

  private assign(value: number): this {
    this.value = value;
    return this;
  }
}

class FakeNode {
  connect = vi.fn((destination: FakeNode) => destination);
  disconnect = vi.fn();
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeFilter extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam();
  Q = new FakeParam();
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}

class FakeDelay extends FakeNode {
  delayTime = new FakeParam();
}

class FakeSource extends FakeNode {
  type = "sine";
  frequency = new FakeParam();
  detune = new FakeParam();
  buffer: unknown = null;
  onended: (() => void) | null = null;
  start = vi.fn((_time?: number) => undefined);
  stop = vi.fn((_time?: number) => undefined);
}

type FakeOptions = {
  resume?: (context: FakeContext) => Promise<void>;
  close?: () => Promise<void>;
  failure?: "delay" | "source-connect";
};

class FakeContext {
  readonly destination = new FakeNode();
  readonly sampleRate = 8000;
  readonly nodes: FakeNode[] = [];
  readonly sources: FakeSource[] = [];
  state: AudioContextState = "suspended";
  private readonly createdAt = Date.now();

  constructor(private readonly options: FakeOptions) {}

  get currentTime(): number {
    return (Date.now() - this.createdAt) / 1000;
  }

  resume = vi.fn(() => {
    if (this.options.resume) return this.options.resume(this);
    this.state = "running";
    return Promise.resolve();
  });

  close = vi.fn(() => {
    this.state = "closed";
    return this.options.close?.() ?? Promise.resolve();
  });

  createGain = vi.fn(() => this.track(new FakeGain()));
  createBiquadFilter = vi.fn(() => this.track(new FakeFilter()));
  createDynamicsCompressor = vi.fn(() => this.track(new FakeCompressor()));
  createDelay = vi.fn((_maximum?: number) => {
    if (this.options.failure === "delay") throw new Error("Delay creation failed");
    return this.track(new FakeDelay());
  });

  createBuffer = vi.fn((channels: number, length: number, _sampleRate: number) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: vi.fn((channel: number) => data[channel]!) };
  });

  createBufferSource = vi.fn(() => this.createSource());
  createOscillator = vi.fn(() => this.createSource());

  private track<T extends FakeNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  private createSource(): FakeSource {
    const source = this.track(new FakeSource());
    this.sources.push(source);
    if (this.options.failure === "source-connect") {
      source.connect.mockImplementation(() => { throw new Error("Source connection failed"); });
    }
    return source;
  }
}

let contexts: FakeContext[];
let controllers: PresentationAudio[];

function installAudio(options: FakeOptions = {}) {
  class Context extends FakeContext {
    constructor() {
      super(options);
      contexts.push(this);
    }
  }
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("webkitAudioContext", undefined);
  return Context;
}

function createController(): PresentationAudio {
  const controller = createPresentationAudio();
  controllers.push(controller);
  return controller;
}

function masterGain(context: FakeContext): FakeParam {
  const output = context.nodes.find((node): node is FakeGain =>
    node instanceof FakeGain && node.connect.mock.calls.some(([target]) => target === context.destination));
  expect(output).toBeDefined();
  if (!output) throw new Error("No gain connected to the output");
  return output.gain;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  contexts = [];
  controllers = [];
  installAudio();
});

afterEach(async () => {
  try {
    for (const controller of controllers) controller.stop();
    await Promise.resolve();
  } finally {
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("createPresentationAudio", () => {
  it("stays lazy through configuration, cues, and repeated stops before start", () => {
    const controller = createController();
    controller.setVolume(0.7);
    controller.setMuted(true);
    controller.cue(1);
    controller.stop();
    controller.stop();
    controller.cue(2);
    expect(contexts).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares concurrent startup and keeps one scheduling loop advancing with the audio clock", async () => {
    const resume = deferred();
    installAudio({ resume: async (context) => {
      await resume.promise;
      context.state = "running";
    } });
    const controller = createController();
    const first = controller.start();
    const outcome = expect(first).resolves.toBeUndefined();
    expect(controller.start()).toBe(first);
    expect(contexts).toHaveLength(1);
    const context = contexts[0]!;
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(context.sources).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    resume.resolve();
    await outcome;
    expect(context.sources.length).toBeGreaterThan(0);
    expect(context.sources.every((source) => source.start.mock.calls.length > 0)).toBe(true);
    const initialSources = context.sources.length;
    const latestStart = Math.max(...context.sources.flatMap((source) =>
      source.start.mock.calls.map(([time]) => time ?? 0)));
    expect(vi.getTimerCount()).toBe(1);
    await controller.start();
    expect(contexts).toHaveLength(1);
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(context.sources).toHaveLength(initialSources);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(context.currentTime).toBeGreaterThan(0);
    const laterSources = context.sources.slice(initialSources);
    expect(laterSources.length).toBeGreaterThan(0);
    expect(laterSources.some((source) => source.start.mock.calls.some(([time]) =>
      time !== undefined && Number.isFinite(time) && time > latestStart))).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops and disconnects scheduled audio, cancels the loop, and contains a rejected close", async () => {
    installAudio({ close: () => Promise.reject(new Error("Close failed")) });
    const controller = createController();
    await controller.start();
    await vi.advanceTimersByTimeAsync(1000);
    const context = contexts[0]!;
    const sources = [...context.sources];
    const nodes = [...context.nodes];
    expect(sources.length).toBeGreaterThan(0);
    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(context.close).toHaveBeenCalledTimes(1);
    for (const source of sources) {
      expect(source.stop.mock.calls.some(([time]) => time === undefined)).toBe(true);
      expect(source.onended).toBeNull();
    }
    for (const node of nodes) expect(node.disconnect).toHaveBeenCalled();
    controller.stop();
    controller.cue(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.sources).toHaveLength(sources.length);
    expect(contexts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("ignores late resume completion after stop with replacement active: %s", async (replacement) => {
    const resume = deferred();
    installAudio({ resume: async (context) => {
      if (context === contexts[0]) await resume.promise;
      if (context.state !== "closed") context.state = "running";
    } });
    const controller = createController();
    const pending = controller.start();
    const outcome = expect(pending).resolves.toBeUndefined();
    const stoppedContext = contexts[0]!;
    controller.stop();
    expect(stoppedContext.close).toHaveBeenCalledTimes(1);
    expect(stoppedContext.sources).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    if (replacement) await controller.start();
    const activeContext = replacement ? contexts[1]! : undefined;
    const activeSources = activeContext?.sources.length;
    resume.resolve();
    await outcome;
    expect(stoppedContext.sources).toHaveLength(0);
    expect(stoppedContext.close).toHaveBeenCalledTimes(1);
    expect(stoppedContext.nodes.every((node) => node.disconnect.mock.calls.length > 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(replacement ? 1 : 0);
    if (activeContext) {
      expect(activeSources).toBeGreaterThan(0);
      expect(activeContext.sources).toHaveLength(activeSources!);
      expect(activeContext.close).not.toHaveBeenCalled();
      await controller.start();
      expect(contexts).toHaveLength(2);
      expect(activeContext.resume).toHaveBeenCalledTimes(1);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(stoppedContext.sources).toHaveLength(0);
    if (activeContext) expect(activeContext.sources.length).toBeGreaterThan(activeSources!);
    expect(vi.getTimerCount()).toBe(replacement ? 1 : 0);
  });

  it("rejects unsupported audio without timers and can subsequently use the webkit constructor", async () => {
    const Constructor = installAudio();
    vi.stubGlobal("AudioContext", undefined);
    const controller = createController();
    await expect(controller.start()).rejects.toThrow();
    expect(contexts).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.stubGlobal("webkitAudioContext", Constructor);
    await controller.start();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.resume).toHaveBeenCalledTimes(1);
    expect(contexts[0]!.sources.length).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(["reject", "throw"] as const)("cleans up when resume fails by %s and permits a fresh start", async (failure) => {
    installAudio({ resume: () => {
      const error = new Error("Resume failed");
      if (failure === "throw") throw error;
      return Promise.reject(error);
    } });
    const controller = createController();
    await expect(controller.start()).rejects.toThrow();
    const failedContext = contexts[0]!;
    expect(failedContext.close).toHaveBeenCalledTimes(1);
    expect(failedContext.nodes.length).toBeGreaterThan(0);
    expect(failedContext.nodes.every((node) => node.disconnect.mock.calls.length > 0)).toBe(true);
    expect(failedContext.sources).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
    expect(failedContext.close).toHaveBeenCalledTimes(1);
    installAudio();
    await controller.start();
    expect(contexts).toHaveLength(2);
    expect(contexts[1]!.sources.length).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(["delay", "source-connect"] as const)("releases the connected graph after partial audio setup failure at %s", async (failure) => {
    installAudio({ failure });
    const controller = createController();
    await expect(controller.start()).rejects.toThrow();
    const context = contexts[0]!;
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.state).toBe("closed");
    expect(context.nodes.length).toBeGreaterThan(0);
    const connected = context.nodes.filter((node) => node.connect.mock.results.some((result) => result.type === "return"));
    expect(connected.length).toBeGreaterThan(0);
    for (const node of connected) expect(node.disconnect).toHaveBeenCalled();
    expect(context.sources.every((source) => source.start.mock.calls.length === 0)).toBe(true);
    const createdSources = context.sources.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(context.sources).toHaveLength(createdSources);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("preserves prestart mute and keeps the configured output monotonic, bounded, and finite", async () => {
    const controller = createController();
    controller.setVolume(0.6);
    controller.setMuted(true);
    await controller.start();
    const gain = masterGain(contexts[0]!);
    expect(gain.value).toBe(0);
    controller.setMuted(false);
    const configured = gain.value;
    expect(configured).toBeGreaterThan(0);
    controller.setVolume(1);
    const maximum = gain.value;
    expect(maximum).toBeGreaterThanOrEqual(configured);
    expect(maximum).toBeLessThanOrEqual(1);
    const levels = [0, 0.2, 0.6, 1].map((volume) => {
      controller.setVolume(volume);
      expect(Number.isFinite(gain.value)).toBe(true);
      expect(gain.value).toBeGreaterThanOrEqual(0);
      expect(gain.value).toBeLessThanOrEqual(maximum);
      return gain.value;
    });
    expect(levels[0]).toBe(0);
    expect(levels[1]).toBeGreaterThan(levels[0]!);
    expect(levels[2]).toBeGreaterThan(levels[1]!);
    expect(levels[3]).toBeGreaterThan(levels[2]!);
    controller.setVolume(-10);
    expect(gain.value).toBe(0);
    controller.setVolume(10);
    expect(gain.value).toBe(maximum);
    controller.setVolume(0.6);
    for (const value of [NaN, Infinity, -Infinity]) {
      controller.setVolume(value);
      expect(gain.value).toBe(configured);
    }
    controller.setMuted(true);
    expect(gain.value).toBe(0);
    controller.setVolume(0.2);
    expect(gain.value).toBe(0);
    controller.setMuted(false);
    expect(gain.value).toBe(levels[1]);
    controller.setMuted(true);
    controller.stop();
    await controller.start();
    const restartedGain = masterGain(contexts[1]!);
    expect(restartedGain.value).toBe(0);
    controller.setMuted(false);
    expect(restartedGain.value).toBe(levels[1]);
    expect(contexts[0]!.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("only cues active playback and reuses its context and scheduling loop", async () => {
    const controller = createController();
    controller.cue(1);
    expect(contexts).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await controller.start();
    const context = contexts[0]!;
    const initialSources = context.sources.length;
    for (const rank of [NaN, Infinity, -Infinity]) controller.cue(rank);
    expect(context.sources).toHaveLength(initialSources);
    controller.cue(1);
    expect(context.sources.length).toBeGreaterThan(initialSources);
    expect(context.sources.slice(initialSources).every((source) => source.start.mock.calls.length > 0)).toBe(true);
    expect(contexts).toHaveLength(1);
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    const beforeCue = context.sources.length;
    controller.cue(3);
    expect(context.sources.length).toBeGreaterThan(beforeCue);
    expect(vi.getTimerCount()).toBe(1);
    controller.stop();
    const stoppedSources = context.sources.length;
    controller.cue(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(context.sources).toHaveLength(stoppedSources);
    expect(contexts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
