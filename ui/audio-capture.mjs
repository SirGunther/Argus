const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 4096;
const MAX_PENDING_CHUNKS = 8;
const DEFAULT_PAUSE_THRESHOLD_MS = 1200;
const MIN_PAUSE_THRESHOLD_MS = 250;
const MAX_PAUSE_THRESHOLD_MS = 5000;
const DEFAULT_SPEECH_RMS_THRESHOLD = 0.0125;
const DEFAULT_SILENCE_RMS_THRESHOLD = 0.008;
const MIN_SPEECH_MS = 160;

export function getAudioCaptureConstraints(selectedDeviceId) {
  const audio = {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  };
  if (selectedDeviceId) audio.deviceId = { exact: selectedDeviceId };
  return { audio, video: false };
}

export function describeCaptureFailure(error, selectedDeviceId) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return { code: 'PERMISSION_DENIED', message: 'Permission denied. Allow microphone access, then rescan.' };
  }
  if (selectedDeviceId && (name === 'NotFoundError' || name === 'OverconstrainedError')) {
    return { code: 'SELECTED_DEVICE_UNAVAILABLE', message: 'Selected device unavailable. Select another input.' };
  }
  if (name === 'NotFoundError') {
    return { code: 'NO_INPUT_DEVICES', message: 'No input devices found. Connect a microphone, then rescan.' };
  }
  return { code: 'CAPTURE_STARTUP_FAILURE', message: `Capture startup failure. ${error?.message || 'The microphone could not be started.'}` };
}

export function canChangeAudioInput(sessionState) {
  return sessionState !== 'recording';
}

export function createAudioCapture({
  sendAudioChunk,
  sendAudioFlush = async () => {},
  reportFailure = () => {},
  diagnostic = () => {},
  pauseThresholdMs = DEFAULT_PAUSE_THRESHOLD_MS,
  speechRmsThreshold = DEFAULT_SPEECH_RMS_THRESHOLD,
  silenceRmsThreshold = DEFAULT_SILENCE_RMS_THRESHOLD
} = {}) {
  if (typeof sendAudioChunk !== 'function') throw new TypeError('sendAudioChunk must be a function');
  if (typeof sendAudioFlush !== 'function') throw new TypeError('sendAudioFlush must be a function');
  const boundedPauseThresholdMs = Math.max(MIN_PAUSE_THRESHOLD_MS, Math.min(MAX_PAUSE_THRESHOLD_MS, Number(pauseThresholdMs) || DEFAULT_PAUSE_THRESHOLD_MS));
  const speechThreshold = Math.max(0, Number(speechRmsThreshold) || DEFAULT_SPEECH_RMS_THRESHOLD);
  const silenceThreshold = Math.max(0, Math.min(speechThreshold, Number(silenceRmsThreshold) || DEFAULT_SILENCE_RMS_THRESHOLD));
  const minSpeechSamples = Math.ceil(TARGET_RATE * MIN_SPEECH_MS / 1000);
  const pauseSamples = Math.ceil(TARGET_RATE * boundedPauseThresholdMs / 1000);
  let stream;
  let context;
  let source;
  let worklet;
  let sessionId;
  let sequence = 0;
  let sampleCount = 0;
  let startedAt;
  let ingressTail = Promise.resolve();
  const pendingTasks = new Set();
  let buffer = [];
  let stopping = false;
  let speechSamples = 0;
  let silenceSamples = 0;
  let speechDetected = false;
  let pendingChunkCount = 0;
  let rmsCount = 0;
  let rmsSum = 0;
  let rmsMin = Number.POSITIVE_INFINITY;
  let rmsMax = 0;
  let rmsLatest = 0;
  let lastProgressAt = 0;

  function emitDiagnostic(event, details = {}) {
    try { diagnostic(event, { session_id: sessionId, ...captureSummary(), ...details }); } catch { /* diagnostics must never stop capture */ }
  }

  function captureSummary() {
    return {
      latest_sequence: Math.max(-1, sequence - 1),
      audio_duration_ms: Math.round(sampleCount * 1000 / TARGET_RATE),
      pending_ingress_count: pendingChunkCount,
      capture_active: Boolean(stream) && !stopping,
      ...(rmsCount ? { rms_summary: { min: rmsMin, max: rmsMax, average: rmsSum / rmsCount, latest: rmsLatest } } : {})
    };
  }

  function mediaDevices() {
    if (!navigator.mediaDevices) throw new Error('Microphone media devices are unavailable in this Electron renderer.');
    return navigator.mediaDevices;
  }

  async function enumerateAudioInputs() {
    return (await mediaDevices().enumerateDevices()).filter((device) => device.kind === 'audioinput');
  }

  async function requestPermission() {
    let permissionStream;
    try {
      permissionStream = await mediaDevices().getUserMedia({ audio: true, video: false });
    } finally {
      permissionStream?.getTracks?.().forEach((track) => track.stop());
    }
  }

  function onDeviceChange(listener) {
    const devices = mediaDevices();
    if (typeof listener !== 'function' || typeof devices.addEventListener !== 'function') return () => {};
    devices.addEventListener('devicechange', listener);
    return () => devices.removeEventListener?.('devicechange', listener);
  }

  async function start(nextSessionId, selectedDeviceId) {
    if (stream) return;
    sessionId = nextSessionId;
    stopping = false;
    emitDiagnostic('capture.start-requested', { device_selected: Boolean(selectedDeviceId) });
    try {
      stream = await mediaDevices().getUserMedia(getAudioCaptureConstraints(selectedDeviceId));
      emitDiagnostic('capture.device-ready', { track_count: stream.getTracks?.().length || 0 });
      for (const track of stream.getTracks?.() || []) track.addEventListener?.('ended', () => {
        if (stopping) return;
        failCapture(new Error('The microphone track ended unexpectedly.'), 'capture.renderer-failure');
      });
      context = new AudioContext({ latencyHint: 'interactive' });
      await context.audioWorklet.addModule(new URL('./audio-worklet.mjs', import.meta.url));
      source = context.createMediaStreamSource(stream);
      worklet = new AudioWorkletNode(context, 'argus-resampler', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      worklet.port.onmessage = (event) => receiveSamples(event.data);
      worklet.port.onmessageerror = () => failCapture(new Error('The audio worklet returned an unreadable message.'), 'capture.renderer-failure');
      worklet.onprocessorerror = () => failCapture(new Error('The audio worklet stopped processing microphone samples.'), 'capture.renderer-failure');
      source.connect(worklet);
      startedAt = performance.now();
      lastProgressAt = startedAt;
      sequence = 0;
      sampleCount = 0;
      ingressTail = Promise.resolve();
      pendingTasks.clear();
      speechSamples = 0;
      silenceSamples = 0;
      speechDetected = false;
      rmsCount = 0;
      rmsSum = 0;
      rmsMin = Number.POSITIVE_INFINITY;
      rmsMax = 0;
      rmsLatest = 0;
      emitDiagnostic('capture.active');
    } catch (error) {
      const failedSessionId = sessionId;
      await stop();
      const failure = describeCaptureFailure(error, selectedDeviceId);
      const reportedError = Object.assign(new Error(failure.message), { name: error?.name || 'Error', code: failure.code, cause: error });
      emitDiagnostic('capture.start-failed', { session_id: failedSessionId, error: reportedError.message, error_code: reportedError.code });
      reportFailure(reportedError);
      throw reportedError;
    }
  }

  function receiveSamples(samples) {
    if (stopping || !samples?.length) return;
    for (const sample of samples) buffer.push(sample);
    while (buffer.length >= CHUNK_SAMPLES) {
      const next = buffer.splice(0, CHUNK_SAMPLES);
      const energy = analyzeEnergy(next);
      enqueueChunk(next);
      rmsCount += 1;
      rmsSum += energy.rms;
      rmsMin = Math.min(rmsMin, energy.rms);
      rmsMax = Math.max(rmsMax, energy.rms);
      rmsLatest = energy.rms;
      const detected = updateSpeechState(energy.rms, next.length);
      if (detected) emitDiagnostic('capture.speech-detected', { speech_rms: energy.rms, speech_sequence: sequence - 1 });
      if (speechDetected && silenceSamples >= pauseSamples) enqueuePauseFlush();
      const now = performance.now();
      if (sequence === 1 || sequence % 16 === 0 || now - lastProgressAt >= 1000) {
        lastProgressAt = now;
        emitDiagnostic('capture.chunk-progress', { rms: energy.rms });
      }
      if (pendingChunkCount > MAX_PENDING_CHUNKS) {
        failCapture(new Error('Audio IPC backpressure exceeded the bounded renderer queue.'), 'capture.backpressure');
        void stop();
        return;
      }
    }
  }

  function enqueueChunk(samples) {
    pendingChunkCount += 1;
    const chunk = makeChunk(samples);
    const previousChunks = ingressTail;
    const task = previousChunks
      .then(async () => sendAudioChunk(await chunk))
      .finally(() => { pendingChunkCount -= 1; })
      .catch((error) => handleFailure(error, 'capture.chunk-ipc-rejected'));
    ingressTail = task.catch(() => {});
    trackTask(task);
  }

  function enqueuePauseFlush() {
    if (!sessionId) return;
    // Close this boundary before awaiting the ordered IPC tail. New speech can
    // therefore form the next immutable host utterance while Whisper drains
    // the snapshot represented by this flush.
    speechSamples = 0;
    silenceSamples = 0;
    speechDetected = false;
    emitDiagnostic('capture.boundary-detected', { boundary_sequence: sequence - 1, reason: 'pause' });
    const previousChunks = ingressTail;
    const task = previousChunks
      .then(() => sendAudioFlush({ session_id: sessionId, requested_at: new Date().toISOString(), reason: 'pause' }))
      .catch((error) => handleFailure(error, 'capture.flush-ipc-rejected'));
    ingressTail = task.catch(() => {});
    trackTask(task);
  }

  function trackTask(task) {
    pendingTasks.add(task);
    task.then(() => pendingTasks.delete(task), () => pendingTasks.delete(task));
  }

  function updateSpeechState(rms, sampleLength) {
    if (!speechDetected) {
      if (rms >= speechThreshold) speechSamples += sampleLength;
      else speechSamples = 0;
      if (speechSamples >= minSpeechSamples) {
        speechDetected = true;
        silenceSamples = 0;
        return true;
      }
      return false;
    }
    if (rms <= silenceThreshold) silenceSamples += sampleLength;
    else silenceSamples = 0;
    return false;
  }

  function handleFailure(error, event = 'capture.failure') {
    stopping = true;
    emitDiagnostic(event, { error: error?.message || String(error) });
    reportFailure(error);
    throw error;
  }

  function failCapture(error, event = 'capture.failure') {
    if (stopping) return;
    stopping = true;
    emitDiagnostic(event, { error: error?.message || String(error) });
    reportFailure(error);
  }

  function makeChunk(samples) {
    const currentSequence = sequence++;
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    const start = sampleCount;
    sampleCount += samples.length;
    return checksum(bytes).then((hash) => ({
      chunk_id: `${sessionId}-chunk-${currentSequence}`,
      session_id: sessionId,
      sequence: currentSequence,
      start_time: formatClock(start / TARGET_RATE),
      end_time: formatClock(sampleCount / TARGET_RATE),
      format: { encoding: 'pcm-signed-integer', sample_rate_hz: TARGET_RATE, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
      sample_count: samples.length,
      byte_length: bytes.byteLength,
      audio_base64: toBase64(bytes),
      checksum: `sha256:${hash}`
    }));
  }

  async function stop() {
    const stoppedSessionId = sessionId;
    emitDiagnostic('capture.stop-requested');
    if (buffer.length && sessionId && !stopping) {
      const remaining = buffer.splice(0);
      enqueueChunk(remaining);
    }
    stopping = true;
    source?.disconnect();
    worklet?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    await Promise.allSettled([...pendingTasks]);
    if (context) await context.close().catch(() => {});
    emitDiagnostic('capture.stopped', { session_id: stoppedSessionId, capture_active: false, pending_ingress_count: 0 });
    source = undefined; worklet = undefined; stream = undefined; context = undefined; buffer = []; sessionId = undefined; pendingChunkCount = 0;
  }

  return Object.freeze({ start, stop, enumerateAudioInputs, requestPermission, onDeviceChange, get active() { return Boolean(stream); } });
}

function analyzeEnergy(samples) {
  let sumSquares = 0;
  for (const sample of samples) sumSquares += sample * sample;
  return { rms: Math.sqrt(sumSquares / Math.max(1, samples.length)) };
}

async function checksum(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes) { let text = ''; for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(text); }
function formatClock(seconds) { const totalMs = Math.max(0, Math.round(seconds * 1000)); const hours = Math.floor(totalMs / 3600000); const minutes = Math.floor((totalMs % 3600000) / 60000); const wholeSeconds = Math.floor((totalMs % 60000) / 1000); return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(totalMs % 1000).padStart(3, '0')}`; }
