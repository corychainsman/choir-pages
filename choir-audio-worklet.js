const CANONICAL_RATE = 24000;
const SINGER_COUNT = 8;
const LIVE_TONE_COUNT = 16;
const Q15 = 32768;
const DEBUG_BLOCK_SAMPLES = 512;
const DEBUG_FIELD_COUNT = 19;
const GNU_SCORE_TONE_PARAMETER_INDICES = Object.freeze([0, 1, 2, 10, 12, 14, 15]);

class ChoirCanonicalAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const bytes = options.processorOptions.wasmBytes;
    const module = new WebAssembly.Module(bytes);
    this.wasm = new WebAssembly.Instance(module, {
      env: { emscripten_notify_memory_growth() {} },
    }).exports;
    this.runtimes = [];
    this.scorePointer = 0;
    this.scoreSize = 0;
    this.gnuScorePointers = [];
    this.gnuPackages = [];
    this.gnuAssignments = [];
    this.gnuCanonicalVoicePointer = 0;
    this.gnuLivePointer = 0;
    this.gnuLiveEventPointer = 0;
    this.gnuLiveOutputPointer = 0;
    this.gnuLiveOutputView = null;
    this.liveEngine = "";
    this.gnuEntrySample = 0;
    this.gnuDurationSamples = 0;
    this.gnuHasStarted = false;
    this.gnuPositionExplicit = false;
    this.statusPointer = 0;
    this.loadGeneration = 0;
    this.tempoQ16 = 65536;
    this.loaded = false;
    this.live = false;
    this.liveActive = [];
    this.liveRendering = [];
    this.liveGeneration = [];
    this.livePhysicalSinger = [];
    this.liveSourceSerial = [];
    this.liveGainCurrent = Array(SINGER_COUNT).fill(Q15);
    this.liveGainTarget = Array(SINGER_COUNT).fill(Q15);
    this.liveGainRemaining = Array(SINGER_COUNT).fill(0);
    this.toneParameters = Array(SINGER_COUNT).fill(null);
    this.runtimePrevious = new Int16Array(0);
    this.runtimeCurrent = new Int16Array(0);
    this.liveSums = new Int32Array(SINGER_COUNT);
    this.liveOnsetProbes = [];
    this.playing = false;
    this.ending = false;
    this.pauseFrames = 0;
    this.nodeGains = Array(SINGER_COUNT).fill(Q15);
    this.pendingAssignments = Array(SINGER_COUNT).fill(null);
    this.previous = new Int16Array(SINGER_COUNT);
    this.current = new Int16Array(SINGER_COUNT);
    this.resamplePhase = sampleRate;
    this.reportCounter = 0;
    this.debugMask = 0;
    this.debugSamples = new Int16Array(DEBUG_BLOCK_SAMPLES);
    this.debugSampleIndex = 0;
    this.port.onmessage = ({ data }) => this.handleMessage(data);
    this.port.postMessage({ type: "ready" });
  }

  disposeScore() {
    if (this.gnuLivePointer) this.wasm.choir_gnu_live_destroy(this.gnuLivePointer);
    if (this.gnuLivePointer) this.wasm.free(this.gnuLivePointer);
    if (this.gnuLiveEventPointer) this.wasm.free(this.gnuLiveEventPointer);
    if (this.gnuLiveOutputPointer) this.wasm.free(this.gnuLiveOutputPointer);
    this.gnuLivePointer = 0;
    this.gnuLiveEventPointer = 0;
    this.gnuLiveOutputPointer = 0;
    this.gnuLiveOutputView = null;
    this.liveEngine = "";
    for (const runtime of this.runtimes) {
      this.wasm.choir_audio_runtime_unload(runtime);
      this.wasm.free(runtime);
    }
    this.runtimes = [];
    if (this.scorePointer) this.wasm.free(this.scorePointer);
    for (const pointer of this.gnuScorePointers) this.wasm.free(pointer);
    if (this.statusPointer) this.wasm.free(this.statusPointer);
    this.scorePointer = 0;
    this.scoreSize = 0;
    this.gnuScorePointers = [];
    this.gnuPackages = [];
    this.gnuAssignments = [];
    if (this.gnuCanonicalVoicePointer) this.wasm.free(this.gnuCanonicalVoicePointer);
    this.gnuCanonicalVoicePointer = 0;
    this.gnuEntrySample = 0;
    this.gnuDurationSamples = 0;
    this.gnuHasStarted = false;
    this.gnuPositionExplicit = false;
    this.statusPointer = 0;
    this.loadGeneration = 0;
    this.tempoQ16 = 65536;
    this.loaded = false;
    this.live = false;
    this.liveActive.fill(false);
    this.liveRendering = [];
    this.liveGeneration = [];
    this.livePhysicalSinger = [];
    this.liveSourceSerial = [];
    this.runtimePrevious = new Int16Array(0);
    this.runtimeCurrent = new Int16Array(0);
    this.liveOnsetProbes = [];
    this.playing = false;
    this.ending = false;
    this.pauseFrames = 0;
    this.reportCounter = 0;
    this.debugSampleIndex = 0;
    this.debugSamples = new Int16Array(DEBUG_BLOCK_SAMPLES);
    this.pendingAssignments.fill(null);
  }

  load(data) {
    this.disposeScore();
    const score = new Uint8Array(data.score);
    this.scoreSize = score.byteLength;
    if (!this.scoreSize) throw new Error("Canonical score is empty");
    this.scorePointer = this.wasm.malloc(this.scoreSize);
    if (!this.scorePointer) throw new Error("Unable to allocate canonical score memory");
    new Uint8Array(this.wasm.memory.buffer, this.scorePointer, this.scoreSize).set(score);
    this.statusPointer = this.wasm.malloc(18 * Uint32Array.BYTES_PER_ELEMENT);
    if (!this.statusPointer) throw new Error("Unable to allocate runtime display status");
    this.loadGeneration = Number.isSafeInteger(data.requestId) ? data.requestId : 0;
    this.tempoQ16 = Number.isInteger(data.tempoQ16) && data.tempoQ16 > 0
      ? data.tempoQ16 : 65536;
    const runtimeSize = this.wasm.choir_audio_runtime_sizeof();
    const runtimeCount = data.live ? LIVE_TONE_COUNT : SINGER_COUNT;
    this.liveActive = Array(runtimeCount).fill(false);
    this.liveRendering = Array(runtimeCount).fill(false);
    this.liveGeneration = Array(runtimeCount).fill(0);
    this.liveOnsetProbes = Array(runtimeCount).fill(null);
    this.livePhysicalSinger = Array.from(
      { length: runtimeCount },
      (_, tone) => tone < SINGER_COUNT ? tone : -1,
    );
    this.toneParameters = data.tones.map((parameters) => [...parameters]);
    this.runtimePrevious = new Int16Array(runtimeCount);
    this.runtimeCurrent = new Int16Array(runtimeCount);
    for (let singer = 0; singer < runtimeCount; singer += 1) {
      const runtime = this.wasm.malloc(runtimeSize);
      if (!runtime) {
        this.disposeScore();
        throw new Error(`Unable to allocate canonical runtime ${singer + 1}`);
      }
      this.runtimes.push(runtime);
      const status = this.wasm.choir_audio_runtime_load(
        runtime,
        this.scorePointer,
        this.scoreSize,
        singer,
        data.assignments[singer] ?? 0,
        Math.floor((singer % SINGER_COUNT) / 2),
      );
      if (status !== 0) {
        this.disposeScore();
        throw new Error(`Canonical score load failed (${status})`);
      }
      this.applyRuntimeTone(runtime, data.tones[singer % SINGER_COUNT]);
      this.wasm.choir_audio_runtime_set_output_gain_q15(
        runtime,
        data.live ? this.nodeGains[singer % SINGER_COUNT] : 0,
      );
    }
    this.loaded = true;
    this.live = Boolean(data.live);
    this.liveEngine = this.live ? "tg" : "";
    this.resamplePhase = sampleRate;
    this.previous.fill(0);
    this.current.fill(0);
    this.port.postMessage({ type: "loaded", requestId: data.requestId });
  }

  loadGnu(data) {
    this.disposeScore();
    const packages = Array.isArray(data.packages) ? data.packages : [];
    if (packages.length < 4 || packages.length > SINGER_COUNT) {
      throw new Error("GNU load requires 4–8 source parts");
    }
    try {
    this.statusPointer = this.wasm.malloc(18 * Uint32Array.BYTES_PER_ELEMENT);
    if (!this.statusPointer) throw new Error("Unable to allocate runtime display status");
    this.loadGeneration = Number.isSafeInteger(data.requestId) ? data.requestId : 0;
    this.tempoQ16 = Number.isInteger(data.tempoQ16) && data.tempoQ16 > 0
      ? data.tempoQ16 : 65536;
    this.gnuEntrySample = Number.isInteger(data.entrySample) && data.entrySample >= 0
      ? data.entrySample : 0;
    this.gnuHasStarted = false;
    this.gnuPositionExplicit = false;
    this.gnuDurationSamples = Number.isInteger(data.durationSamples) && data.durationSamples > 0
      ? data.durationSamples : 0;
    const runtimeSize = this.wasm.choir_audio_runtime_sizeof();
    this.toneParameters = data.tones.map((parameters) => [...parameters]);
    this.runtimePrevious = new Int16Array(SINGER_COUNT);
    this.runtimeCurrent = new Int16Array(SINGER_COUNT);
    this.liveActive = Array(SINGER_COUNT).fill(false);
    this.liveRendering = Array(SINGER_COUNT).fill(false);
    this.liveGeneration = Array(SINGER_COUNT).fill(0);
    this.livePhysicalSinger = Array.from({ length: SINGER_COUNT }, (_, singer) => singer);
    this.liveOnsetProbes = Array(SINGER_COUNT).fill(null);
    this.gnuPackages = packages.map((entry, index) => {
      if (!entry || !Number.isInteger(entry.canonicalVoiceIndex) ||
          entry.canonicalVoiceIndex < 0 || entry.canonicalVoiceIndex >= SINGER_COUNT) {
        throw new Error(`GNU package ${index} has an invalid canonical voice index`);
      }
      const score = new Uint8Array(entry.score);
      if (score.length < 48 || score[0] !== 0x47 || score[1] !== 0x4e ||
          score[2] !== 0x42 || score[3] !== 0x32) {
        throw new Error(`GNU package ${index} is not a GNB2 part`);
      }
      const header = new DataView(score.buffer, score.byteOffset, score.byteLength);
      if (header.getUint32(4, true) !== 2 ||
          header.getUint32(8, true) !== CANONICAL_RATE ||
          header.getUint32(16, true) !== entry.sourcePartIndex ||
          header.getUint32(44, true) !== 2) {
        throw new Error(`GNU package ${index} has an unsupported GNB2 header or precision`);
      }
      const pointer = this.wasm.malloc(score.byteLength);
      if (!pointer) throw new Error(`Unable to allocate GNU source part ${index}`);
      new Uint8Array(this.wasm.memory.buffer, pointer, score.byteLength).set(score);
      this.gnuScorePointers.push(pointer);
      return {
        pointer,
        size: score.byteLength,
        canonicalVoiceIndex: entry.canonicalVoiceIndex,
        sourcePartIndex: entry.sourcePartIndex,
      };
    });
    this.gnuCanonicalVoicePointer = this.wasm.malloc(
      this.gnuPackages.length * Uint32Array.BYTES_PER_ELEMENT,
    );
    if (!this.gnuCanonicalVoicePointer) throw new Error("Unable to allocate GNU part map");
    new Uint32Array(
      this.wasm.memory.buffer,
      this.gnuCanonicalVoicePointer,
      this.gnuPackages.length,
    ).set(this.gnuPackages.map((part) => part.canonicalVoiceIndex));
    this.gnuAssignments = Array.from({ length: SINGER_COUNT }, (_, singer) => (
      this.gnuPackageForSlot(singer)
    ));
    if (Array.isArray(data.assignments) &&
        (data.assignments.length !== SINGER_COUNT || data.assignments.some((part, singer) =>
          !Number.isInteger(part) || part !== this.gnuAssignments[singer]))) {
      throw new Error("GNU singer assignments disagree with canonical source-part mapping");
    }
    this.runtimes = [];
    for (let singer = 0; singer < SINGER_COUNT; singer += 1) {
      const packageIndex = this.gnuAssignments[singer];
      const source = this.gnuPackages[packageIndex];
      const runtime = this.wasm.malloc(runtimeSize);
      if (!runtime) {
        this.disposeScore();
        throw new Error(`Unable to allocate GNU runtime ${singer + 1}`);
      }
      this.runtimes.push(runtime);
      const status = this.wasm.choir_audio_runtime_load(
        runtime, source.pointer, source.size, singer, source.canonicalVoiceIndex,
        Math.floor((singer % SINGER_COUNT) / 2),
      );
      if (status !== 0) {
        this.disposeScore();
        throw new Error(`GNU source part load failed (${status}) for singer ${singer + 1}`);
      }
      this.wasm.choir_audio_runtime_set_tempo_q16(runtime, this.tempoQ16);
      this.applyRuntimeTone(runtime, this.toneParameters[singer]);
      this.wasm.choir_audio_runtime_set_output_gain_q15(runtime, 0);
    }
    this.loaded = true;
    this.live = false;
    this.playing = false;
    this.ending = false;
    this.resamplePhase = sampleRate;
    this.previous.fill(0);
    this.current.fill(0);
    this.port.postMessage({ type: "loaded", requestId: data.requestId, engine: "gnuspeech" });
    } catch (error) {
      this.disposeScore();
      throw error;
    }
  }

  loadGnuLive(data) {
    this.disposeScore();
    if (typeof this.wasm.choir_gnu_live_sizeof !== "function" ||
        typeof this.wasm.choir_gnu_live_enqueue_routed !== "function" ||
        typeof this.wasm.choir_gnu_live_render_routed !== "function") {
      throw new Error("GNU live runtime exports are missing");
    }
    const poolBytes = this.wasm.choir_gnu_live_sizeof();
    this.gnuLivePointer = this.wasm.malloc(poolBytes);
    this.gnuLiveEventPointer = this.wasm.malloc(32);
    this.gnuLiveOutputPointer = this.wasm.malloc(SINGER_COUNT * 4);
    if (!this.gnuLivePointer || !this.gnuLiveEventPointer ||
        !this.gnuLiveOutputPointer) {
      this.disposeScore();
      throw new Error("Unable to allocate GNU live runtime memory");
    }
    const initialized = this.wasm.choir_gnu_live_init(
      this.gnuLivePointer, poolBytes, (data.requestId >>> 0) || 1,
    );
    if (initialized !== 0) {
      this.disposeScore();
      throw new Error(`GNU live runtime initialization failed (${initialized})`);
    }
    this.statusPointer = this.wasm.malloc(18 * Uint32Array.BYTES_PER_ELEMENT);
    if (!this.statusPointer) {
      this.disposeScore();
      throw new Error("Unable to allocate GNU live status");
    }
    this.gnuLiveOutputView = new Float32Array(
      this.wasm.memory.buffer, this.gnuLiveOutputPointer, SINGER_COUNT,
    );
    if (Number.isSafeInteger(data.outputSamplePosition) && data.outputSamplePosition > 0) {
      const rebased = this.wasm.choir_gnu_live_rebase_output_sample(
        this.gnuLivePointer, BigInt(data.outputSamplePosition),
      );
      if (rebased !== 0) {
        this.disposeScore();
        throw new Error(`GNU live clock rebase failed (${rebased})`);
      }
    }
    this.liveGeneration = Array(LIVE_TONE_COUNT).fill(0);
    this.liveSourceSerial = Array(LIVE_TONE_COUNT).fill(0);
    this.livePhysicalSinger = Array(LIVE_TONE_COUNT).fill(-1);
    this.liveActive = Array(LIVE_TONE_COUNT).fill(false);
    this.liveRendering = Array(LIVE_TONE_COUNT).fill(false);
    this.liveOnsetProbes = Array(LIVE_TONE_COUNT).fill(null);
    this.liveSums = new Int32Array(SINGER_COUNT);
    this.toneParameters = data.tones.map((parameters) => [...parameters]);
    this.live = true;
    this.liveEngine = "gnu";
    this.loaded = true;
    this.playing = false;
    this.ending = false;
    this.resamplePhase = sampleRate;
    this.previous.fill(0);
    this.current.fill(0);
    this.port.postMessage({ type: "loaded", requestId: data.requestId, engine: "gnuspeech-live" });
  }

  applyTone(singer, parameters) {
    if (!Number.isInteger(singer) || singer < 0 || singer >= SINGER_COUNT || !parameters) return;
    this.toneParameters[singer] = [...parameters];
    if (this.liveEngine === "gnu") return;
    if (this.live) {
      for (let tone = 0; tone < this.runtimes.length; tone += 1) {
        if (this.livePhysicalSinger[tone] === singer) {
          this.applyRuntimeTone(this.runtimes[tone], parameters);
        }
      }
      return;
    }
    this.applyRuntimeTone(this.runtimes[singer], parameters);
  }

  applyRuntimeTone(runtime, parameters) {
    if (!runtime || !parameters) return;
    if (this.gnuPackages.length) {
      for (const parameter of GNU_SCORE_TONE_PARAMETER_INDICES) {
        if (parameters[parameter] !== undefined) {
          this.wasm.choir_audio_runtime_set_param(runtime, parameter, parameters[parameter]);
        }
      }
      return;
    }
    parameters.forEach((value, parameter) => this.wasm.choir_audio_runtime_set_param(runtime, parameter, value));
  }

  assignGnuPart(singer, packageIndex) {
    if (!this.hasSinger(singer) || !Number.isInteger(packageIndex) ||
        packageIndex < 0 || packageIndex >= this.gnuPackages.length) return false;
    if (this.gnuAssignments[singer] === packageIndex) return true;
    const source = this.gnuPackages[packageIndex];
    const runtime = this.runtimes[singer];
    if (!runtime || !source) return false;
    const position = this.wasm.choir_audio_runtime_position_sample(runtime);
    const statusWords = new Uint32Array(this.wasm.memory.buffer, this.statusPointer, 18);
    const displayStatus = this.wasm.choir_audio_runtime_write_display_status(
      runtime, this.statusPointer, 18,
    );
    if (displayStatus !== 0) return false;
    const outputPosition = statusWords[0] + statusWords[1] * 4294967296;
    this.wasm.choir_audio_runtime_unload(runtime);
    const status = this.wasm.choir_audio_runtime_load(
      runtime, source.pointer, source.size, singer, source.canonicalVoiceIndex,
      Math.floor((singer % SINGER_COUNT) / 2),
    );
    if (status !== 0) throw new Error(`GNU singer assignment failed (${status})`);
    this.wasm.choir_audio_runtime_set_tempo_q16(runtime, this.tempoQ16);
    this.applyRuntimeTone(runtime, this.toneParameters[singer]);
    this.wasm.choir_audio_runtime_seek(runtime, position);
    this.wasm.choir_audio_runtime_rebase_output_sample(runtime, BigInt(Math.trunc(outputPosition)));
    this.wasm.choir_audio_runtime_set_output_gain_q15(runtime, 0);
    if (this.playing) {
      this.wasm.choir_audio_runtime_play(runtime);
      this.wasm.choir_audio_runtime_ramp_output_gain_q15(runtime, this.nodeGains[singer], 384);
    }
    this.gnuAssignments[singer] = packageIndex;
    this.previous[singer] = 0;
    this.current[singer] = 0;
    this.pendingAssignments[singer] = null;
    return true;
  }

  gnuPackageForSlot(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SINGER_COUNT || !this.gnuPackages.length) return -1;
    if (typeof this.wasm.choir_gnu_score_part_for_slot !== "function" ||
        !this.gnuCanonicalVoicePointer) return -1;
    return this.wasm.choir_gnu_score_part_for_slot(
      this.gnuCanonicalVoicePointer, this.gnuPackages.length, slot,
    );
  }

  setGain(singer, gain, frames = 384) {
    if (!Number.isInteger(singer) || singer < 0 || singer >= SINGER_COUNT) return;
    const target = Math.max(0, Math.min(Q15, Math.round(gain)));
    this.nodeGains[singer] = target;
    if (this.liveEngine === "gnu") {
      this.liveGainTarget[singer] = target;
      this.liveGainRemaining[singer] = Math.max(0, Math.round(frames));
      if (!this.liveGainRemaining[singer]) this.liveGainCurrent[singer] = target;
      return;
    }
    if (this.live) {
      this.runtimes.forEach((runtime, tone) => {
        if (this.livePhysicalSinger[tone] === singer) {
          this.wasm.choir_audio_runtime_ramp_output_gain_q15(runtime, target, frames);
        }
      });
    } else if (this.runtimes[singer]) {
      this.wasm.choir_audio_runtime_ramp_output_gain_q15(this.runtimes[singer], target, frames);
    }
  }

  hasSinger(singer) {
    return Number.isInteger(singer) && singer >= 0 && singer < SINGER_COUNT;
  }

  handleMessage(data) {
    try {
      if (data.type === "load") this.load(data);
      else if (data.type === "load-gnu") this.loadGnu(data);
      else if (data.type === "load-gnu-live") this.loadGnuLive(data);
      else if (data.type === "unload") this.disposeScore();
      else if (data.type === "tone") this.applyTone(data.singer, data.parameters);
      else if (data.type === "gnu-live-tone") {
        // Live controls are captured from the singer profile at the next
        // NOTE_ON. A held GNU syllable keeps its original parameter snapshot.
      }
      else if (data.type === "debug") {
        this.debugMask = Math.max(0, Math.min(255, Math.round(data.mask || 0)));
        this.debugSampleIndex = 0;
      }
      else if (data.type === "tempo") {
        this.tempoQ16 = data.tempoQ16;
        for (const runtime of this.runtimes) {
          this.wasm.choir_audio_runtime_set_tempo_q16(runtime, data.tempoQ16);
        }
      } else if (data.type === "gain") {
        if (!this.hasSinger(data.singer)) return;
        this.nodeGains[data.singer] = Math.max(0, Math.min(Q15, Math.round(data.gainQ15)));
        if (!this.pauseFrames && !this.ending) this.setGain(data.singer, data.gainQ15, data.frames);
      }
      else if (data.type === "live-tone-on") {
        if (!this.live || !Number.isInteger(data.tone) ||
            data.tone < 0 || data.tone >= this.liveActive.length ||
            !Number.isInteger(data.physicalSinger) ||
            data.physicalSinger < 0 || data.physicalSinger >= SINGER_COUNT) return;
        if (this.liveEngine === "gnu") {
          const serial = Number(data.sourceSerial) >>> 0 || (data.tone + 1);
          for (const [parameterId, value] of data.gnuParameters || []) {
            const parameterStatus = this.enqueueGnuLiveEvent({
              op: 4, tone: data.tone, generation: data.generation, sourceSerial: serial,
              parameterId, parameterValue: value,
            }, data.physicalSinger);
            if (parameterStatus !== 0) throw new Error(`GNU live parameter enqueue failed (${parameterStatus})`);
          }
          const status = this.enqueueGnuLiveEvent({
            op: 1, tone: data.tone, generation: data.generation, sourceSerial: serial,
            cueId: data.syllable + 1, midi: data.midi, velocity: data.velocity,
          }, data.physicalSinger);
          if (status !== 0) throw new Error(`GNU live note-on enqueue failed (${status})`);
          this.livePhysicalSinger[data.tone] = data.physicalSinger;
          this.liveGeneration[data.tone] = data.generation >>> 0;
          this.liveSourceSerial[data.tone] = serial;
          this.liveActive[data.tone] = true;
          this.liveRendering[data.tone] = true;
          this.playing = true;
          if (data.probeId != null) {
            this.liveOnsetProbes[data.tone] = {
              probeId: data.probeId,
              commandFrame: typeof currentFrame === "number" ? currentFrame : 0,
            };
          }
          return;
        }
        this.livePhysicalSinger[data.tone] = data.physicalSinger;
        this.liveGeneration[data.tone] = data.generation >>> 0;
        this.applyRuntimeTone(
          this.runtimes[data.tone],
          this.toneParameters[data.physicalSinger],
        );
        this.wasm.choir_audio_runtime_set_output_gain_q15(
          this.runtimes[data.tone],
          this.nodeGains[data.physicalSinger],
        );
        const status = this.wasm.choir_audio_runtime_live_note_on(
          this.runtimes[data.tone],
          data.midi,
          data.velocity,
          data.syllable,
          data.attackSamples,
        );
        if (status !== 0) throw new Error(`Canonical live note failed (${status})`);
        this.liveActive[data.tone] = true;
        this.liveRendering[data.tone] = true;
        if (data.probeId != null) {
          this.liveOnsetProbes[data.tone] = {
            probeId: data.probeId,
            commandFrame: typeof currentFrame === "number" ? currentFrame : 0,
          };
        }
        this.playing = true;
      }
      else if (data.type === "live-tone-off") {
        if (!this.live || !Number.isInteger(data.tone) ||
            data.tone < 0 || data.tone >= this.liveActive.length ||
            this.liveGeneration[data.tone] !== (data.generation >>> 0)) return;
        if (this.liveEngine === "gnu") {
          const status = this.enqueueGnuLiveEvent({
            op: 2, tone: data.tone, generation: data.generation,
            sourceSerial: this.liveSourceSerial[data.tone],
            continuation: false,
          }, this.livePhysicalSinger[data.tone]);
          if (status !== 0) throw new Error(`GNU live note-off enqueue failed (${status})`);
          this.liveActive[data.tone] = false;
          this.liveRendering[data.tone] = true;
          this.playing = this.liveActive.some(Boolean);
          return;
        }
        this.wasm.choir_audio_runtime_live_note_off(
          this.runtimes[data.tone],
          data.releaseSamples,
        );
        this.liveActive[data.tone] = false;
        this.liveRendering[data.tone] = true;
        this.playing = this.liveActive.some(Boolean);
      }
      else if (data.type === "live-tone-transfer") {
        if (!this.live || !Number.isInteger(data.fromTone) ||
            !Number.isInteger(data.toTone) || data.fromTone === data.toTone ||
            data.fromTone < 0 || data.fromTone >= this.liveActive.length ||
            data.toTone < 0 || data.toTone >= this.liveActive.length ||
            !this.liveActive[data.fromTone] || this.liveActive[data.toTone] ||
            !Number.isInteger(data.physicalSinger) ||
            data.physicalSinger < 0 || data.physicalSinger >= SINGER_COUNT) return;
        if (this.liveEngine === "gnu") {
          const sourceSerial = Number(data.sourceSerial) >>> 0 || this.liveSourceSerial[data.fromTone];
          for (const [parameterId, value] of data.gnuParameters || []) {
            const parameterStatus = this.enqueueGnuLiveEvent({
              op: 4, tone: data.fromTone, generation: this.liveGeneration[data.fromTone],
              sourceSerial, parameterId, parameterValue: value,
            }, this.livePhysicalSinger[data.fromTone]);
            if (parameterStatus !== 0) throw new Error(`GNU live transfer parameter failed (${parameterStatus})`);
          }
          const transferStatus = this.enqueueGnuLiveEvent({
            op: 5, tone: data.toTone, generation: data.generation,
            sourceSerial, parameterId: data.fromTone,
          }, data.physicalSinger);
          if (transferStatus !== 0) {
            throw new Error(`GNU live transfer enqueue failed (${transferStatus})`);
          }
          this.liveActive[data.fromTone] = false;
          this.liveRendering[data.fromTone] = false;
          [this.liveOnsetProbes[data.fromTone], this.liveOnsetProbes[data.toTone]] =
            [this.liveOnsetProbes[data.toTone], this.liveOnsetProbes[data.fromTone]];
          this.liveGeneration[data.toTone] = data.generation >>> 0;
          this.liveSourceSerial[data.toTone] = sourceSerial;
          this.livePhysicalSinger[data.toTone] = data.physicalSinger;
          this.liveActive[data.toTone] = true;
          this.liveRendering[data.toTone] = true;
          return;
        }
        [this.runtimes[data.fromTone], this.runtimes[data.toTone]] =
          [this.runtimes[data.toTone], this.runtimes[data.fromTone]];
        [this.runtimePrevious[data.fromTone], this.runtimePrevious[data.toTone]] =
          [this.runtimePrevious[data.toTone], this.runtimePrevious[data.fromTone]];
        [this.runtimeCurrent[data.fromTone], this.runtimeCurrent[data.toTone]] =
          [this.runtimeCurrent[data.toTone], this.runtimeCurrent[data.fromTone]];
        [this.liveActive[data.fromTone], this.liveActive[data.toTone]] =
          [this.liveActive[data.toTone], this.liveActive[data.fromTone]];
        [this.liveRendering[data.fromTone], this.liveRendering[data.toTone]] =
          [this.liveRendering[data.toTone], this.liveRendering[data.fromTone]];
        [this.liveOnsetProbes[data.fromTone], this.liveOnsetProbes[data.toTone]] =
          [this.liveOnsetProbes[data.toTone], this.liveOnsetProbes[data.fromTone]];
        [this.liveGeneration[data.fromTone], this.liveGeneration[data.toTone]] =
          [this.liveGeneration[data.toTone], this.liveGeneration[data.fromTone]];
        [this.livePhysicalSinger[data.fromTone], this.livePhysicalSinger[data.toTone]] =
          [this.livePhysicalSinger[data.toTone], this.livePhysicalSinger[data.fromTone]];
        this.liveGeneration[data.toTone] = data.generation >>> 0;
        this.livePhysicalSinger[data.toTone] = data.physicalSinger;
        this.applyRuntimeTone(
          this.runtimes[data.toTone],
          this.toneParameters[data.physicalSinger],
        );
        this.wasm.choir_audio_runtime_set_output_gain_q15(
          this.runtimes[data.toTone],
          this.nodeGains[data.physicalSinger],
        );
      }
      else if (data.type === "live-all-notes-off") {
        if (!this.live) return;
        if (this.liveEngine === "gnu") {
          const status = this.enqueueGnuLiveEvent({ op: 3, tone: 0 }, 0);
          if (status !== 0) throw new Error(`GNU live all-notes-off enqueue failed (${status})`);
          this.liveActive.fill(false);
          this.liveRendering.fill(true);
          this.playing = false;
          return;
        }
        for (const runtime of this.runtimes) {
          this.wasm.choir_audio_runtime_live_all_notes_off(runtime, data.releaseSamples);
        }
        this.liveActive.fill(false);
        if (!data.releaseSamples) this.liveRendering.fill(false);
        this.playing = false;
      }
      else if (data.type === "assignment") {
        if (this.live) return;
        if (!this.hasSinger(data.singer) || !Number.isInteger(data.scoreVoice)) return;
        if (this.gnuPackages.length) {
          const packageIndex = Number.isInteger(data.voiceSlot)
            ? this.gnuPackageForSlot(data.voiceSlot)
            : data.scoreVoice;
          if (!this.assignGnuPart(data.singer, packageIndex)) {
            throw new Error("GNU source part assignment is invalid");
          }
          return;
        }
        this.pendingAssignments[data.singer] = {
          scoreVoice: data.scoreVoice,
          remaining: 192,
        };
        this.wasm.choir_audio_runtime_ramp_output_gain_q15(
          this.runtimes[data.singer],
          0,
          192,
        );
      }
      else if (data.type === "seek") {
        for (const runtime of this.runtimes) this.wasm.choir_audio_runtime_seek(runtime, data.sample);
        if (this.gnuPackages.length) this.gnuPositionExplicit = true;
        this.ending = false;
        if (data.restoreOutput && this.playing) {
          for (let singer = 0; singer < this.runtimes.length; singer += 1) {
            this.wasm.choir_audio_runtime_ramp_output_gain_q15(
              this.runtimes[singer],
              this.nodeGains[singer],
              384,
            );
          }
        }
        this.previous.fill(0);
        this.current.fill(0);
        this.resamplePhase = sampleRate;
      } else if (data.type === "play") {
        if (this.live) return;
        this.pauseFrames = 0;
        this.playing = true;
        this.ending = false;
        for (let singer = 0; singer < this.runtimes.length; singer += 1) {
          const runtime = this.runtimes[singer];
          this.wasm.choir_audio_runtime_play(runtime);
          this.wasm.choir_audio_runtime_set_output_gain_q15(runtime, 0);
          this.wasm.choir_audio_runtime_ramp_output_gain_q15(
            runtime,
            this.nodeGains[singer],
            data.fadeSamples,
          );
        }
      } else if (data.type === "external-playing") {
        if (this.live || !this.gnuPackages.length || Boolean(data.playing) === this.playing) return;
        const fadeSamples = 6000;
        if (data.playing) {
          let seekSample = null;
          if (Number.isInteger(data.positionSample) && data.positionSample >= 0) {
            seekSample = data.positionSample;
            this.gnuPositionExplicit = true;
          } else if (!this.gnuHasStarted && !this.gnuPositionExplicit && this.gnuEntrySample) {
            seekSample = this.gnuEntrySample;
          }
          if (seekSample !== null) {
            for (const runtime of this.runtimes) {
              this.wasm.choir_audio_runtime_seek(runtime, seekSample);
            }
          }
          this.gnuHasStarted = true;
          this.pauseFrames = 0;
          this.playing = true;
          this.ending = false;
          for (let singer = 0; singer < this.runtimes.length; singer += 1) {
            const runtime = this.runtimes[singer];
            this.wasm.choir_audio_runtime_play(runtime);
            this.wasm.choir_audio_runtime_set_output_gain_q15(runtime, 0);
            this.wasm.choir_audio_runtime_ramp_output_gain_q15(
              runtime, this.nodeGains[singer], fadeSamples,
            );
          }
        } else {
          this.ending = false;
          this.pauseFrames = fadeSamples;
          for (const runtime of this.runtimes) {
            this.wasm.choir_audio_runtime_ramp_output_gain_q15(runtime, 0, fadeSamples);
          }
        }
      } else if (data.type === "pause") {
        if (this.live) {
          if (this.liveEngine === "gnu") {
            const status = this.enqueueGnuLiveEvent({ op: 3, tone: 0 }, 0);
            if (status !== 0) throw new Error(`GNU live pause failed (${status})`);
            this.liveActive.fill(false);
            this.liveRendering.fill(true);
            this.playing = false;
            return;
          }
          for (const runtime of this.runtimes) {
            this.wasm.choir_audio_runtime_live_all_notes_off(runtime, data.fadeSamples);
          }
          this.liveActive.fill(false);
          this.playing = false;
          return;
        }
        this.ending = false;
        this.pauseFrames = data.fadeSamples;
        for (const runtime of this.runtimes) {
          this.wasm.choir_audio_runtime_ramp_output_gain_q15(runtime, 0, data.fadeSamples);
        }
        if (!this.pauseFrames) this.finishPause();
      } else if (data.type === "endFade") {
        this.ending = true;
        for (const runtime of this.runtimes) {
          this.wasm.choir_audio_runtime_ramp_output_gain_q15(runtime, 0, data.fadeSamples);
        }
      } else if (data.type === "cancelEndFade") {
        this.ending = false;
        if (this.playing && !this.pauseFrames) {
          for (let singer = 0; singer < this.runtimes.length; singer += 1) {
            this.wasm.choir_audio_runtime_ramp_output_gain_q15(
              this.runtimes[singer],
              this.nodeGains[singer],
              data.frames,
            );
          }
        }
      }
    } catch (error) {
      this.port.postMessage({ type: "error", message: error.message, requestId: data.requestId });
    }
  }

  finishPause() {
    for (const runtime of this.runtimes) this.wasm.choir_audio_runtime_pause(runtime);
    this.pauseFrames = 0;
    this.playing = false;
    this.ending = false;
  }

  enqueueGnuLiveEvent({
    op, tone = 0, generation = 0, sourceSerial = 0, cueId = 0,
    midi = 0, velocity = 0, continuation = false,
    parameterId = 0, parameterValue = 0,
  }, physicalSinger) {
    const view = new DataView(this.wasm.memory.buffer, this.gnuLiveEventPointer, 32);
    view.setBigUint64(0, 0n, true);
    view.setUint32(8, generation >>> 0, true);
    view.setUint32(12, sourceSerial >>> 0, true);
    view.setUint16(16, cueId, true);
    view.setUint8(18, op);
    view.setUint8(19, tone);
    view.setUint8(20, midi);
    view.setUint8(21, velocity);
    view.setUint8(22, continuation ? 1 : 0);
    view.setUint8(23, 0);
    view.setUint32(24, parameterId >>> 0, true);
    view.setFloat32(28, Number(parameterValue) || 0, true);
    return this.wasm.choir_gnu_live_enqueue_routed(
      this.gnuLivePointer, this.gnuLiveEventPointer, physicalSinger,
    );
  }

  advanceCanonicalSample(outputFrame = 0) {
    if (this.live) {
      if (this.liveEngine === "gnu") {
        if (this.wasm.choir_gnu_live_render_routed(
          this.gnuLivePointer, this.gnuLiveOutputPointer, 1,
        ) !== 1) {
          this.current.fill(0);
          return;
        }
        const output = this.gnuLiveOutputView;
        for (let singer = 0; singer < SINGER_COUNT; singer += 1) {
          if (this.liveGainRemaining[singer] > 0) {
            this.liveGainCurrent[singer] +=
              (this.liveGainTarget[singer] - this.liveGainCurrent[singer]) /
              this.liveGainRemaining[singer];
            this.liveGainRemaining[singer] -= 1;
          } else {
            this.liveGainCurrent[singer] = this.liveGainTarget[singer];
          }
          const scaled = Math.round(output[singer] * 32768 *
            this.liveGainCurrent[singer] / Q15);
          this.previous[singer] = this.current[singer];
          this.current[singer] = this.wasm.choir_audio_runtime_mix_live_device_sample(scaled);
        }
        for (let tone = 0; tone < this.liveOnsetProbes.length; tone += 1) {
          const probe = this.liveOnsetProbes[tone];
          if (!probe || !this.liveActive[tone]) continue;
          const singer = this.livePhysicalSinger[tone];
          if (singer < 0 || Math.abs(this.current[singer]) < 32) continue;
          this.port.postMessage({
            type: "live-onset",
            probeId: probe.probeId,
            commandFrame: probe.commandFrame,
            renderFrame: (typeof currentFrame === "number" ? currentFrame : 0) + outputFrame,
            f1Hz: 500,
            f2Hz: 1500,
          });
          this.liveOnsetProbes[tone] = null;
        }
        this.captureDebugSample();
        return;
      }
      const sums = this.liveSums;
      sums.fill(0);
      for (let tone = 0; tone < this.runtimes.length; tone += 1) {
        if (!this.liveRendering[tone]) continue;
        this.runtimePrevious[tone] = this.runtimeCurrent[tone];
        this.runtimeCurrent[tone] = this.wasm.choir_audio_runtime_next(this.runtimes[tone]);
        const runtimeActive = Boolean(
          this.wasm.choir_audio_runtime_live_is_active(this.runtimes[tone]),
        );
        const probe = this.liveOnsetProbes[tone];
        if (probe && Math.abs(this.runtimeCurrent[tone]) >= 32) {
          this.port.postMessage({
            type: "live-onset",
            probeId: probe.probeId,
            commandFrame: probe.commandFrame,
            renderFrame: (typeof currentFrame === "number" ? currentFrame : 0) + outputFrame,
            f1Hz: this.wasm.choir_audio_runtime_debug_value(this.runtimes[tone], 26),
            f2Hz: this.wasm.choir_audio_runtime_debug_value(this.runtimes[tone], 27),
          });
          this.liveOnsetProbes[tone] = null;
        }
        if (!runtimeActive) {
          this.liveRendering[tone] = false;
          this.runtimePrevious[tone] = 0;
          this.runtimeCurrent[tone] = 0;
          this.liveOnsetProbes[tone] = null;
          continue;
        }
        const singer = this.livePhysicalSinger[tone];
        if (singer < 0 || singer >= SINGER_COUNT) continue;
        sums[singer] += this.runtimeCurrent[tone];
      }
      for (let singer = 0; singer < SINGER_COUNT; singer += 1) {
        this.previous[singer] = this.current[singer];
        this.current[singer] = this.wasm.choir_audio_runtime_mix_live_device_sample(
          sums[singer],
        );
      }
      this.captureDebugSample();
      return;
    }
    for (let singer = 0; singer < Math.min(SINGER_COUNT, this.runtimes.length); singer += 1) {
      this.previous[singer] = this.current[singer];
      this.current[singer] = this.wasm.choir_audio_runtime_next(this.runtimes[singer]);
      const pending = this.pendingAssignments[singer];
      if (pending && --pending.remaining <= 0) {
        const status = this.wasm.choir_audio_runtime_select_score_voice(
          this.runtimes[singer],
          pending.scoreVoice,
        );
        if (status !== 0) {
          this.port.postMessage({
            type: "error",
            message: `Canonical voice assignment failed (${status})`,
          });
        }
        if (!this.ending && this.playing) {
          this.wasm.choir_audio_runtime_ramp_output_gain_q15(
            this.runtimes[singer],
            this.nodeGains[singer],
            384,
          );
        } else {
          this.wasm.choir_audio_runtime_set_output_gain_q15(this.runtimes[singer], 0);
        }
        this.pendingAssignments[singer] = null;
      }
    }
    this.captureDebugSample();
    if (this.pauseFrames > 0) {
      this.pauseFrames -= 1;
      if (!this.pauseFrames) this.finishPause();
    }
  }

  captureDebugSample() {
    if (!this.debugMask || !this.runtimes.length) return;
    let mixed = 0;
    let selectedCount = 0;
    for (let singer = 0; singer < Math.min(SINGER_COUNT, this.runtimes.length); singer += 1) {
      if (!(this.debugMask & (1 << singer))) continue;
      mixed += this.current[singer];
      selectedCount += 1;
    }
    if (!selectedCount) return;
    this.debugSamples[this.debugSampleIndex] = Math.max(
      -32767,
      Math.min(32767, Math.round(mixed / selectedCount)),
    );
    this.debugSampleIndex += 1;
    if (this.debugSampleIndex < DEBUG_BLOCK_SAMPLES) return;

    const samples = this.debugSamples;
    const telemetry = [];
    for (let singer = 0; singer < Math.min(SINGER_COUNT, this.runtimes.length); singer += 1) {
      if (!(this.debugMask & (1 << singer))) continue;
      const runtime = this.runtimes[singer];
      const values = new Int32Array(DEBUG_FIELD_COUNT);
      for (let field = 0; field < DEBUG_FIELD_COUNT; field += 1) {
        values[field] = this.wasm.choir_audio_runtime_debug_value(runtime, field);
      }
      telemetry.push({ singer, values });
    }
    this.debugSamples = new Int16Array(DEBUG_BLOCK_SAMPLES);
    this.debugSampleIndex = 0;
    this.port.postMessage({
      type: "debug-frame",
      sampleRate: CANONICAL_RATE,
      positionSample: this.wasm.choir_audio_runtime_position_sample(this.runtimes[0]),
      mask: this.debugMask,
      samples,
      telemetry,
    }, [samples.buffer, ...telemetry.map(({ values }) => values.buffer)]);
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    if (!channels || !this.loaded) return true;
    const mono = channels.length === 1;
    for (let frame = 0; frame < channels[0].length; frame += 1) {
      while (this.resamplePhase >= sampleRate) {
        this.resamplePhase -= sampleRate;
        this.advanceCanonicalSample(frame);
      }
      const fraction = this.resamplePhase / sampleRate;
      if (mono) {
        let mixed = 0;
        for (let singer = 0; singer < SINGER_COUNT; singer += 1) {
          mixed += this.previous[singer] +
            (this.current[singer] - this.previous[singer]) * fraction;
        }
        channels[0][frame] = mixed / 32768;
      } else {
        for (let singer = 0; singer < channels.length; singer += 1) {
          channels[singer][frame] = (
            this.previous[singer] +
            (this.current[singer] - this.previous[singer]) * fraction
          ) / 32768;
        }
      }
      this.resamplePhase += CANONICAL_RATE;
    }
    this.reportCounter += channels[0].length;
    if (this.reportCounter >= 2048 && this.runtimes.length) {
      this.reportCounter = 0;
      const first = this.runtimes[0];
      const status = new Uint32Array(this.wasm.memory.buffer, this.statusPointer, 18);
      if (this.wasm.choir_audio_runtime_write_display_status(first, this.statusPointer, 18) === 0 &&
          status[17] === 2) {
        const scorePositionQ16 = status[2] + status[3] * 4294967296;
        const outputSamplePosition = status[0] + status[1] * 4294967296;
        const durationSamples = status[4];
        const playing = status[14] !== 0;
        const ended = status[16] !== 0;
        const singers = this.runtimes.slice(0, SINGER_COUNT).map((runtime, node) => {
          if (this.wasm.choir_audio_runtime_write_display_status(runtime, this.statusPointer, 18) !== 0) {
            return {
              node, active: false, midi: 0, velocity: 0, cueId: 0, phoneId: 0,
              sourcePartIndex: -1, canonicalVoiceIndex: -1,
            };
          }
          return {
            node,
            active: status[15] !== 0,
            midi: status[12],
            velocity: status[13],
            cueId: status[10],
            phoneId: status[11],
            sourcePartIndex: status[6],
            canonicalVoiceIndex: status[7],
          };
        });
        this.port.postMessage({
          type: "gnu-display-snapshot",
          generation: this.loadGeneration,
          scorePositionQ16,
          tempoQ16: this.tempoQ16,
          outputSamplePosition,
          durationSamples: this.gnuDurationSamples || durationSamples,
          renderEndSample: durationSamples,
          playing,
          ended,
          singers,
        });
      }
      this.port.postMessage({
        type: "position",
        sample: this.wasm.choir_audio_runtime_position_sample(this.runtimes[0]),
        playing: this.playing,
        expressions: Array.from({ length: SINGER_COUNT }, (_, singer) => {
          const primary = this.runtimes[singer];
          return {
            active: primary ? this.wasm.choir_audio_runtime_debug_value(primary, 0) : 0,
            f1Hz: primary ? this.wasm.choir_audio_runtime_debug_value(primary, 26) : 0,
            f2Hz: primary ? this.wasm.choir_audio_runtime_debug_value(primary, 27) : 0,
          };
        }),
      });
    }
    return true;
  }
}

registerProcessor("choir-canonical-audio-v1", ChoirCanonicalAudioProcessor);
