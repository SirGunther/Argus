import { createServer } from 'node:http';

/**
 * Loopback pass-through recorder in front of a real OpenAI-compatible provider.
 *
 * This is an observation point, not a substitute. Every byte Argus sends is forwarded verbatim to
 * the upstream provider and every byte the provider answers is returned verbatim, so the behavior
 * under observation is the real provider's. It exists because the acceptance evidence has to state
 * what the model actually received - the bounded request shape, the protected instruction, the
 * presence or absence of user guidance - and that cannot be read from the provider's UI.
 *
 * It also records admission-relevant timing: when the request arrived and how long the upstream
 * inference took. That is the quantity the SCRIBE-05A defect turned on.
 */
export async function startRecordingModelProxy({ upstream, onRequest } = {}) {
  if (!upstream) throw new TypeError('recording proxy requires an upstream endpoint');
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let envelope;
    try { envelope = JSON.parse(bodyText); } catch { envelope = undefined; }
    let modelRequest;
    try { modelRequest = JSON.parse(String(envelope?.messages?.[1]?.content ?? '')); } catch { modelRequest = undefined; }
    const call = {
      number: calls.length + 1,
      received_at: new Date().toISOString(),
      received_monotonic_ms: Math.round(performance.now()),
      request_bytes: Buffer.byteLength(bodyText, 'utf8'),
      systemPrompt: envelope?.messages?.[0]?.content,
      userContent: envelope?.messages?.[1]?.content,
      envelope,
      modelRequest,
      // Recorded so the evidence can state whether a credential ever crossed the wire for a local
      // provider. The value itself is never stored.
      authorization_present: Boolean(request.headers.authorization)
    };
    calls.push(call);
    onRequest?.(call);

    const started = performance.now();
    try {
      const upstreamResponse = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyText
      });
      const text = await upstreamResponse.text();
      call.upstream_status = upstreamResponse.status;
      call.upstream_duration_ms = Math.round(performance.now() - started);
      call.response_bytes = Buffer.byteLength(text, 'utf8');
      try { call.responseContent = JSON.parse(text)?.choices?.[0]?.message?.content; } catch { call.responseContent = undefined; }
      response.writeHead(upstreamResponse.status, { 'content-type': 'application/json' });
      response.end(text);
    } catch (error) {
      call.upstream_duration_ms = Math.round(performance.now() - started);
      call.upstream_error = error.message;
      // A genuinely unreachable provider must reach Argus as a provider failure, not as a hang.
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `upstream unreachable: ${error.message}` } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
