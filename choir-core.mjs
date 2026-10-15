// This code implements the `-sMODULARIZE` settings by taking the generated
// JS program code (INNER_JS_CODE) and wrapping it in a factory function.

// When targetting node and ES6 we use `await import ..` in the generated code
// so the outer function needs to be marked as async.
async function Module(moduleArg = {}) {
  var moduleRtn;

// include: shell.js
// include: minimum_runtime_check.js
// end include: minimum_runtime_check.js
// The Module object: Our interface to the outside world. We import
// and export values on it. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(moduleArg) => Promise<Module>
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to check if Module already exists (e.g. case 3 above).
// Substitution will be replaced with actual code on later stage of the build,
// this way Closure Compiler will not mangle it (e.g. case 4. above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module = moduleArg;

// Determine the runtime environment we are in. You can customize this by
// setting the ENVIRONMENT setting at compile time (see settings.js).
// Attempt to auto-detect the environment
var ENVIRONMENT_IS_WEB = !!globalThis.window;

var ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope;

// N.b. Electron.js environment is simultaneously a NODE-environment, but
// also a web environment.
var ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";

if (ENVIRONMENT_IS_NODE) {
  // When building an ES module `require` is not normally available.
  // We need to use `createRequire()` to construct the require()` function.
  const {createRequire} = await import("module");
  /** @suppress{duplicate} */ var require = createRequire(import.meta.url);
}

// --pre-jses are emitted after the Module integration code, so that they can
// refer to Module (if they choose; they can also define Module)
var arguments_ = [];

var thisProgram = "./this.program";

var quit_ = (status, toThrow) => {
  throw toThrow;
};

var _scriptName = import.meta.url;

// `/` should be present at the end if `scriptDirectory` is not empty
var scriptDirectory = "";

function locateFile(path) {
  if (Module["locateFile"]) {
    return Module["locateFile"](path, scriptDirectory);
  }
  return scriptDirectory + path;
}

// Hooks that are implemented differently in different runtime environments.
var readAsync, readBinary;

if (ENVIRONMENT_IS_NODE) {
  // These modules will usually be used on Node.js. Load them eagerly to avoid
  // the complexity of lazy-loading.
  var fs = require("fs");
  if (_scriptName.startsWith("file:")) {
    scriptDirectory = require("path").dirname(require("url").fileURLToPath(_scriptName)) + "/";
  }
  // include: node_shell_read.js
  readBinary = filename => {
    // We need to re-wrap `file://` strings to URLs.
    filename = isFileURI(filename) ? new URL(filename) : filename;
    var ret = fs.readFileSync(filename);
    return ret;
  };
  readAsync = async (filename, binary = true) => {
    // See the comment in the `readBinary` function.
    filename = isFileURI(filename) ? new URL(filename) : filename;
    var ret = fs.readFileSync(filename, binary ? undefined : "utf8");
    return ret;
  };
  // end include: node_shell_read.js
  if (process.argv.length > 1) {
    thisProgram = process.argv[1].replace(/\\/g, "/");
  }
  arguments_ = process.argv.slice(2);
  quit_ = (status, toThrow) => {
    process.exitCode = status;
    throw toThrow;
  };
} else // Note that this includes Node.js workers when relevant (pthreads is enabled).
// Node.js workers are detected as a combination of ENVIRONMENT_IS_WORKER and
// ENVIRONMENT_IS_NODE.
if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  try {
    scriptDirectory = new URL(".", _scriptName).href;
  } catch {}
  {
    // include: web_or_worker_shell_read.js
    readAsync = async url => {
      var response = await fetch(url, {
        credentials: "same-origin"
      });
      if (response.ok) {
        return response.arrayBuffer();
      }
      throw new Error(response.status + " : " + response.url);
    };
  }
} else {}

var out = console.log.bind(console);

var err = console.error.bind(console);

// end include: shell.js
// include: preamble.js
// === Preamble library stuff ===
// Documentation for the public APIs defined in this file must be updated in:
//    site/source/docs/api_reference/preamble.js.rst
// A prebuilt local version of the documentation is available at:
//    site/build/text/docs/api_reference/preamble.js.txt
// You can also build docs locally as HTML or other formats in site/
// An online HTML version (which may be of a different version of Emscripten)
//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html
var wasmBinary;

// Wasm globals
//========================================
// Runtime essentials
//========================================
// whether we are quitting the application. no code should run after this.
// set in exit() and abort()
var ABORT = false;

/**
 * Indicates whether filename is delivered via file protocol (as opposed to http/https)
 * @noinline
 */ var isFileURI = filename => filename.startsWith("file://");

// include: runtime_common.js
// include: runtime_stack_check.js
// end include: runtime_stack_check.js
// include: runtime_exceptions.js
// end include: runtime_exceptions.js
// include: runtime_debug.js
// end include: runtime_debug.js
var readyPromiseResolve, readyPromiseReject;

// Memory management
var /** @type {!Int8Array} */ HEAP8, /** @type {!Uint8Array} */ HEAPU8, /** @type {!Int16Array} */ HEAP16, /** @type {!Uint16Array} */ HEAPU16, /** @type {!Int32Array} */ HEAP32, /** @type {!Uint32Array} */ HEAPU32, /** @type {!Float32Array} */ HEAPF32, /** @type {!Float64Array} */ HEAPF64;

// BigInt64Array type is not correctly defined in closure
var /** not-@type {!BigInt64Array} */ HEAP64, /* BigUint64Array type is not correctly defined in closure
/** not-@type {!BigUint64Array} */ HEAPU64;

var runtimeInitialized = false;

function updateMemoryViews() {
  var b = wasmMemory.buffer;
  Module["HEAP8"] = HEAP8 = new Int8Array(b);
  Module["HEAP16"] = HEAP16 = new Int16Array(b);
  Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
  Module["HEAPU16"] = HEAPU16 = new Uint16Array(b);
  Module["HEAP32"] = HEAP32 = new Int32Array(b);
  Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
  HEAPF32 = new Float32Array(b);
  HEAPF64 = new Float64Array(b);
  HEAP64 = new BigInt64Array(b);
  HEAPU64 = new BigUint64Array(b);
}

// include: memoryprofiler.js
// end include: memoryprofiler.js
// end include: runtime_common.js
function preRun() {
  if (Module["preRun"]) {
    if (typeof Module["preRun"] == "function") Module["preRun"] = [ Module["preRun"] ];
    while (Module["preRun"].length) {
      addOnPreRun(Module["preRun"].shift());
    }
  }
  // Begin ATPRERUNS hooks
  callRuntimeCallbacks(onPreRuns);
}

function initRuntime() {
  runtimeInitialized = true;
  // No ATINITS hooks
  wasmExports["c"]();
}

function postRun() {
  // PThreads reuse the runtime from the main thread.
  if (Module["postRun"]) {
    if (typeof Module["postRun"] == "function") Module["postRun"] = [ Module["postRun"] ];
    while (Module["postRun"].length) {
      addOnPostRun(Module["postRun"].shift());
    }
  }
  // Begin ATPOSTRUNS hooks
  callRuntimeCallbacks(onPostRuns);
}

/** @param {string|number=} what */ function abort(what) {
  Module["onAbort"]?.(what);
  what = "Aborted(" + what + ")";
  // TODO(sbc): Should we remove printing and leave it up to whoever
  // catches the exception?
  err(what);
  ABORT = true;
  what += ". Build with -sASSERTIONS for more info.";
  // Use a wasm runtime error, because a JS error might be seen as a foreign
  // exception, which means we'd run destructors on it. We need the error to
  // simply make the program stop.
  // FIXME This approach does not work in Wasm EH because it currently does not assume
  // all RuntimeErrors are from traps; it decides whether a RuntimeError is from
  // a trap or not based on a hidden field within the object. So at the moment
  // we don't have a way of throwing a wasm trap from JS. TODO Make a JS API that
  // allows this in the wasm spec.
  // Suppress closure compiler warning here. Closure compiler's builtin extern
  // definition for WebAssembly.RuntimeError claims it takes no arguments even
  // though it can.
  // TODO(https://github.com/google/closure-compiler/pull/3913): Remove if/when upstream closure gets fixed.
  /** @suppress {checkTypes} */ var e = new WebAssembly.RuntimeError(what);
  readyPromiseReject?.(e);
  // Throw the error whether or not MODULARIZE is set because abort is used
  // in code paths apart from instantiation where an exception is expected
  // to be thrown when abort is called.
  throw e;
}

var wasmBinaryFile;

function findWasmBinary() {
  if (Module["locateFile"]) {
    return locateFile("choir-core.wasm");
  }
  // Use bundler-friendly `new URL(..., import.meta.url)` pattern; works in browsers too.
  return new URL("choir-core.wasm", import.meta.url).href;
}

function getBinarySync(file) {
  if (file == wasmBinaryFile && wasmBinary) {
    return new Uint8Array(wasmBinary);
  }
  if (readBinary) {
    return readBinary(file);
  }
  // Throwing a plain string here, even though it not normally adviables since
  // this gets turning into an `abort` in instantiateArrayBuffer.
  throw "both async and sync fetching of the wasm failed";
}

async function getWasmBinary(binaryFile) {
  // If we don't have the binary yet, load it asynchronously using readAsync.
  if (!wasmBinary) {
    // Fetch the binary using readAsync
    try {
      var response = await readAsync(binaryFile);
      return new Uint8Array(response);
    } catch {}
  }
  // Otherwise, getBinarySync should be able to get it synchronously
  return getBinarySync(binaryFile);
}

async function instantiateArrayBuffer(binaryFile, imports) {
  try {
    var binary = await getWasmBinary(binaryFile);
    var instance = await WebAssembly.instantiate(binary, imports);
    return instance;
  } catch (reason) {
    err(`failed to asynchronously prepare wasm: ${reason}`);
    abort(reason);
  }
}

async function instantiateAsync(binary, binaryFile, imports) {
  if (!binary && !ENVIRONMENT_IS_NODE) {
    try {
      var response = fetch(binaryFile, {
        credentials: "same-origin"
      });
      var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
      return instantiationResult;
    } catch (reason) {
      // We expect the most common failure cause to be a bad MIME type for the binary,
      // in which case falling back to ArrayBuffer instantiation should work.
      err(`wasm streaming compile failed: ${reason}`);
      err("falling back to ArrayBuffer instantiation");
    }
  }
  return instantiateArrayBuffer(binaryFile, imports);
}

function getWasmImports() {
  // prepare imports
  var imports = {
    "a": wasmImports
  };
  return imports;
}

// Create the wasm instance.
// Receives the wasm imports, returns the exports.
async function createWasm() {
  // Load the wasm module and create an instance of using native support in the JS engine.
  // handle a generated wasm instance, receiving its exports and
  // performing other necessary setup
  /** @param {WebAssembly.Module=} module*/ function receiveInstance(instance, module) {
    wasmExports = instance.exports;
    assignWasmExports(wasmExports);
    updateMemoryViews();
    return wasmExports;
  }
  // Prefer streaming instantiation if available.
  function receiveInstantiationResult(result) {
    // 'result' is a ResultObject object which has both the module and instance.
    // receiveInstance() will swap in the exports (to Module.asm) so they can be called
    // TODO: Due to Closure regression https://github.com/google/closure-compiler/issues/3193, the above line no longer optimizes out down to the following line.
    // When the regression is fixed, can restore the above PTHREADS-enabled path.
    return receiveInstance(result["instance"]);
  }
  var info = getWasmImports();
  // User shell pages can write their own Module.instantiateWasm = function(imports, successCallback) callback
  // to manually instantiate the Wasm module themselves. This allows pages to
  // run the instantiation parallel to any other async startup actions they are
  // performing.
  // Also pthreads and wasm workers initialize the wasm instance through this
  // path.
  if (Module["instantiateWasm"]) {
    return new Promise((resolve, reject) => {
      Module["instantiateWasm"](info, (inst, mod) => {
        resolve(receiveInstance(inst, mod));
      });
    });
  }
  wasmBinaryFile ??= findWasmBinary();
  var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
  var exports = receiveInstantiationResult(result);
  return exports;
}

// end include: preamble.js
// Begin JS library code
class ExitStatus {
  name="ExitStatus";
  constructor(status) {
    this.message = `Program terminated with exit(${status})`;
    this.status = status;
  }
}

var callRuntimeCallbacks = callbacks => {
  while (callbacks.length > 0) {
    // Pass the module as the first argument.
    callbacks.shift()(Module);
  }
};

var onPostRuns = [];

var addOnPostRun = cb => onPostRuns.push(cb);

var onPreRuns = [];

var addOnPreRun = cb => onPreRuns.push(cb);

var noExitRuntime = true;

var getHeapMax = () => // Stay one Wasm page short of 4GB: while e.g. Chrome is able to allocate
// full 4GB Wasm memories, the size will wrap back to 0 bytes in Wasm side
// for any code that deals with heap sizes, which would require special
// casing all heap size related code to treat 0 specially.
2147483648;

var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;

var growMemory = size => {
  var oldHeapSize = wasmMemory.buffer.byteLength;
  var pages = ((size - oldHeapSize + 65535) / 65536) | 0;
  try {
    // round size grow request up to wasm page size (fixed 64KB per spec)
    wasmMemory.grow(pages);
    // .grow() takes a delta compared to the previous size
    updateMemoryViews();
    return 1;
  } catch (e) {}
};

var _emscripten_resize_heap = requestedSize => {
  var oldSize = HEAPU8.length;
  // With CAN_ADDRESS_2GB or MEMORY64, pointers are already unsigned.
  requestedSize >>>= 0;
  // With multithreaded builds, races can happen (another thread might increase the size
  // in between), so return a failure, and let the caller retry.
  // Memory resize rules:
  // 1.  Always increase heap size to at least the requested size, rounded up
  //     to next page multiple.
  // 2a. If MEMORY_GROWTH_LINEAR_STEP == -1, excessively resize the heap
  //     geometrically: increase the heap size according to
  //     MEMORY_GROWTH_GEOMETRIC_STEP factor (default +20%), At most
  //     overreserve by MEMORY_GROWTH_GEOMETRIC_CAP bytes (default 96MB).
  // 2b. If MEMORY_GROWTH_LINEAR_STEP != -1, excessively resize the heap
  //     linearly: increase the heap size by at least
  //     MEMORY_GROWTH_LINEAR_STEP bytes.
  // 3.  Max size for the heap is capped at 2048MB-WASM_PAGE_SIZE, or by
  //     MAXIMUM_MEMORY, or by ASAN limit, depending on which is smallest
  // 4.  If we were unable to allocate as much memory, it may be due to
  //     over-eager decision to excessively reserve due to (3) above.
  //     Hence if an allocation fails, cut down on the amount of excess
  //     growth, in an attempt to succeed to perform a smaller allocation.
  // A limit is set for how much we can grow. We should not exceed that
  // (the wasm binary specifies it, so if we tried, we'd fail anyhow).
  var maxHeapSize = getHeapMax();
  if (requestedSize > maxHeapSize) {
    return false;
  }
  // Loop through potential heap size increases. If we attempt a too eager
  // reservation that fails, cut down on the attempted size and reserve a
  // smaller bump instead. (max 3 times, chosen somewhat arbitrarily)
  for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
    var overGrownHeapSize = oldSize * (1 + .2 / cutDown);
    // ensure geometric growth
    // but limit overreserving (default to capping at +96MB overgrowth at most)
    overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
    var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
    var replacement = growMemory(newSize);
    if (replacement) {
      return true;
    }
  }
  return false;
};

// End JS library code
// include: postlibrary.js
// This file is included after the automatically-generated JS library code
// but before the wasm module is created.
{
  // Begin ATMODULES hooks
  if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
  if (Module["print"]) out = Module["print"];
  if (Module["printErr"]) err = Module["printErr"];
  if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
  // End ATMODULES hooks
  if (Module["arguments"]) arguments_ = Module["arguments"];
  if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
  if (Module["preInit"]) {
    if (typeof Module["preInit"] == "function") Module["preInit"] = [ Module["preInit"] ];
    while (Module["preInit"].length > 0) {
      Module["preInit"].shift()();
    }
  }
}

// Begin runtime exports
// End runtime exports
// Begin JS library exports
// End JS library exports
// end include: postlibrary.js
// Imports from the Wasm binary.
var _choir_midi_unload, _choir_reset, _choir_score_unload, _choir_score_load, _choir_midi_load, _choir_midi_start, _choir_midi_pause, _choir_midi_rewind, _choir_midi_seek, _choir_tick, _choir_event, _choir_set_input, _choir_set_live_visual_enabled, _choir_set_live_visual_note, _choir_set_screen_reveal_ms, _choir_set_screen_long_hold_ms, _choir_set_mouth_transition_ms, _choir_set_ui_mode, _choir_set_all_ui_modes, _choir_set_face_style, _choir_song_set_catalog, _choir_song_set_title, _choir_song_catalog_revision, _choir_song_catalog_count, _choir_song_title_byte, _choir_song_set_player, _choir_song_get_player, _choir_song_command_clear, _choir_song_command_push, _choir_song_command_count, _choir_song_command_overflow_count, _choir_song_command_peek_type, _choir_song_command_peek_node, _choir_song_command_peek_value, _choir_song_command_peek_revision, _choir_song_command_pop, _choir_song_seek_pending, _choir_song_seek_q15, _choir_song_seek_node, _choir_song_seek_revision, _choir_song_seek_clear, _choir_set_score_param, _choir_screen_press_begin, _choir_screen_press_update, _choir_screen_press_update_at, _choir_screen_scroll, _choir_screen_press_cancel, _choir_screen_press_end, _choir_screen_press, _choir_get_value, _choir_get_framebuffer, _choir_get_rgba_framebuffer, _choir_get_frame_hash, _choir_get_width, _choir_get_height, _choir_render, _choir_sync_sizeof, _choir_sync_init, _choir_sync_leader_time, _choir_sync_observe, _choir_sync_update_playback, _choir_sync_is_locked, _choir_sync_clock_error_us, _choir_sync_playback_error_us, _choir_sync_skew_ppm, _choir_sync_rate_adjust_ppm, _choir_live_midi_sizeof, _choir_live_midi_init, _choir_live_midi_reset, _choir_live_midi_set_chord_window_ms, _choir_live_midi_set_channel, _choir_live_midi_set_transpose, _choir_live_midi_flush, _choir_live_midi_message, _choir_live_midi_has_pending, _choir_live_midi_next_deadline_ms, _choir_live_midi_held_pitch_count, _choir_live_midi_get_singer_value, _choir_live_midi_get_tone_value, _choir_live_midi_write_snapshot, _malloc, _free, memory, __indirect_function_table, wasmMemory;

function assignWasmExports(wasmExports) {
  _choir_midi_unload = Module["_choir_midi_unload"] = wasmExports["d"];
  _choir_reset = Module["_choir_reset"] = wasmExports["e"];
  _choir_score_unload = Module["_choir_score_unload"] = wasmExports["f"];
  _choir_score_load = Module["_choir_score_load"] = wasmExports["g"];
  _choir_midi_load = Module["_choir_midi_load"] = wasmExports["h"];
  _choir_midi_start = Module["_choir_midi_start"] = wasmExports["i"];
  _choir_midi_pause = Module["_choir_midi_pause"] = wasmExports["j"];
  _choir_midi_rewind = Module["_choir_midi_rewind"] = wasmExports["k"];
  _choir_midi_seek = Module["_choir_midi_seek"] = wasmExports["l"];
  _choir_tick = Module["_choir_tick"] = wasmExports["m"];
  _choir_event = Module["_choir_event"] = wasmExports["n"];
  _choir_set_input = Module["_choir_set_input"] = wasmExports["o"];
  _choir_set_live_visual_enabled = Module["_choir_set_live_visual_enabled"] = wasmExports["p"];
  _choir_set_live_visual_note = Module["_choir_set_live_visual_note"] = wasmExports["q"];
  _choir_set_screen_reveal_ms = Module["_choir_set_screen_reveal_ms"] = wasmExports["r"];
  _choir_set_screen_long_hold_ms = Module["_choir_set_screen_long_hold_ms"] = wasmExports["s"];
  _choir_set_mouth_transition_ms = Module["_choir_set_mouth_transition_ms"] = wasmExports["t"];
  _choir_set_ui_mode = Module["_choir_set_ui_mode"] = wasmExports["u"];
  _choir_set_all_ui_modes = Module["_choir_set_all_ui_modes"] = wasmExports["v"];
  _choir_set_face_style = Module["_choir_set_face_style"] = wasmExports["w"];
  _choir_song_set_catalog = Module["_choir_song_set_catalog"] = wasmExports["x"];
  _choir_song_set_title = Module["_choir_song_set_title"] = wasmExports["y"];
  _choir_song_catalog_revision = Module["_choir_song_catalog_revision"] = wasmExports["z"];
  _choir_song_catalog_count = Module["_choir_song_catalog_count"] = wasmExports["A"];
  _choir_song_title_byte = Module["_choir_song_title_byte"] = wasmExports["B"];
  _choir_song_set_player = Module["_choir_song_set_player"] = wasmExports["C"];
  _choir_song_get_player = Module["_choir_song_get_player"] = wasmExports["D"];
  _choir_song_command_clear = Module["_choir_song_command_clear"] = wasmExports["E"];
  _choir_song_command_push = Module["_choir_song_command_push"] = wasmExports["F"];
  _choir_song_command_count = Module["_choir_song_command_count"] = wasmExports["G"];
  _choir_song_command_overflow_count = Module["_choir_song_command_overflow_count"] = wasmExports["H"];
  _choir_song_command_peek_type = Module["_choir_song_command_peek_type"] = wasmExports["I"];
  _choir_song_command_peek_node = Module["_choir_song_command_peek_node"] = wasmExports["J"];
  _choir_song_command_peek_value = Module["_choir_song_command_peek_value"] = wasmExports["K"];
  _choir_song_command_peek_revision = Module["_choir_song_command_peek_revision"] = wasmExports["L"];
  _choir_song_command_pop = Module["_choir_song_command_pop"] = wasmExports["M"];
  _choir_song_seek_pending = Module["_choir_song_seek_pending"] = wasmExports["N"];
  _choir_song_seek_q15 = Module["_choir_song_seek_q15"] = wasmExports["O"];
  _choir_song_seek_node = Module["_choir_song_seek_node"] = wasmExports["P"];
  _choir_song_seek_revision = Module["_choir_song_seek_revision"] = wasmExports["Q"];
  _choir_song_seek_clear = Module["_choir_song_seek_clear"] = wasmExports["R"];
  _choir_set_score_param = Module["_choir_set_score_param"] = wasmExports["S"];
  _choir_screen_press_begin = Module["_choir_screen_press_begin"] = wasmExports["T"];
  _choir_screen_press_update = Module["_choir_screen_press_update"] = wasmExports["U"];
  _choir_screen_press_update_at = Module["_choir_screen_press_update_at"] = wasmExports["V"];
  _choir_screen_scroll = Module["_choir_screen_scroll"] = wasmExports["W"];
  _choir_screen_press_cancel = Module["_choir_screen_press_cancel"] = wasmExports["X"];
  _choir_screen_press_end = Module["_choir_screen_press_end"] = wasmExports["Y"];
  _choir_screen_press = Module["_choir_screen_press"] = wasmExports["Z"];
  _choir_get_value = Module["_choir_get_value"] = wasmExports["_"];
  _choir_get_framebuffer = Module["_choir_get_framebuffer"] = wasmExports["$"];
  _choir_get_rgba_framebuffer = Module["_choir_get_rgba_framebuffer"] = wasmExports["aa"];
  _choir_get_frame_hash = Module["_choir_get_frame_hash"] = wasmExports["ba"];
  _choir_get_width = Module["_choir_get_width"] = wasmExports["ca"];
  _choir_get_height = Module["_choir_get_height"] = wasmExports["da"];
  _choir_render = Module["_choir_render"] = wasmExports["ea"];
  _choir_sync_sizeof = Module["_choir_sync_sizeof"] = wasmExports["fa"];
  _choir_sync_init = Module["_choir_sync_init"] = wasmExports["ga"];
  _choir_sync_leader_time = Module["_choir_sync_leader_time"] = wasmExports["ha"];
  _choir_sync_observe = Module["_choir_sync_observe"] = wasmExports["ia"];
  _choir_sync_update_playback = Module["_choir_sync_update_playback"] = wasmExports["ja"];
  _choir_sync_is_locked = Module["_choir_sync_is_locked"] = wasmExports["ka"];
  _choir_sync_clock_error_us = Module["_choir_sync_clock_error_us"] = wasmExports["la"];
  _choir_sync_playback_error_us = Module["_choir_sync_playback_error_us"] = wasmExports["ma"];
  _choir_sync_skew_ppm = Module["_choir_sync_skew_ppm"] = wasmExports["na"];
  _choir_sync_rate_adjust_ppm = Module["_choir_sync_rate_adjust_ppm"] = wasmExports["oa"];
  _choir_live_midi_sizeof = Module["_choir_live_midi_sizeof"] = wasmExports["pa"];
  _choir_live_midi_init = Module["_choir_live_midi_init"] = wasmExports["qa"];
  _choir_live_midi_reset = Module["_choir_live_midi_reset"] = wasmExports["ra"];
  _choir_live_midi_set_chord_window_ms = Module["_choir_live_midi_set_chord_window_ms"] = wasmExports["sa"];
  _choir_live_midi_set_channel = Module["_choir_live_midi_set_channel"] = wasmExports["ta"];
  _choir_live_midi_set_transpose = Module["_choir_live_midi_set_transpose"] = wasmExports["ua"];
  _choir_live_midi_flush = Module["_choir_live_midi_flush"] = wasmExports["va"];
  _choir_live_midi_message = Module["_choir_live_midi_message"] = wasmExports["wa"];
  _choir_live_midi_has_pending = Module["_choir_live_midi_has_pending"] = wasmExports["xa"];
  _choir_live_midi_next_deadline_ms = Module["_choir_live_midi_next_deadline_ms"] = wasmExports["ya"];
  _choir_live_midi_held_pitch_count = Module["_choir_live_midi_held_pitch_count"] = wasmExports["za"];
  _choir_live_midi_get_singer_value = Module["_choir_live_midi_get_singer_value"] = wasmExports["Aa"];
  _choir_live_midi_get_tone_value = Module["_choir_live_midi_get_tone_value"] = wasmExports["Ba"];
  _choir_live_midi_write_snapshot = Module["_choir_live_midi_write_snapshot"] = wasmExports["Ca"];
  _malloc = Module["_malloc"] = wasmExports["Da"];
  _free = Module["_free"] = wasmExports["Ea"];
  memory = wasmMemory = wasmExports["b"];
  __indirect_function_table = wasmExports["__indirect_function_table"];
}

var wasmImports = {
  /** @export */ a: _emscripten_resize_heap
};

// include: postamble.js
// === Auto-generated postamble setup entry stuff ===
function run() {
  preRun();
  function doRun() {
    // run may have just been called through dependencies being fulfilled just in this very frame,
    // or while the async setStatus time below was happening
    Module["calledRun"] = true;
    if (ABORT) return;
    initRuntime();
    readyPromiseResolve?.(Module);
    Module["onRuntimeInitialized"]?.();
    postRun();
  }
  if (Module["setStatus"]) {
    Module["setStatus"]("Running...");
    setTimeout(() => {
      setTimeout(() => Module["setStatus"](""), 1);
      doRun();
    }, 1);
  } else {
    doRun();
  }
}

var wasmExports;

// In modularize mode the generated code is within a factory function so we
// can use await here (since it's not top-level-await).
wasmExports = await (createWasm());

run();

// end include: postamble.js
// include: postamble_modularize.js
// In MODULARIZE mode we wrap the generated code in a factory function
// and return either the Module itself, or a promise of the module.
// We assign to the `moduleRtn` global here and configure closure to see
// this as and extern so it won't get minified.
if (runtimeInitialized) {
  moduleRtn = Module;
} else {
  // Set up the promise that indicates the Module is initialized
  moduleRtn = new Promise((resolve, reject) => {
    readyPromiseResolve = resolve;
    readyPromiseReject = reject;
  });
}


  return moduleRtn;
}

// Export using a UMD style export, or ES6 exports if selected
export default Module;

