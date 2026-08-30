import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import {
  CREDENTIAL_KEY_PATTERN,
  DENIED_PERMISSIONS,
  PROVIDER_INJECTED_ENVIRONMENT_KEYS,
  SUPPORTED_ENVIRONMENT_KEYS,
  normalizePermissions,
  resolveNodePermissionPlan
} from '../permission-policy.mjs';

export function createNodeProcessProvider() {
  return {
    kind: 'node',
    /** Flags this provider can honor, published so an enforcement claim can be checked against reality. */
    enforcedRestrictions: Object.freeze(['filesystem-read', 'filesystem-write', 'child-process', 'worker', 'addons', 'wasi', 'heap-ceiling', 'environment-allowlist']),
    plan(instance, environment = process.env) {
      return resolveNodePermissionPlan({
        manifest: instance.manifest,
        directory: instance.directory,
        environment,
        sttRuntimePaths: resolveNodeSttRuntimePaths(instance.manifest, environment)
      });
    },
    start(instance, events) {
      const plan = this.plan(instance, process.env);
      const runtime = resolveNodeRuntime();
      const childEnvironment = buildNodeEnvironment(process.env, instance.manifest.runtime.environment?.allow || [], instance.id, instance.restartCount, plan.permissions);
      if (runtime.runAsNode) childEnvironment.ELECTRON_RUN_AS_NODE = '1';
      const child = spawn(runtime.executable, [...plan.execArgv, instance.entrypoint], {
        cwd: instance.directory,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: childEnvironment
      });
      const output = readline.createInterface({ input: child.stdout });
      const diagnostics = readline.createInterface({ input: child.stderr });
      output.on('line', events.onMessage);
      diagnostics.on('line', events.onDiagnostic);
      child.on('error', events.onError);
      child.on('exit', (code, signal) => events.onExit({ code, signal }));

      return {
        kind: 'node',
        pid: child.pid,
        permissionPlan: plan,
        write(message) {
          return new Promise((resolve, reject) => {
            if (!child.stdin.writable) {
              reject(new Error(`Node provider input is closed for ${instance.id}`));
              return;
            }
            child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
          });
        },
        closeInput() {
          if (child.stdin.writable) child.stdin.end();
        },
        terminate() {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        },
        isExited() {
          return child.exitCode !== null || child.signalCode !== null;
        },
        dispose() {
          output.close();
          diagnostics.close();
        }
      };
    }
  };
}

/** Map the host-neutral STT scope to only the two canonical provisioned asset files. */
export function resolveNodeSttRuntimePaths(manifest, environment = process.env) {
  const allowed = manifest.runtime?.environment?.allow || [];
  if (!allowed.includes('ARGUS_WHISPER_BINARY') || !allowed.includes('ARGUS_WHISPER_MODEL')) return [];
  const binary = canonicalConfiguredFile(environment.ARGUS_WHISPER_BINARY);
  const model = canonicalConfiguredFile(environment.ARGUS_WHISPER_MODEL);
  return binary && model ? [binary, model] : [];
}

/**
 * Electron's main process reports its own executable as process.execPath. The packaged app still
 * uses the same governed Node services, so ask the packaged Electron binary to run its embedded
 * Node runtime instead of accidentally launching another Electron application as a service.
 */
export function resolveNodeRuntime() {
  if (!process.versions.electron) return { executable: process.execPath, runAsNode: false };
  return {
    executable: process.env.ARGUS_NODE_EXECUTABLE || process.execPath,
    runAsNode: !process.env.ARGUS_NODE_EXECUTABLE
  };
}

/**
 * Rebuild the child environment from the declared allowlist. Every `ARGUS_` variable the component
 * did not declare is dropped, and every credential-shaped inherited variable is dropped unless the
 * component both declared that exact key and holds a `model_credentials` grant. An undeclared
 * credential therefore cannot reach a component even when the orchestrator's own environment has it.
 */
export function buildNodeEnvironment(baseEnvironment, allowedKeys, instanceId, restartCount = 0, permissions = DENIED_PERMISSIONS) {
  const requested = [...new Set(allowedKeys || [])];
  const granted = normalizePermissions(permissions);
  const invalid = requested.filter((key) => !SUPPORTED_ENVIRONMENT_KEYS.has(key));
  if (invalid.length) throw new Error(`Node manifest requested unsupported environment configuration: ${invalid.join(', ')}`);
  const credentialKeys = requested.filter((key) => SUPPORTED_ENVIRONMENT_KEYS.get(key).credential);
  if (credentialKeys.length && !granted.model_credentials.granted) {
    throw new Error(`Node manifest requested credential configuration without a model_credentials grant: ${credentialKeys.join(', ')}`);
  }

  const allowed = new Set(requested);
  const environment = Object.fromEntries(Object.entries(baseEnvironment).filter(([key]) => {
    if (allowed.has(key)) return false;
    if (key.startsWith('ARGUS_')) return false;
    return !CREDENTIAL_KEY_PATTERN.test(key.toUpperCase());
  }));
  for (const key of requested) if (baseEnvironment[key] !== undefined) environment[key] = baseEnvironment[key];
  const [instanceKey, restartKey] = PROVIDER_INJECTED_ENVIRONMENT_KEYS;
  environment[instanceKey] = instanceId;
  environment[restartKey] = String(restartCount || 0);
  return environment;
}

function canonicalConfiguredFile(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const resolved = path.resolve(value.trim());
  try { return realpathSync.native(resolved); } catch { return resolved; }
}
