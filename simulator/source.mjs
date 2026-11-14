import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { serve, send } from './runtime.mjs';
const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));
const raw = Object.fromEntries(await Promise.all(fixture.documents.map(async document =>
  [document.id, await readFile(new URL('../fixtures/raw/' + document.file, import.meta.url))])));

export async function createSource({ scenario = 'legacy' } = {}) {
  return serve(async ({ request, response, url, state }) => {
    const documents = scenario === 'legacy' ? fixture.documents.slice(0, 1) : fixture.documents;
    if (url.pathname === fixture.entry) return send(response, 200, {
      revision: state.round, transmissionWindow: fixture.transmissionWindow,
      documents: documents.map(({ file, ...document }) => ({ ...document,
        revision: document.id === fixture.changedDocument ? state.round : 1,
        href: '/raw/' + document.path })) });
    const document = documents.find(value => '/raw/' + value.path === decodeURIComponent(url.pathname));
    if (!document) return send(response, 404, { error: 'document unavailable' });
    if (state.failDoc === document.id) return send(response, 503, { error: 'temporarily unavailable' });
    if (state.missingDoc === document.id) return send(response, 404, { error: 'not delivered' });
    let bytes = raw[document.id];
    if (state.round === 2 && document.id === fixture.changedDocument) {
      let content = bytes.toString('utf8').replace(fixture.replaceFrom, fixture.replaceTo);
      if (document.format === 'ndjson') content += '\n{"seq":10,"session":"s1","operation":"Commit","arguments":[""],"result":"true","error":"0"}';
      bytes = Buffer.from(content);
    }
    const etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"';
    const headers = { etag, 'content-type': 'application/octet-stream', 'content-length': bytes.length };
    if (request.headers['if-none-match'] === etag) {
      delete headers['content-length'];
      return send(response, 304, '', headers);
    }
    send(response, 200, bytes, headers);
  }, { round: 1, failDoc: null, missingDoc: null });
}
