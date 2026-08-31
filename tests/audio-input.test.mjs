import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canChangeAudioInput, createAudioCapture, describeCaptureFailure } from '../ui/audio-capture.mjs';

const root = new URL('..', import.meta.url);

function installRendererAudioStubs(getUserMedia, { onWorklet } = {}) {
  const original = {
    navigator: globalThis.navigator,
    AudioContext: globalThis.AudioContext,
    AudioWorkletNode: globalThis.AudioWorkletNode
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { mediaDevices: { getUserMedia, enumerateDevices: async () => [] } } });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: class {
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async close() {}
  } });
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, writable: true, value: class {
    constructor() { onWorklet?.(this); }
    port = { onmessage: null };
    connect() {}
    disconnect() {}
  } });
  return () => {
    if (original.navigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: original.navigator });
    if (original.AudioContext === undefined) delete globalThis.AudioContext;
    else Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: original.AudioContext });
    if (original.AudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, writable: true, value: original.AudioWorkletNode });
  };
}

test('pause closes the renderer boundary before delayed flush acceptance and resumes a new boundary', async () => {
  let worklet;
  let releaseFirstFlush;
  let firstFlushStarted;
  const flushStarted = new Promise((resolve) => { firstFlushStarted = resolve; });
  const chunks = [];
  const flushes = [];
  const restore = installRendererAudioStubs(async () => ({ getTracks: () => [{ stop() {} }] }), { onWorklet: (value) => { worklet = value; } });
  try {
    let first = true;
    const capture = createAudioCapture({
      pauseThresholdMs: 250,
      sendAudioChunk: async (chunk) => { chunks.push(chunk.sequence); },
      sendAudioFlush: async (payload) => {
        flushes.push(payload);
        if (!first) return;
        first = false;
        firstFlushStarted();
        await new Promise((resolve) => { releaseFirstFlush = resolve; });
      }
    });
    await capture.start('boundary-reset-session');
    const samples = (value) => worklet.port.onmessage({ data: new Float32Array(4096).fill(value) });

    samples(0.1);
    samples(0);
    await flushStarted;
    // The first flush is deliberately held. Resumed speech must be recognized
    // as a new boundary and queue a second flush instead of being suppressed.
    samples(0.1);
    samples(0);
    releaseFirstFlush();
    await capture.stop();

    assert.deepEqual(chunks, [0, 1, 2, 3]);
    assert.equal(flushes.length, 2);
    assert.deepEqual(flushes.map((flush) => flush.reason), ['pause', 'pause']);
  } finally {
    restore();
  }
});

test('same-session Stop/Resume preserves renderer chunk identity and the sample clock', async () => {
  let worklet;
  const chunks = [];
  const restore = installRendererAudioStubs(async () => ({ getTracks: () => [{ stop() {} }] }), { onWorklet: (value) => { worklet = value; } });
  try {
    const capture = createAudioCapture({ sendAudioChunk: async (chunk) => { chunks.push(chunk); } });
    await capture.start('stop-resume-identity-session');
    worklet.port.onmessage({ data: new Float32Array(4096).fill(0.1) });
    await capture.stop();

    await capture.start('stop-resume-identity-session');
    worklet.port.onmessage({ data: new Float32Array(4096).fill(0.2) });
    await capture.stop();

    assert.deepEqual(chunks.map((chunk) => [chunk.chunk_id, chunk.sequence, chunk.start_time, chunk.end_time]), [
      ['stop-resume-identity-session-chunk-0', 0, '00:00:00.000', '00:00:00.256'],
      ['stop-resume-identity-session-chunk-1', 1, '00:00:00.256', '00:00:00.512']
    ]);
  } finally {
    restore();
  }
});

test('the selected device ID reaches getUserMedia with the governed PCM capture settings', async () => {
  const calls = [];
  let trackStopped = false;
  const restore = installRendererAudioStubs(async (constraints) => {
    calls.push(constraints);
    return { getTracks: () => [{ stop: () => { trackStopped = true; } }] };
  });
  try {
    const capture = createAudioCapture({ sendAudioChunk: async () => {} });
    await capture.start('selected-device-session', 'windows-microphone-id');
    assert.deepEqual(calls, [{
      audio: {
        deviceId: { exact: 'windows-microphone-id' },
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    }]);
    await capture.stop();
    assert.equal(trackStopped, true);
  } finally {
    restore();
  }
});

test('an unavailable explicit selection produces a visible failure and does not fall back', async () => {
  let reported;
  const restore = installRendererAudioStubs(async () => {
    throw Object.assign(new Error('No matching audio device'), { name: 'OverconstrainedError' });
  });
  try {
    const capture = createAudioCapture({ sendAudioChunk: async () => {}, reportFailure: (error) => { reported = error; } });
    await assert.rejects(capture.start('unavailable-device-session', 'missing-windows-device'), /Selected device unavailable/);
    assert.equal(reported.code, 'SELECTED_DEVICE_UNAVAILABLE');
    assert.equal(describeCaptureFailure(reported, 'missing-windows-device').message, 'Selected device unavailable. Select another input.');
    const app = await readFile(new URL('app.js', root), 'utf8');
    assert.match(app, /setAudioInputStatus\(failure\.message, 'error'\)/);
    assert.match(app, /Unavailable · Previously selected/);
  } finally {
    restore();
  }
});

test('the audio selector cannot change during recording', async () => {
  assert.equal(canChangeAudioInput('recording'), false);
  assert.equal(canChangeAudioInput('stopped'), true);
  const app = await readFile(new URL('app.js', root), 'utf8');
  assert.match(app, /if \(!canChangeAudioInput\(state\.session\?\.state\)\)/);
  assert.match(app, /audioInputSelect\.disabled = recording \|\|/);
});
