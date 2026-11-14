export function preview(raw, format) {
  if (format === 'json') {
    const value = JSON.parse(raw);
    return { root: 'json', fields: Object.keys(value), bytes: Buffer.byteLength(raw) };
  }
  if (format === 'xml') {
    if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error('external definitions not supported');
    const root = raw.match(/<(?![!?/])([\w:-]+)([^>]*)>/);
    if (!root) throw new Error('root element unavailable');
    const attributes = Object.fromEntries([...root[2].matchAll(/([\w:-]+)="([^"]*)"/g)]
      .map(match => [match[1], match[2]]));
    return { root: root[1], attributes, bytes: Buffer.byteLength(raw) };
  }
  const line = raw.split(/\r?\n/).find(value => value.trim());
  if (!line) throw new Error('empty document');
  if (format === 'ndjson') return { root: 'call-log', first: JSON.parse(line), bytes: Buffer.byteLength(raw) };
  return { root: format, first: line, bytes: Buffer.byteLength(raw) };
}
