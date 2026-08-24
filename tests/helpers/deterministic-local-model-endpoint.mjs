import http from 'node:http';

export async function startDeterministicLocalModelEndpoint({ scenario = 'valid', delayMs = 100, extractionText = 'Use the governed local HTTP adapter.' } = {}) {
  const requests = [];
  let requestNumber = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = JSON.parse(bodyText); } catch { body = undefined; }
    requests.push({ number: ++requestNumber, body, raw: bodyText });
    const purpose = body?.purpose;
    if (scenario === 'timeout' || (scenario === 'timeout-once-then-valid' && requestNumber === 1)) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return sendJson(response, modelResponse(purpose, extractionText));
    }
    if (scenario === 'failure-once-then-valid' && requestNumber === 1) return sendRaw(response, 503, 'temporary model failure');
    if (scenario === 'malformed-json') return sendRaw(response, 200, '{"text":');
    if (scenario === 'invalid-output' || (scenario === 'invalid-extraction-output' && purpose === 'logged-item-extraction')) return sendJson(response, { protocol_version: '1.0.0', purpose, text: '', item_id: 'forged-by-model' });
    if (scenario === 'classification-failure' && purpose === 'classification-enrichment') return sendRaw(response, 503, 'classification unavailable');
    if (scenario === 'failure') return sendRaw(response, 503, 'model unavailable');
    return sendJson(response, modelResponse(purpose, extractionText));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/generate`,
    requests,
    async close() { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  };
}

function sendJson(response, value) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }
function sendRaw(response, status, value) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(value); }
function modelResponse(purpose, extractionText) {
  return purpose === 'classification-enrichment'
    ? { protocol_version: '1.0.0', purpose, suggested_classification: 'task', confidence: 0.91 }
    : { protocol_version: '1.0.0', purpose, text: extractionText };
}
