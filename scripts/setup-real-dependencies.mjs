import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'runtime-output', 'real-dependencies.json');
const RUNTIME_ROOT = path.join(ROOT, 'runtime-output', 'real-runtime');
const BUILD_ROOT = path.join(ROOT, 'runtime-output', 'whisper.cpp', 'build');
const SOURCE_ROOT = path.join(ROOT, 'runtime-output', 'whisper.cpp', 'source');
const WHISPER_VERSION = 'v1.9.1';
const WHISPER_REPOSITORY = 'https://github.com/ggml-org/whisper.cpp.git';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true';
const MODEL_NAME = 'ggml-base.en.bin';
const MODEL_PATH = path.join(RUNTIME_ROOT, MODEL_NAME);
const BINARY_PATH = path.join(RUNTIME_ROOT, 'whisper-cli.exe');
const WHISPER_RUNTIME_DLLS = ['ggml-base.dll', 'ggml-cpu.dll', 'ggml.dll', 'whisper.dll'];
const MODEL_MIN_BYTES = 50 * 1024 * 1024;
const OLLAMA_MODEL = 'llama3.2:3b';
const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434/api/generate';

async function main() {
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await mkdir(RUNTIME_ROOT, { recursive: true });

  const git = await requireCommand('git', ['--version'], 'Git');
  const cmake = await resolveCMake();
  const toolchain = await resolveToolchain();
  const gitVersion = firstLine(git.stdout || git.stderr);
  const cmakeVersion = firstLine(cmake.version.stdout || cmake.version.stderr);

  await ensureWhisperSource(git);
  const binary = await ensureWhisperBinary(cmake.path);
  const model = await ensureWhisperModel();
  const whisper = await verifyWhisper(binary, model);

  const ollama = await provisionOllama();
  const manifest = {
    status: 'ready',
    generated_at: new Date().toISOString(),
    prerequisites: {
      git: { path: git.path, version: gitVersion },
      cmake: { path: cmake.path, version: cmakeVersion },
      cpp_toolchain: toolchain
    },
    whisper: {
      runtime: 'whisper.cpp',
      version: WHISPER_VERSION,
      repository: WHISPER_REPOSITORY,
      binary: binary.path,
      binary_relative: path.relative(ROOT, binary.path).replaceAll('\\', '/'),
      binary_sha256: `sha256:${await sha256(binary.path)}`,
      model: model.path,
      model_relative: path.relative(ROOT, model.path).replaceAll('\\', '/'),
      model_identity: 'base.en',
      quantization: 'fp16 GGML',
      model_source: MODEL_URL,
      model_sha256: `sha256:${model.sha256}`,
      executable_probe: whisper
    },
    local_model: ollama
  };
  await writeFile(OUTPUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

async function ensureWhisperSource(git) {
  try {
    await access(path.join(SOURCE_ROOT, '.git'));
    const revision = await runCommand(git.path, ['-C', SOURCE_ROOT, 'describe', '--tags', '--exact-match']);
    if (!revision.stdout.trim().startsWith(WHISPER_VERSION)) throw new Error(`whisper.cpp source is not pinned to ${WHISPER_VERSION} (found ${revision.stdout.trim() || 'unknown revision'}).`);
  } catch (error) {
    if (error.message.includes('not pinned')) throw error;
    await mkdir(path.dirname(SOURCE_ROOT), { recursive: true });
    await runCommand(git.path, ['clone', '--branch', WHISPER_VERSION, '--depth', '1', WHISPER_REPOSITORY, SOURCE_ROOT]);
  }
}

async function ensureWhisperBinary(cmakePath) {
  if (await isUsableWhisperRuntime()) return { path: BINARY_PATH, reused: true };
  const existingBuild = await firstExisting([
    path.join(BUILD_ROOT, 'bin', 'Release', 'whisper-cli.exe'),
    path.join(BUILD_ROOT, 'bin', 'whisper-cli.exe'),
    path.join(BUILD_ROOT, 'bin', 'Release', 'whisper-cli')
  ]);
  if (existingBuild && await isUsableBinary(existingBuild)) {
    await copyWhisperRuntime(path.dirname(existingBuild), existingBuild);
    return { path: BINARY_PATH, reused: true };
  }
  await runCommand(cmakePath, ['-S', SOURCE_ROOT, '-B', BUILD_ROOT, '-G', 'Visual Studio 17 2022', '-A', 'x64', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON']);
  await runCommand(cmakePath, ['--build', BUILD_ROOT, '--config', 'Release', '--target', 'whisper-cli']);
  const candidates = [
    path.join(BUILD_ROOT, 'bin', 'Release', 'whisper-cli.exe'),
    path.join(BUILD_ROOT, 'bin', 'whisper-cli.exe'),
    path.join(BUILD_ROOT, 'bin', 'Release', 'whisper-cli')
  ];
  const built = await firstExisting(candidates);
  if (!built) throw new Error(`whisper.cpp was built but whisper-cli was not produced under ${BUILD_ROOT}.`);
  await copyWhisperRuntime(path.dirname(built), built);
  if (!await isUsableBinary(BINARY_PATH)) throw new Error(`Provisioned Whisper binary failed its executable probe: ${BINARY_PATH}`);
  return { path: BINARY_PATH, reused: false };
}

async function copyWhisperRuntime(sourceDirectory, binary) {
  await copyFile(binary, BINARY_PATH);
  for (const dependency of WHISPER_RUNTIME_DLLS) {
    const source = path.join(sourceDirectory, dependency);
    if (!await isUsableBinary(source)) throw new Error(`whisper.cpp runtime dependency is missing: ${source}`);
    await copyFile(source, path.join(RUNTIME_ROOT, dependency));
  }
}

async function ensureWhisperModel() {
  if (!await isUsableModel(MODEL_PATH)) {
    const temporary = `${MODEL_PATH}.download-${process.pid}`;
    process.stdout.write(`Downloading ${MODEL_URL}\n`);
    const response = await fetch(MODEL_URL, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Whisper model download returned HTTP ${response.status} from ${MODEL_URL}.`);
    await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
    if (!await isUsableModel(temporary)) throw new Error(`Downloaded Whisper model failed validation at ${MODEL_URL}.`);
    const { rename } = await import('node:fs/promises');
    await rename(temporary, MODEL_PATH);
  }
  return { path: MODEL_PATH, sha256: await sha256(MODEL_PATH) };
}

async function verifyWhisper(binary, model) {
  const result = await runCommand(binary.path, ['--help']);
  if (!/whisper/i.test(`${result.stdout}\n${result.stderr}`)) throw new Error(`Whisper executable probe did not identify whisper.cpp: ${binary.path}`);
  if (!await isUsableModel(model.path)) throw new Error(`Whisper model is not usable: ${model.path}`);
  return { command: '--help', status: 'passed' };
}

async function provisionOllama() {
  const ollama = await resolveOllama();
  await ensureOllamaEndpoint(ollama.path);
  await runCommand(ollama.path, ['pull', OLLAMA_MODEL]);
  const tags = await fetchJson('http://127.0.0.1:11434/api/tags');
  const listed = (tags.models || []).find((entry) => entry.name === OLLAMA_MODEL || entry.model === OLLAMA_MODEL);
  if (!listed) throw new Error(`Ollama pull completed but selected model ${OLLAMA_MODEL} is not present in /api/tags.`);
  const identity = await fetchJson('http://127.0.0.1:11434/api/show', { method: 'POST', body: JSON.stringify({ name: OLLAMA_MODEL }) });
  const generate = await fetchJson(OLLAMA_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, format: 'json', prompt: 'Return the JSON object {"status":"ready"} and nothing else.' })
  });
  if (!String(generate.response || '').trim()) throw new Error(`Ollama model ${OLLAMA_MODEL} responded without a generated result.`);
  const digest = listed.digest || identity.digest || identity.details?.digest || 'not-reported';
  return {
    runtime: 'Ollama',
    executable: ollama.path,
    version: firstLine(ollama.version.stdout || ollama.version.stderr),
    model: OLLAMA_MODEL,
    identity: { digest, family: identity.details?.family, parameter_size: identity.details?.parameter_size, quantization_level: identity.details?.quantization_level },
    protocol: 'ollama',
    endpoint: OLLAMA_ENDPOINT,
    status: 'ready',
    endpoint_probe: 'GET /api/tags + POST /api/show + POST /api/generate passed'
  };
}

async function ensureOllamaEndpoint(ollamaPath) {
  try {
    await fetchJson('http://127.0.0.1:11434/api/tags');
    return;
  } catch {
    const child = spawn(ollamaPath, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
  let lastError = 'endpoint did not respond';
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      await fetchJson('http://127.0.0.1:11434/api/tags');
      return;
    } catch (error) {
      lastError = error.message;
      await delay(1000);
    }
  }
  throw new Error(`Ollama loopback endpoint did not become available after starting ${ollamaPath}: ${lastError}`);
}

async function resolveOllama() {
  const candidates = [
    process.env.ARGUS_OLLAMA_BINARY,
    'ollama',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    path.join(process.env.ProgramFiles || '', 'Ollama', 'ollama.exe')
  ].filter(Boolean);
  let lastError = 'not found';
  for (const candidate of candidates) {
    try {
      const version = await runCommand(candidate, ['--version']);
      return { path: candidate, version };
    } catch (error) { lastError = error.message; }
  }
  throw new Error(`Ollama is not installed or executable. Checked PATH and official install locations. Last error: ${lastError}`);
}

async function resolveCMake() {
  const candidates = [
    process.env.ARGUS_CMAKE,
    'cmake',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return { path: candidate, version: await runCommand(candidate, ['--version']) }; } catch {}
  }
  throw new Error('CMake is missing. Install CMake from cmake.org or add the Visual Studio CMake component, then rerun npm.cmd run setup:real.');
}

async function resolveToolchain() {
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  let installPath;
  try {
    const result = await runCommand(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']);
    installPath = result.stdout.trim();
  } catch { throw new Error('A compatible MSVC C++ toolchain is missing. Install Visual Studio 2022 Build Tools with the Desktop C++ workload, then rerun npm.cmd run setup:real.'); }
  if (!installPath) throw new Error('Visual Studio C++ toolchain discovery returned no installation path.');
  const cl = await firstExisting([
    path.join(installPath, 'VC', 'Tools', 'MSVC', '14.44.35207', 'bin', 'Hostx64', 'x64', 'cl.exe'),
    path.join(installPath, 'VC', 'Tools', 'MSVC', 'bin', 'Hostx64', 'x64', 'cl.exe')
  ]);
  if (!cl) throw new Error(`Visual Studio was found at ${installPath}, but cl.exe was not found under its C++ workload.`);
  const version = await runCommand(vswhere, ['-latest', '-products', '*', '-property', 'installationVersion']);
  const toolset = cl.match(/MSVC\\([^\\]+)\\bin\\/i)?.[1] || 'not-reported';
  return { installation_path: installPath, compiler: cl, visual_studio_version: version.stdout.trim(), msvc_toolset: toolset };
}

async function requireCommand(command, args, label) {
  try { return { path: command, ...(await runCommand(command, args)) }; }
  catch { throw new Error(`${label} is missing. Install it from its official source, then rerun npm.cmd run setup:real.`); }
}

async function runCommand(command, args) {
  process.stdout.write(`Running ${command} ${args.join(' ')}\n`);
  try { return await run(command, args, { cwd: ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) { throw new Error(`${command} failed: ${error.stderr?.trim() || error.stdout?.trim() || error.message}`); }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON from ${url}`); }
}

async function isUsableBinary(file) {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 1024;
  } catch { return false; }
}

async function isUsableWhisperRuntime() {
  if (!await isUsableBinary(BINARY_PATH)) return false;
  for (const dependency of WHISPER_RUNTIME_DLLS) if (!await isUsableBinary(path.join(RUNTIME_ROOT, dependency))) return false;
  return true;
}

async function isUsableModel(file) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size < MODEL_MIN_BYTES) return false;
    const handle = await open(file, 'r');
    const headerBytes = Buffer.alloc(4);
    await handle.read(headerBytes, 0, 4, 0);
    await handle.close();
    const header = headerBytes.toString('ascii').toLowerCase();
    return header === 'lmgg' || header === 'gguf';
  } catch { return false; }
}

async function firstExisting(paths) { for (const candidate of paths) { try { await access(candidate); return candidate; } catch {} } return undefined; }
async function sha256(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
function firstLine(value = '') { return String(value).split(/\r?\n/).find((line) => line.trim())?.trim() || 'not-reported'; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
