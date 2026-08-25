const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 4096;
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
  let pending = Promise.resolve();
  let buffer = [];
  let stopping = false;
  let flushQueued = false;
  let speechSamples = 0;
  let silenceSamples = 0;
  let speechDetected = false;

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
    try {
      stream = await mediaDevices().getUserMedia(getAudioCaptureConstraints(selectedDeviceId));
      context = new AudioContext({ latencyHint: 'interactive' });
      await context.audioWorklet.addModule(new URL('./audio-worklet.mjs', import.meta.url));
      source = context.createMediaStreamSource(stream);
      worklet = new AudioWorkletNode(context, 'argus-resampler', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      worklet.port.onmessage = (event) => receiveSamples(event.data);
      source.connect(worklet);
      startedAt = performance.now();
      sequence = 0;
      sampleCount = 0;
      flushQueued = false;
      speechSamples = 0;
      silenceSamples = 0;
      speechDetected = false;
    } catch (error) {
      await stop();
      const failure = describeCaptureFailure(error, selectedDeviceId);
      const reportedError = Object.assign(new Error(failure.message), { name: error?.name || 'Error', code: failure.code, cause: error });
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
      updateSpeechState(energy.rms, next.length);
      if (speechDetected && silenceSamples >= pauseSamples) enqueuePauseFlush();
      if (buffer.length > CHUNK_SAMPLES * 6) {
        stopping = true;
        reportFailure(new Error('Audio IPC backpressure exceeded the bounded renderer queue.'));
        void stop();
        return;
      }
    }
  }

  function enqueueChunk(samples) {
    const chunk = makeChunk(samples);
    pending = pending.then(async () => sendAudioChunk(await chunk)).catch(handleFailure);
  }

  function enqueuePauseFlush() {
    if (flushQueued || !sessionId) return;
    flushQueued = true;
    pending = pending.then(async () => {
      await sendAudioFlush({ session_id: sessionId, requested_at: new Date().toISOString(), reason: 'pause' });
      speechSamples = 0;
      silenceSamples = 0;
      speechDetected = false;
      flushQueued = false;
    }).catch(handleFailure);
  }

  function updateSpeechState(rms, sampleLength) {
    if (!speechDetected) {
      if (rms >= speechThreshold) speechSamples += sampleLength;
      else speechSamples = 0;
      if (speechSamples >= minSpeechSamples) {
        speechDetected = true;
        silenceSamples = 0;
      }
      return;
    }
    if (rms <= silenceThreshold) silenceSamples += sampleLength;
    else silenceSamples = 0;
  }

  function handleFailure(error) {
    stopping = true;
    reportFailure(error);
    throw error;
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
    if (buffer.length && sessionId && !stopping) {
      const remaining = buffer.splice(0);
      enqueueChunk(remaining);
    }
    stopping = true;
    source?.disconnect();
    worklet?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    await pending.catch(() => {});
    if (context) await context.close().catch(() => {});
    source = undefined; worklet = undefined; stream = undefined; context = undefined; buffer = [];
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
