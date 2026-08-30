export function createSessionTimer({ clock = () => Date.now() } = {}) {
  let sessionId;
  let sessionState;
  let authoritativeSeconds = 0;
  let runningSince;

  function applyProjection(projection) {
    if (!projection?.session_id || !Number.isInteger(projection.elapsed_seconds)) return;
    const sessionChanged = sessionId !== projection.session_id;
    const stateChanged = sessionState !== projection.state;
    sessionId = projection.session_id;
    authoritativeSeconds = sessionChanged || stateChanged || projection.state !== 'recording'
      ? projection.elapsed_seconds
      : Math.max(authoritativeSeconds, projection.elapsed_seconds);
    sessionState = projection.state;
    if (projection.state === 'recording') {
      if (sessionChanged || stateChanged || runningSince === undefined) runningSince = clock();
    } else {
      runningSince = undefined;
    }
  }

  function pause() {
    authoritativeSeconds = current();
    runningSince = undefined;
  }

  function resume() {
    if (sessionState === 'recording' && runningSince === undefined) runningSince = clock();
  }

  function current() {
    if (runningSince === undefined) return authoritativeSeconds;
    return authoritativeSeconds + Math.max(0, Math.floor((clock() - runningSince) / 1000));
  }

  return Object.freeze({ applyProjection, pause, resume, current, get sessionId() { return sessionId; } });
}
