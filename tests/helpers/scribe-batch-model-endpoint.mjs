import { createServer } from 'node:http';

/**
 * Deterministic LM Studio / OpenAI-compatible endpoint for Scribe batch requests.
 *
 * It records the system prompt and the governed request body of every call so a test can prove
 * the prompt actually sent, the statelessness of each call, and byte-identical retries. `reply`
 * decides the answer per call and may return:
 *   { items }    - wrapped into a full batch response whose batch_identity is copied from the request
 *   { response } - a provider-neutral object placed verbatim as the OpenAI-compatible content
 *   { content }  - the exact `message.content` string, for fenced or commentary-wrapped answers
 *   { raw }      - the exact HTTP body text, for malformed or prose answers
 *   { status }   - an HTTP failure status
 *   { delayMs }  - hold the response open, for timeout coverage
 */
export async function startScribeBatchModelEndpoint({ reply } = {}) {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let envelope;
    try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { envelope = undefined; }
    const systemPrompt = envelope?.messages?.[0]?.content;
    let modelRequest;
    try { modelRequest = JSON.parse(String(envelope?.messages?.[1]?.content ?? '')); } catch { modelRequest = undefined; }
    calls.push({ number: calls.length + 1, envelope, systemPrompt, modelRequest, authorization: request.headers.authorization });

    const answer = (reply ? reply(modelRequest, calls.length) : { items: [] }) || {};
    if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    if (answer.status && answer.status !== 200) {
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.raw ?? 'model unavailable');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    if (typeof answer.raw === 'string') { response.end(answer.raw); return; }
    const content = typeof answer.content === 'string'
      ? answer.content
      : JSON.stringify(answer.response !== undefined
        ? answer.response
        : { protocol_version: '2.0.0', purpose: 'logged-item-extraction', batch_identity: modelRequest?.batch_identity, items: answer.items ?? [] });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
