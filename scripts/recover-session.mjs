import { SessionLifecycle } from '../runtime/session-lifecycle.mjs';
import { SessionStorage } from '../runtime/session-storage.mjs';

let options;
try { options = parseArguments(process.argv.slice(2)); }
catch (error) {
  process.stderr.write(`INVALID_ARGUMENTS: ${error.message}\n`);
  process.exit(2);
}
if (options.help || !options.sessionId) {
  console.error('Usage: ARGUS_SESSION_ROOT=<session root> node scripts/recover-session.mjs --session-id <id> [--dry-run|--apply]');
  process.exit(options.help ? 0 : 2);
}

try {
  const lifecycle = new SessionLifecycle({ storage: new SessionStorage() });
  const report = await lifecycle.recoverSession(options.sessionId, { dryRun: options.dryRun, apply: options.apply });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.code || error.name || 'RECOVERY_FAILED'}: ${error.message}\n`);
  process.exit(1);
}

function parseArguments(args) {
  const result = { apply: false, dryRun: true, help: false, sessionId: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') { result.apply = true; result.dryRun = false; }
    else if (argument === '--dry-run') result.dryRun = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--session-id') result.sessionId = args[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}
