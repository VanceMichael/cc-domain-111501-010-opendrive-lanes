import { createServer } from 'node:http';

export function send(response, status, body, headers = {}) {
  const encoded = typeof body === 'object' && !Buffer.isBuffer(body)
    ? JSON.stringify(body) : body;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(encoded);
}

export async function body(request) {
  const pieces = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 65536) throw new Error('body too large');
    pieces.push(chunk);
  }
  return Buffer.concat(pieces).toString('utf8');
}

export async function serve(handler, state = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, path: url.pathname, query: url.search });
    if (url.pathname === '/health') return send(response, 200, { ready: true });
    try {
      await handler({ request, response, url, state });
    } catch (error) {
      if (!response.headersSent) send(response, 500, { error: error.message });
      else response.destroy(error);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`, state, requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}
