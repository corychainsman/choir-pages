import createSpeechEngines from "/speech-synthesis-tests/web/choir-speech-engines.js";
import { SPEECH_ENGINE_REGISTRY, SPEECH_ENGINE_NUMERIC_IDS } from "/speech-synthesis-tests/web/engine-registry.mjs";

const ENGINE_IDS = SPEECH_ENGINE_NUMERIC_IDS;
const SAMPLE_RATE = 24000;
const MAX_BLOCK = 512;
const CONSONANT_ON = 0;
const EXPRESSION_PARAM_IDS = Object.freeze({
  vibratoDepthCents: 17,
  vibratoRateHz: 18,
  reverbMix: 19,
  reverbDecaySeconds: 20,
});
const HIDDEN_EXPRESSION_PARAM_IDS = new Set([1, 2, 10, 17, 18, 19, 20]);
const EXPRESSION_DEFAULTS = Object.freeze({
  vibratoDepthCents: 0,
  vibratoRateHz: 5,
  timingStdDevMs: 0,
  reverbMix: 0,
  reverbDecaySeconds: 1.2,
});

function normalizeExpression(value = {}) {
  value ||= {};
  const number = (key) => Number.isFinite(Number(value[key])) ? Number(value[key]) : EXPRESSION_DEFAULTS[key];
  return {
    vibratoDepthCents: Math.max(0, Math.min(100, number("vibratoDepthCents"))),
    vibratoRateHz: Math.max(0, Math.min(12, number("vibratoRateHz"))),
    timingStdDevMs: Math.max(0, Math.min(1000, number("timingStdDevMs"))),
    reverbMix: Math.max(0, Math.min(1, number("reverbMix"))),
    reverbDecaySeconds: Math.max(0.1, Math.min(5, number("reverbDecaySeconds"))),
  };
}

function stableHash(text) {
  let hash = 0x811c9dc5;
  for (const character of String(text)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

class SpeechEngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.module = null;
    this.rebuildGeneration = 0;
    this.rebuilding = false;
    this.pendingCommands = [];
    this.moduleError = "";
    this.handle = null;
    this.engineId = "vocalwriter";
    this.songId = "";
    this.expression = normalizeExpression(EXPRESSION_DEFAULTS);
    this.positionMs = 0;
    this.totalDurationMs = 0;
    this.musicDurationMs = 0;
    this.tempo = 1;
    this.playing = false;
    this.playbackIntent = false;
    this.lanes = [];
    this.parts = [];
    this.cues = [];
    this.voiceConfig = [];
    this.scratchPointer = 0;
    this.lastSnapshot = 0;
    this.outputRms = 0;
    this.outputPeak = 0;
    this.clipRatio = 0;
    this.engineError = false;
    this.snapshotData = { type: "snapshot", positionMs: 0, durationMs: 0, playing: false, outputRms: 0, outputPeak: 0, clipRatio: 0 };
    this.port.onmessage = (event) => this.onCommand(event.data || {});
    this.initialize();
  }

  async initialize() {
    try {
      this.module = await createSpeechEngines();
      this.scratchPointer = this.module._malloc(MAX_BLOCK * Float32Array.BYTES_PER_ELEMENT);
      this.port.postMessage({ type: "ready", engines: this.readEngineInfo(), engineId: this.engineId });
      const pending = this.pendingCommands;
      this.pendingCommands = [];
      for (const command of pending) this.onCommand(command);
      if (!pending.length) this.rebuildLanes();
    } catch (error) {
      this.playing = false;
      this.moduleError = error?.message || "Speech engine module could not be initialized.";
      this.port.postMessage({ type: "error", message: this.moduleError });
      this.snapshot();
    }
  }

  readEngineInfo() {
    return SPEECH_ENGINE_REGISTRY.map(({ id, numericId }) => {
      const pointer = this.module._speech_engine_info(numericId);
      try { return JSON.parse(this.module.UTF8ToString(pointer)); }
      catch { return { id, name: id, available: false, realtime: false, reason: "Engine metadata is invalid." }; }
    });
  }

  selectEngine(engineId) {
    const selected = Number.isInteger(engineId) ? SPEECH_ENGINE_REGISTRY[engineId]?.id : engineId;
    if (!selected || ENGINE_IDS[selected] === undefined) return false;
    this.engineId = selected;
    return true;
  }

  onCommand(message) {
    if (!this.module) {
      this.pendingCommands.push(message);
      return;
    }
    switch (message.type) {
      case "load":
        this.engineError = false;
        if (message.engineId !== undefined && !this.selectEngine(message.engineId)) {
          this.port.postMessage({ type: "error", message: `Unknown speech engine ID: ${message.engineId}` });
          break;
        }
        this.parts = message.parts || [];
        this.songId = String(message.songId || "");
        this.expression = normalizeExpression({ ...EXPRESSION_DEFAULTS, ...(message.expression || message.voices?.[0]?.expression) });
        this.cues = message.cues || [];
        this.cuesById = new Map(this.cues.map((cue) => [cue.id, cue]));
        this.voiceConfig = this.normalizeVoiceConfig(message.voices);
        this.updateDuration();
        this.positionMs = 0;
        // A score replacement follows the user's current transport intent.
        // `pause` received while async lanes are being prepared clears this
        // flag and wins; `play` received during preparation sets it.
        this.rebuildLanes();
        this.snapshot();
        break;
      case "engine":
        if (!this.selectEngine(message.engineId)) {
          this.playing = false;
          this.destroyLanes();
          const info = { id: String(message.engineId), available: false, realtime: false, reason: "Unknown engine ID." };
          this.port.postMessage({ type: "engine-status", engineId: info.id, info });
          this.snapshot();
          break;
        }
        this.rebuildLanes(true);
        this.port.postMessage({ type: "engine-selection", engineId: this.engineId });
        break;
      case "voices": {
        const previous = this.voiceConfig;
        this.voiceConfig = this.normalizeVoiceConfig(message.voices);
        this.rebuildLanes(true, false, previous);
        break;
      }
      case "param":
        this.setParameter(message.singer, message.id, message.value);
        break;
      case "expression":
        this.updateExpression(message.expression);
        break;
      case "tempo":
        this.tempo = Math.max(0.25, Math.min(2, Number(message.value) / 100));
        for (const lane of this.lanes) this.applyTransportTempo(lane);
        this.updateLaneTiming();
        break;
      case "play":
        this.playbackIntent = true;
        this.playing = true;
        this.snapshot();
        break;
      case "pause":
        this.playbackIntent = false;
        this.playing = false;
        this.snapshot();
        break;
      case "seek":
        this.positionMs = Math.max(0, Math.min(this.durationMs(), Number(message.positionMs) || 0));
        this.rebuildLanes();
        this.snapshot();
        break;
    }
  }

  durationMs() {
    return this.totalDurationMs;
  }

  normalizeVoiceConfig(configs) {
    return this.parts.map((_part, partIndex) => {
      const config = configs?.[partIndex] || {};
      return {
        enabled: config.enabled !== false,
        partIndex,
        params: config.params || {},
        expression: normalizeExpression({ ...this.expression, ...config.expression }),
      };
    });
  }

  laneSeed(part, partIndex, singer) {
    const sourceIndex = Number.isInteger(part?.index) ? part.index : partIndex;
    return stableHash(`${this.songId}\u001f${sourceIndex}\u001f${part?.name || ""}\u001f${singer}`);
  }

  scheduledNotes(module, part, partIndex, cuePlan, config) {
    const sourceNotes = part.notes || [];
    const notes = sourceNotes.map((note) => ({ ...note }));
    const deviation = config.expression?.timingStdDevMs || 0;
    if (!deviation || notes.length === 0) return notes;
    if (typeof module._speech_timing_apply_events !== "function") {
      throw new Error("This speech module does not include native timing variation.");
    }
    const bufferBytes = notes.length * 12;
    const pointer = module._malloc(bufferBytes);
    if (!pointer) throw new Error("Could not allocate native timing events.");
    try {
      const memory = new DataView(module.HEAPF32.buffer);
      for (let index = 0; index < notes.length; index += 1) {
        const note = notes[index];
        const at = pointer + index * 12;
        memory.setUint32(at, Math.max(0, Math.round(note.startMs * SAMPLE_RATE / 1000)), true);
        memory.setUint32(at + 4, Math.max(1, Math.round((note.endMs - note.startMs) * SAMPLE_RATE / 1000)), true);
        memory.setUint16(at + 8, cuePlan.sourceToLocal.get(note.cueId) || 0, true);
        memory.setUint8(at + 10, note.note);
        memory.setUint8(at + 11, note.velocity || 92);
      }
      const sourceIndex = Number.isInteger(part?.index) ? part.index : partIndex;
      const restQuantumSamples = this.engineId === "vocalwriter" ? 50 : 1;
      const result = module._speech_timing_apply_events(
        pointer,
        notes.length,
        stableHash(this.songId),
        sourceIndex,
        deviation,
        this.tempo,
        restQuantumSamples,
      );
      if (result < 0) throw new Error(`Native timing variation rejected part ${sourceIndex} (${result}).`);
      for (let index = 0; index < notes.length; index += 1) {
        const at = pointer + index * 12;
        const startSample = memory.getUint32(at, true);
        const durationSamples = memory.getUint32(at + 4, true);
        notes[index].startMs = startSample * 1000 / SAMPLE_RATE;
        notes[index].endMs = (startSample + durationSamples) * 1000 / SAMPLE_RATE;
      }
      return notes;
    } finally {
      module._free(pointer);
    }
  }

  applyLaneExpression(lane) {
    for (const [key, id] of Object.entries(EXPRESSION_PARAM_IDS)) {
      const result = lane.module._speech_engine_set_param(lane.handle, id, lane.config.expression[key]);
      if (result < 0) return result;
    }
    return 0;
  }

  setLaneSeed(lane, partIndex) {
    if (typeof lane.module._speech_engine_set_seed !== "function") return -1;
    lane.seed = this.laneSeed(lane.part, partIndex, lane.singer);
    return lane.module._speech_engine_set_seed(lane.handle, lane.seed);
  }

  updateExpression(value) {
    const expression = normalizeExpression({ ...EXPRESSION_DEFAULTS, ...value });
    const wasRebuilding = this.rebuilding;
    const timingChanged = this.voiceConfig.some((config) => config.expression?.timingStdDevMs !== expression.timingStdDevMs);
    this.expression = expression;
    this.voiceConfig = this.voiceConfig.map((config) => ({ ...config, expression }));
    for (const lane of this.lanes) {
      if (!lane) continue;
      lane.config.expression = expression;
      const result = this.applyLaneExpression(lane);
      if (result < 0) this.failEngineCall("set shared expression", result, lane.singer);
    }
    if (wasRebuilding) {
      this.rebuildLanes(true);
      return;
    }
    if (timingChanged) this.updateLaneTiming();
  }

  updateLaneTiming() {
    const position = this.positionMs;
    for (const lane of this.lanes) {
      if (!lane) continue;
      try {
        const transformed = this.scheduledNotes(lane.module, lane.part, lane.config.partIndex, lane.cuePlan, lane.config);
        const prior = lane.scheduleNotes || lane.part.notes;
        let lastScheduledEnd = position;
        lane.scheduleNotes = transformed.map((note, index) => {
          if (prior[index]?.startMs <= position) {
            lastScheduledEnd = Math.max(lastScheduledEnd, prior[index].endMs);
            return prior[index];
          }
          if (note.startMs < lastScheduledEnd) {
            const startMs = Math.max(position, lastScheduledEnd);
            const shiftMs = startMs - note.startMs;
            note.startMs = startMs;
            note.endMs += shiftMs;
          }
          lastScheduledEnd = Math.max(lastScheduledEnd, note.endMs);
          return note;
        });
        if (this.engineInfo?.mode === "sequencer-stream" || this.engineInfo?.capabilities?.includes("sequencer-track")) {
          const loaded = this.loadSequencerTrack(lane, position);
          if (loaded < 0) this.failEngineCall("reschedule native track", loaded, lane.singer);
          continue;
        }
        const priorEvents = lane.events.filter((event) => event.timeMs <= position);
        const futureEvents = this.eventsFor(lane.scheduleNotes, lane.cuePlan.sourceToLocal)
          .filter((event) => event.timeMs > position);
        lane.events = [...priorEvents, ...futureEvents].sort((a, b) => a.timeMs - b.timeMs || (a.type === "off" ? -1 : 1));
        lane.next = lane.events.findIndex((event) => event.timeMs > position);
        if (lane.next < 0) lane.next = lane.events.length;
      } catch (error) {
        this.failEngineCall(error?.message || "reschedule timing", -1, lane.singer);
        return;
      }
    }
    this.updateDurationFromLanes();
  }

  loadSequencerTrack(lane, position = this.positionMs) {
    const notes = lane.scheduleNotes || lane.part.notes || [];
    const eventBytes = new ArrayBuffer(notes.length * 12);
    const view = new DataView(eventBytes);
    for (let index = 0; index < notes.length; index += 1) {
      const note = notes[index];
      const offset = index * 12;
      view.setUint32(offset, Math.max(0, Math.round(note.startMs * SAMPLE_RATE / 1000)), true);
      view.setUint32(offset + 4, Math.max(1, Math.round((note.endMs - note.startMs) * SAMPLE_RATE / 1000)), true);
      view.setUint16(offset + 8, lane.cuePlan.sourceToLocal.get(note.cueId) || 0, true);
      view.setUint8(offset + 10, note.note);
      view.setUint8(offset + 11, note.velocity || 92);
    }
    const eventPointer = lane.module._malloc(eventBytes.byteLength);
    if (!eventPointer) return -1;
    try {
      new Uint8Array(lane.module.HEAPF32.buffer).set(new Uint8Array(eventBytes), eventPointer);
      const loaded = lane.module._speech_engine_load_track(lane.handle, eventPointer, notes.length);
      if (loaded < 0) return loaded;
    } finally {
      lane.module._free(eventPointer);
    }
    return lane.module._speech_engine_seek_sample(lane.handle, Math.max(0, Math.round(position * SAMPLE_RATE / 1000)));
  }

  updateDurationFromLanes() {
    const tailMs = Math.max(0, this.totalDurationMs - this.musicDurationMs);
    let musicDuration = 0;
    let hasSchedule = false;
    for (const lane of this.lanes) {
      if (!lane) continue;
      for (const note of lane.scheduleNotes || lane.part.notes || []) {
        hasSchedule = true;
        musicDuration = Math.max(musicDuration, note.endMs);
      }
    }
    if (!hasSchedule) return;
    this.musicDurationMs = musicDuration;
    this.totalDurationMs = musicDuration + tailMs;
  }

  updateDuration() {
    let musicDuration = 0;
    for (let partIndex = 0; partIndex < this.parts.length; partIndex += 1) {
      const notes = this.parts[partIndex].notes || [];
      for (let noteIndex = 0; noteIndex < notes.length; noteIndex += 1) {
        if (notes[noteIndex].endMs > musicDuration) musicDuration = notes[noteIndex].endMs;
      }
    }
    let tailMs = 0;
    for (let singer = 0; singer < this.voiceConfig.length; singer += 1) {
      const config = this.voiceConfig[singer];
      if (!config?.enabled) continue;
      const part = this.parts[config.partIndex] || this.parts[0];
      const releaseKey = this.engineId === "cook" ? "param_4" : "release_ms";
      const releaseMs = Number(config.params?.[releaseKey] ?? (this.engineId === "gnuspeech" ? 20 : 150));
      for (let noteIndex = 0; noteIndex < part.notes.length; noteIndex += 1) {
        const note = part.notes[noteIndex];
        if (note.endMs !== musicDuration) continue;
        const cue = this.cuesById?.get(note.cueId);
        const bytes = cue?.bytes;
        let codaMs = 0;
        if (bytes) {
          const count = bytes[5];
          const nucleus = bytes[6];
          for (let phone = nucleus + 1; phone < count; phone += 1) {
            const at = 8 + phone * 4;
            codaMs += bytes[at + 2] | (bytes[at + 3] << 8);
          }
        }
        tailMs = Math.max(tailMs, codaMs + Math.max(0, releaseMs));
      }
    }
    this.musicDurationMs = musicDuration;
    this.totalDurationMs = musicDuration + tailMs;
  }

  rebuildLanes(_preservePosition = false, rebuildAll = true, previousConfig = this.voiceConfig) {
    if (!this.module) return;
    const generation = ++this.rebuildGeneration;
    this.engineError = false;
    this.rebuilding = false;
    const position = this.positionMs;
    const engineIndex = ENGINE_IDS[this.engineId];
    const infoPtr = this.module._speech_engine_info(engineIndex);
    let info;
    try { info = JSON.parse(this.module.UTF8ToString(infoPtr)); }
    catch { info = { available: false, realtime: false }; }
    this.engineInfo = info;
    const instanceIsolation = String(info.instanceIsolation || "");
    const needsModulePerVoice = info.modulePerVoice === true ||
      instanceIsolation === "module-per-voice" ||
      /one Emscripten module per (?:independent )?voice/i.test(instanceIsolation);
    const isSequencerStream = info.mode === "sequencer-stream" ||
      info.capabilities?.includes("sequencer-track");
    if (isSequencerStream) {
      void this.rebuildSequencerLanes(info, engineIndex, needsModulePerVoice, generation);
      return;
    }
    if (!info.available || info.realtime === false) {
      this.destroyLanes();
      this.playing = false;
      this.playbackIntent = false;
      this.port.postMessage({ type: "engine-status", engineId: this.engineId, info });
      this.snapshot();
      return;
    }
    const oldLanes = this.lanes.slice();
    const nextLanes = Array(this.voiceConfig.length).fill(null);
    let unsupportedTotal = 0;
    for (let singer = 0; singer < this.voiceConfig.length; singer += 1) {
      const config = this.voiceConfig[singer];
      const previous = previousConfig[singer];
      const oldLane = oldLanes[singer];
      const sameAssignment = oldLane && previous?.enabled === config.enabled && previous?.partIndex === config.partIndex;
      if (!rebuildAll && sameAssignment) {
        nextLanes[singer] = oldLane;
        oldLanes[singer] = null;
        continue;
      }
      if (oldLane?.handle) {
        oldLane.module._speech_engine_destroy(oldLane.handle);
        if (oldLane.ownsScratch && oldLane.scratchPointer) oldLane.module._free(oldLane.scratchPointer);
        oldLanes[singer] = null;
      }
      if (!config?.enabled || !this.parts.length) continue;
      if (!Number.isInteger(config.partIndex) || config.partIndex < 0 || config.partIndex >= this.parts.length) {
        this.failEngineCall(`invalid source part assignment ${config.partIndex}`, -1, singer);
        this.destroyLaneList([...oldLanes, ...nextLanes]);
        this.lanes = [];
        this.rebuilding = false;
        return;
      }
      const part = this.parts[config.partIndex];
      const handle = this.module._speech_engine_create(engineIndex, SAMPLE_RATE);
      if (!handle) {
        this.failEngineCall("create voice context", -1, singer);
        this.destroyLaneList([...oldLanes, ...nextLanes]);
        this.lanes = [];
        return;
      }
      const cuePlan = this.prepareLaneCues(part);
      if (!cuePlan.ok) {
        this.module._speech_engine_destroy(handle);
        this.failEngineCall(cuePlan.error, -1, singer);
        this.destroyLaneList([...oldLanes, ...nextLanes]);
        this.lanes = [];
        return;
      }
      const lane = { module: this.module, handle, scratchPointer: this.scratchPointer, ownsScratch: false, part, singer, config, cuePlan, events: [], next: 0 };
      const seeded = this.setLaneSeed(lane, config.partIndex);
      if (seeded < 0) {
        this.module._speech_engine_destroy(handle);
        this.failEngineCall("seed voice phase", seeded, singer);
        this.destroyLaneList([...oldLanes, ...nextLanes]);
        this.lanes = [];
        return;
      }
      for (const parameter of info.parameters || []) {
        if (HIDDEN_EXPRESSION_PARAM_IDS.has(parameter.id)) continue;
        const key = parameter.key || `param_${parameter.id}`;
        const value = config.params?.[key] ?? parameter.default;
        if (value != null) {
          const result = this.module._speech_engine_set_param(handle, parameter.id, Number(value));
          if (result < 0) {
            this.module._speech_engine_destroy(handle);
            this.failEngineCall(`set parameter ${parameter.label || parameter.id}`, result, singer);
            this.destroyLaneList([...oldLanes, ...nextLanes]);
            this.lanes = [];
            return;
          }
        }
      }
      this.applyTransportTempo(lane);
      const expressionResult = this.applyLaneExpression(lane);
      if (expressionResult < 0) {
        this.module._speech_engine_destroy(handle);
        this.failEngineCall("set shared expression", expressionResult, singer);
        this.destroyLaneList([...oldLanes, ...nextLanes]);
        this.lanes = [];
        return;
      }
      for (const cue of cuePlan.cues) {
        const bytes = cue.bytes;
        const pointer = this.module._malloc(bytes.length);
        new Uint8Array(lane.module.HEAPF32.buffer).set(bytes, pointer);
        const result = lane.module._speech_engine_register_cue(handle, cue.id, pointer, bytes.length);
        lane.module._free(pointer);
        if (result < 0) {
          lane.module._speech_engine_destroy(handle);
          this.failEngineCall(`register lyric cue ${cue.id}`, result, singer);
          this.destroyLaneList([...oldLanes, ...nextLanes]);
          this.lanes = [];
          return;
        }
      }
      try {
        lane.scheduleNotes = this.scheduledNotes(this.module, part, config.partIndex, cuePlan, config);
      } catch (error) {
        lane.module._speech_engine_destroy(handle);
        this.failEngineCall(error?.message || "prepare timed score events", -1, singer);
        this.destroyLaneList([...oldLanes, ...nextLanes]);
        this.lanes = [];
        return;
      }
      lane.events = this.eventsFor(lane.scheduleNotes, cuePlan.sourceToLocal);
      const restored = this.restoreLane(lane, position);
      if (restored < 0) {
        lane.module._speech_engine_destroy(handle);
        this.failEngineCall("restore note at current position", restored, singer);
        this.destroyLaneList([...oldLanes, ...nextLanes]);
        this.lanes = [];
        return;
      }
      nextLanes[singer] = lane;
    }
    this.destroyLaneList(oldLanes);
    this.lanes = nextLanes;
    this.updateDurationFromLanes();
    this.rebuilding = false;
    this.playing = this.playbackIntent;
    this.port.postMessage({ type: "cue-status", unsupportedCueCount: 0 });
    this.port.postMessage({ type: "engine-status", engineId: this.engineId, info });
  }

  async rebuildSequencerLanes(info, engineIndex, needsModulePerVoice, generation) {
    this.engineError = false;
    const position = this.positionMs;
    this.rebuilding = true;
    this.playing = this.playbackIntent;
    this.destroyLanes();
    if (!info.available || !info.realtime) {
      this.rebuilding = false;
      this.port.postMessage({ type: "engine-status", engineId: this.engineId, info });
      this.snapshot();
      return;
    }
    const lanes = Array(this.voiceConfig.length).fill(null);
    let unsupportedTotal = 0;
    try {
      await Promise.all(this.voiceConfig.map(async (config, singer) => {
        if (!config?.enabled || !this.parts.length) return;
        const laneModule = needsModulePerVoice ? await createSpeechEngines() : this.module;
        const handle = laneModule._speech_engine_create(engineIndex, SAMPLE_RATE);
        if (!handle) throw new Error(`${info.name || this.engineId} could not create lane ${singer + 1}.`);
        const part = this.parts[config.partIndex] || this.parts[0];
        const cuePlan = this.prepareLaneCues(part);
        if (!cuePlan.ok) {
          laneModule._speech_engine_destroy(handle);
          throw new Error(cuePlan.error);
        }
        const lane = {
          module: laneModule,
          handle,
          scratchPointer: laneModule._malloc(MAX_BLOCK * Float32Array.BYTES_PER_ELEMENT),
          ownsScratch: needsModulePerVoice,
          part,
          singer,
          config,
          cuePlan: null,
          events: [],
          next: 0,
        };
        lanes[singer] = lane;
        lane.cuePlan = cuePlan;
        const seeded = this.setLaneSeed(lane, config.partIndex);
        if (seeded < 0) throw new Error(`${info.name || this.engineId} rejected the phase seed for lane ${singer + 1} (${seeded}).`);
        for (const parameter of info.parameters || []) {
          if (HIDDEN_EXPRESSION_PARAM_IDS.has(parameter.id)) continue;
          const key = parameter.key || `param_${parameter.id}`;
          const value = config.params?.[key] ?? parameter.default;
          if (value != null) {
            const result = laneModule._speech_engine_set_param(handle, parameter.id, Number(value));
            if (result < 0) throw new Error(`${info.name || this.engineId} rejected parameter ${parameter.label || parameter.id} for lane ${singer + 1} (${result}).`);
          }
        }
        this.applyTransportTempo(lane);
        const expressionResult = this.applyLaneExpression(lane);
        if (expressionResult < 0) throw new Error(`${info.name || this.engineId} rejected shared expression for lane ${singer + 1} (${expressionResult}).`);
        for (const cue of cuePlan.cues) {
          const bytes = cue.bytes;
          const pointer = laneModule._malloc(bytes.length);
          new Uint8Array(laneModule.HEAPF32.buffer).set(bytes, pointer);
          const result = laneModule._speech_engine_register_cue(handle, cue.id, pointer, bytes.length);
          laneModule._free(pointer);
          if (result < 0) throw new Error(`${info.name || this.engineId} rejected lyric cue ${cue.id} for lane ${singer + 1} (${result}).`);
        }
        lane.scheduleNotes = this.scheduledNotes(laneModule, part, config.partIndex, cuePlan, config);
        const loaded = this.loadSequencerTrack(lane, position);
        if (loaded < 0) throw new Error(`${info.name || this.engineId} rejected the timed track for lane ${singer + 1} (${loaded}).`);
      }));
      if (generation !== this.rebuildGeneration) {
        this.destroyLaneList(lanes);
        return;
      }
      this.lanes = lanes;
      this.updateDurationFromLanes();
      this.rebuilding = false;
      this.playing = this.playbackIntent;
      this.port.postMessage({ type: "cue-status", unsupportedCueCount: unsupportedTotal });
      this.port.postMessage({ type: "engine-status", engineId: this.engineId, info });
      this.snapshot();
    } catch (error) {
      if (generation === this.rebuildGeneration) {
        this.rebuilding = false;
        this.playing = false;
        this.playbackIntent = false;
        this.port.postMessage({ type: "error", message: error?.message || `${info.name || this.engineId} track setup failed.` });
        this.snapshot();
      }
      this.destroyLaneList(lanes);
    }
  }

  prepareLaneCues(part) {
    const sourceToLocal = new Map();
    const localByBytes = new Map();
    const cues = [];
    const addCue = (sourceId) => {
      if (!sourceId || sourceToLocal.has(sourceId)) return true;
      const sourceCue = this.cuesById?.get(sourceId);
      if (!sourceCue) return false;
      const bytes = sourceCue.bytes instanceof Uint8Array ? sourceCue.bytes : new Uint8Array(sourceCue.bytes || []);
      const key = bytes.join(",");
      let localId = localByBytes.get(key);
      if (localId === undefined) {
        if (cues.length >= 255) return false;
        localId = cues.length + 1;
        localByBytes.set(key, localId);
        cues.push({ id: localId, bytes });
      }
      sourceToLocal.set(sourceId, localId);
      return true;
    };
    for (let index = 0; index < part.notes.length; index += 1) {
      const note = part.notes[index];
      if (!addCue(note.cueId) || !addCue(note.nucleusCueId) || !addCue(note.restoreCueId)) {
        return { ok: false, error: "This part exceeds the 255 distinct phone cue plans supported after deduplication." };
      }
    }
    return { ok: true, sourceToLocal, cues };
  }

  eventsFor(part, sourceToLocal = new Map()) {
    const events = [];
    const notes = Array.isArray(part) ? part : part?.notes || [];
    for (const note of notes) {
      events.push({ timeMs: note.startMs, type: "on", note: note.note, velocity: note.velocity || 92, cueId: sourceToLocal.get(note.cueId) || 0 });
      events.push({ timeMs: note.endMs, type: "off", note: note.note, velocity: 0, cueId: 0, connectedContinuation: note.connectedContinuation === true });
    }
    events.sort((a, b) => a.timeMs - b.timeMs || Number(a.type === "on") - Number(b.type === "on"));
    return events;
  }

  restoreLane(lane, position) {
    const active = (lane.scheduleNotes || lane.part.notes).find((note) => note.startMs <= position && note.endMs > position);
    if (active) {
      const cueId = lane.cuePlan.sourceToLocal.get(active.restoreCueId || active.nucleusCueId) || 0;
      const result = lane.module._speech_engine_note_on(lane.handle, active.note, active.velocity || 92, cueId);
      if (result < 0) return result;
    }
    lane.next = lane.events.findIndex((event) => event.timeMs >= position);
    if (lane.next < 0) lane.next = lane.events.length;
    while (lane.next < lane.events.length && lane.events[lane.next].timeMs <= position) lane.next += 1;
    return 0;
  }

  destroyLanes() {
    this.destroyLaneList(this.lanes);
    this.lanes = [];
  }

  destroyLaneList(lanes) {
    const destroyedHandles = new Map();
    const freedPointers = new Map();
    for (const lane of lanes) {
      if (!lane?.module) continue;
      if (lane.handle) {
        let handles = destroyedHandles.get(lane.module);
        if (!handles) destroyedHandles.set(lane.module, handles = new Set());
        if (!handles.has(lane.handle)) {
          handles.add(lane.handle);
          lane.module._speech_engine_destroy(lane.handle);
        }
      }
      if (lane.ownsScratch && lane.scratchPointer) {
        let pointers = freedPointers.get(lane.module);
        if (!pointers) freedPointers.set(lane.module, pointers = new Set());
        if (!pointers.has(lane.scratchPointer)) {
          pointers.add(lane.scratchPointer);
          lane.module._free(lane.scratchPointer);
        }
      }
    }
  }

  setParameter(singer, id, value) {
    const lane = this.lanes[singer];
    if (lane?.handle) {
      const result = lane.module._speech_engine_set_param(lane.handle, id, Number(value));
      if (result < 0) this.failEngineCall(`set parameter ${id}`, result, singer);
    }
  }

  applyTransportTempo(lane) {
    const parameters = this.engineInfo?.parameters || [];
    const parameterId = this.engineInfo?.transportTempoParameterId ??
      parameters.find((parameter) => parameter.role === "transport-tempo" || parameter.key === "tempo_percent" ||
        (parameter.label?.toLowerCase() === "tempo" && parameter.unit === "percent"))?.id;
    if (Number.isInteger(parameterId) && lane?.handle) {
      const result = lane.module._speech_engine_set_param(lane.handle, parameterId, this.tempo * 100);
      if (result < 0) this.failEngineCall(`set transport tempo ${this.tempo * 100}%`, result, lane.singer);
    }
  }

  applyDueEvents() {
    for (let laneIndex = 0; laneIndex < this.lanes.length; laneIndex += 1) {
      const lane = this.lanes[laneIndex];
      if (!lane) continue;
      while (lane.next < lane.events.length && lane.events[lane.next].timeMs <= this.positionMs + 0.00001) {
        const event = lane.events[lane.next++];
        const result = event.type === "off"
          ? lane.module._speech_engine_note_off_ex(lane.handle, event.note, event.connectedContinuation ? 1 : 0)
          : lane.module._speech_engine_note_on(lane.handle, event.note, event.velocity, event.cueId);
        if (result < 0) {
          this.failEngineCall(`${event.type} MIDI ${event.note} at ${event.timeMs.toFixed(1)} ms`, result, laneIndex);
          return false;
        }
      }
    }
    return true;
  }

  failEngineCall(operation, code, singer) {
    if (this.engineError) return;
    this.engineError = true;
    this.playing = false;
    this.playbackIntent = false;
    const lane = Number.isInteger(singer) ? ` for lane ${singer + 1}` : "";
    const message = `${this.engineInfo?.name || this.engineId} failed to ${operation}${lane} (engine error ${code}).`;
    this.port.postMessage({ type: "error", engineId: this.engineId, message });
    this.snapshot();
  }

  nextEventMs() {
    let next = Infinity;
    for (let laneIndex = 0; laneIndex < this.lanes.length; laneIndex += 1) {
      const lane = this.lanes[laneIndex];
      if (lane && lane.next < lane.events.length) next = Math.min(next, lane.events[lane.next].timeMs);
    }
    return next;
  }

  renderBlock(frames, output) {
    output.fill(0);
    let cursor = 0;
    while (cursor < frames) {
      if (!this.applyDueEvents() || !this.playing || !this.module) break;
      const perFrameMs = (1000 / SAMPLE_RATE) * this.tempo;
      const next = this.nextEventMs();
      let count = Math.min(MAX_BLOCK, frames - cursor);
      if (Number.isFinite(next)) count = Math.min(count, Math.max(1, Math.ceil((next - this.positionMs) / perFrameMs)));
      for (let laneIndex = 0; laneIndex < this.lanes.length; laneIndex += 1) {
        const lane = this.lanes[laneIndex];
        if (!lane) continue;
        const laneModule = lane.module;
        const ptr = lane.scratchPointer ?? this.scratchPointer;
        const rendered = laneModule._speech_engine_render_into(lane.handle, ptr, count);
        if (rendered !== count) {
          output.fill(0);
          this.failEngineCall(`render ${count} frames`, rendered, laneIndex);
          break;
        }
        const samples = laneModule.HEAPF32;
        const sampleOffset = ptr >>> 2;
        for (let sample = 0; sample < count; sample += 1) output[cursor + sample] += samples[sampleOffset + sample];
      }
      if (this.engineError) break;
      this.positionMs += count * perFrameMs;
      cursor += count;
      if (this.positionMs >= this.durationMs()) {
        this.positionMs = this.durationMs();
        this.playing = false;
      this.playbackIntent = false;
      }
    }
    let energy = 0;
    let peak = 0;
    let clipped = 0;
    for (let index = 0; index < frames; index += 1) {
      const magnitude = Math.abs(output[index]);
      if (magnitude > peak) peak = magnitude;
      if (magnitude > 0.98) clipped += 1;
      output[index] = Math.max(-0.98, Math.min(0.98, output[index]));
      energy += output[index] * output[index];
    }
    this.outputRms = frames ? Math.sqrt(energy / frames) : 0;
    this.outputPeak = peak;
    this.clipRatio = frames ? clipped / frames : 0;
  }

  snapshot() {
    const message = this.snapshotData;
    message.positionMs = this.positionMs;
    message.durationMs = this.durationMs();
    message.playing = this.playing;
    message.outputRms = this.outputRms;
    message.outputPeak = this.outputPeak;
    message.clipRatio = this.clipRatio;
    this.port.postMessage(message);
  }

  process(_inputs, outputs) {
    const channel = outputs[0]?.[0];
    if (!channel) return true;
      if (this.module && !this.rebuilding && this.engineInfo?.available && this.engineInfo?.realtime !== false) {
      this.renderBlock(channel.length, channel);
    } else channel.fill(0);
    const now = currentTime;
    if (now - this.lastSnapshot > 0.1) {
      this.lastSnapshot = now;
      this.snapshot();
    }
    return true;
  }
}

registerProcessor("choir-speech-engine", SpeechEngineProcessor);
