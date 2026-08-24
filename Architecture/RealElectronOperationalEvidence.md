# Real Electron operational evidence

## Scope

This record covers the operational completion slice after the Electron host and production graph were implemented. It does not claim physical-microphone acceptance; Codex and Dustin must perform that spoken-input run with an actual device.

## Operationally implemented

- `ui/audio-capture.mjs` measures captured Float32 audio energy, requires a bounded period of genuine speech before a pause can finalize, and queues a governed `audio.flush` after a configurable 1,200 ms pause threshold. Capture continues after the flush and Stop/Close remain governed flush paths.
- `services/whisper-cpp-stt` preserves Whisper full-JSON token probabilities and offsets, deletes temporary WAV/JSON inference files, advances utterance IDs monotonically, and preserves word sequence identity across flushes.
- `session.new` is a governed desktop command. The trusted Electron/Node boundary creates a fresh UUID-backed session ID, routes its `session.record` operation through the lifecycle owner, and leaves the closed session sealed and reviewable. The production graph remains alive for the new session.
- The closed-state primary control is `New Session`; the renderer clears old projections only after the new command is accepted and treats closed rows as read-only.
- `scripts/setup-real-dependencies.mjs` is idempotent and fail-closed. It writes `runtime-output/real-dependencies.json` only after Whisper and Ollama both pass real probes.
- The Windows package bundles the final Whisper executable, its required DLLs, and the model under `runtime-output/real-runtime/`; the source/build cache is excluded from the Electron package. Packaged startup rebases manifest-relative asset paths to the installed application root.

## Provisioned dependency evidence

The successful setup manifest was generated on 2026-08-24:

| Dependency | Evidence |
| --- | --- |
| Git | 2.54.0.windows.1 |
| CMake | 3.31.6-msvc6, Visual Studio bundled path |
| Visual Studio/MSVC | Visual Studio installation 17.14.36705.20; MSVC toolset 14.44.35207 |
| whisper.cpp | v1.9.1, `https://github.com/ggml-org/whisper.cpp.git` |
| Whisper executable | `runtime-output/real-runtime/whisper-cli.exe`; SHA-256 `4901fb11daefe0d8f7b9e2446c848b41aafe977dcd247da0403e5722eb6e5bf3`; `--help` probe passed |
| Whisper model | `ggml-base.en.bin`, identity `base.en`, SHA-256 `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002`, source Hugging Face whisper.cpp model URL |
| Ollama | 0.32.15 at `C:\Users\dktho\AppData\Local\Programs\Ollama\ollama.exe` |
| Selected local model | `llama3.2:3b`, digest `a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72`, family llama, 3.2B, Q4_K_M |
| Ollama probe | `/api/tags`, `/api/show`, and real `/api/generate` request passed at `http://127.0.0.1:11434` |

## Validation boundary

Narrow checks passed: JavaScript syntax checks for changed runtime files; contract generation/check; contract governance; production DesktopApplication startup with real STT/model capabilities available; and Record → Stop → Close → New Session lifecycle with distinct session IDs. Physical microphone permission, real pauses, recognition quality, latency, and logged-item accuracy remain awaiting actual spoken input. Optional classification remains deferred and is not represented as available.

No fake audio, fake STT, deterministic extraction, generated projections, demo-state, or simulated fallback participates in the packaged Electron path.

## Current packaged-launch blocker

The final unpacked package was rebuilt with the real dependency manifest and bundled Whisper assets. A normal launch of `out/argus-standalone-win32-x64/Argus.exe` on this Windows machine reaches Chromium initialization, but the packaged GPU helper exits with Windows status `0xC0000135`; Electron then terminates with `0x80000003` (“A breakpoint has been reached”). The same failure appears with diagnostic logging and is not evidence of a corrupt setup file. No physical-microphone acceptance is claimed until this packaging/host compatibility issue is fixed.
