const CANONICAL_RATE = 24000;
const SINGER_COUNT = 8;
const LIVE_TONE_COUNT = 16;
const Q15 = 32768;
const DEBUG_BLOCK_SAMPLES = 512;
const DEBUG_FIELD_COUNT = 19;

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
    this.loaded = false;
    this.live = false;
    this.liveActive = [];
    this.liveRendering = [];
    this.liveGeneration = [];
    this.livePhysicalSinger = [];
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
    for (const runtime of this.runtimes) {
      this.wasm.choir_audio_runtime_unload(runtime);
      this.wasm.free(runtime);
    }
    this.runtimes = [];
    if (this.scorePointer) this.wasm.free(this.scorePointer);
    this.scorePointer = 0;
    this.scoreSize = 0;
    this.loaded = false;
    this.live = false;
    this.liveActive.fill(false);
    this.liveRendering = [];
    this.liveGeneration = [];
    this.livePhysicalSinger = [];
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
    this.resamplePhase = sampleRate;
    this.previous.fill(0);
    this.current.fill(0);
    this.port.postMessage({ type: "loaded", requestId: data.requestId });
  }

  applyTone(singer, parameters) {
    if (!Number.isInteger(singer) || singer < 0 || singer >= SINGER_COUNT || !parameters) return;
    this.toneParameters[singer] = [...parameters];
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
    parameters.forEach((value, parameter) => {
      this.wasm.choir_audio_runtime_set_param(runtime, parameter, value);
    });
  }

  setGain(singer, gain, frames = 384) {
    if (!Number.isInteger(singer) || singer < 0 || singer >= SINGER_COUNT) return;
    const target = Math.max(0, Math.min(Q15, Math.round(gain)));
    this.nodeGains[singer] = target;
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
      else if (data.type === "unload") this.disposeScore();
      else if (data.type === "tone") this.applyTone(data.singer, data.parameters);
      else if (data.type === "debug") {
        this.debugMask = Math.max(0, Math.min(255, Math.round(data.mask || 0)));
        this.debugSampleIndex = 0;
      }
      else if (data.type === "tempo") {
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
            data.tone < 0 || data.tone >= this.runtimes.length ||
            !Number.isInteger(data.physicalSinger) ||
            data.physicalSinger < 0 || data.physicalSinger >= SINGER_COUNT) return;
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
            data.tone < 0 || data.tone >= this.runtimes.length ||
            this.liveGeneration[data.tone] !== (data.generation >>> 0)) return;
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
            data.fromTone < 0 || data.fromTone >= this.runtimes.length ||
            data.toTone < 0 || data.toTone >= this.runtimes.length ||
            !this.liveActive[data.fromTone] || this.liveActive[data.toTone] ||
            !Number.isInteger(data.physicalSinger) ||
            data.physicalSinger < 0 || data.physicalSinger >= SINGER_COUNT) return;
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
      } else if (data.type === "pause") {
        if (this.live) {
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

  advanceCanonicalSample(outputFrame = 0) {
    if (this.live) {
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
