// 验收专用资料源：用 HTTP 回环服务任意 OpenDRIVE 分片，采集端只能经 HTTP 观察。
// 与 simulator/source.mjs 的固定 fixture 不同，这里服务的是测试内构造的资料，
// 用于覆盖缺件、单侧矛盾、零宽度边界、分片补交与修订留痕等异常矩阵。
import { createHash } from 'node:crypto';
import { serve, send } from '../simulator/runtime.mjs';

export async function createDocumentSource(documents, { round = 1, failDoc = null, missingDoc = null } = {}) {
  const bodies = new Map(documents.map(document => [document.id, Buffer.from(document.body)]));
  const state = { round, failDoc, missingDoc };
  const source = await serve(async ({ request, response, url }) => {
    if (url.pathname === '/roadnet') {
      return send(response, 200, {
        revision: state.round,
        documents: documents.map(document => ({
          id: document.id, path: document.path, format: document.format ?? 'xml',
          revision: document.revision ?? 1, href: `/raw/${document.path}`,
        })),
      });
    }
    const document = documents.find(candidate => `/raw/${candidate.path}` === decodeURIComponent(url.pathname));
    if (!document) return send(response, 404, { error: 'document unavailable' });
    // 活跃故障优先于缓存协商：条件请求也必须观察到 503/404，不能被 304 掩盖。
    if (state.failDoc === document.id) return send(response, 503, { error: 'temporarily unavailable' });
    if (state.missingDoc === document.id) return send(response, 404, { error: 'not delivered' });
    const bytes = bodies.get(document.id);
    const etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"';
    const headers = { etag, 'content-type': 'application/octet-stream', 'content-length': bytes.length };
    if (request.headers['if-none-match'] === etag) {
      delete headers['content-length'];
      return send(response, 304, '', headers);
    }
    send(response, 200, bytes, headers);
  }, state);
  return source;
}

export const roadDocument = ({ id, path, junction, link = '', laneLink = '', width = '3.5', sections }) => {
  const section = (s, lane) => `<laneSection s="${s}"><right><lane id="${lane}" type="driving">
  <link>${laneLink}</link><width sOffset="0" a="${width}" b="0" c="0" d="0"/></lane></right></laneSection>`;
  const sectionsXml = sections ?? [section(0, '-1')];
  const body = `<OpenDRIVE><road id="${id}" length="10"${junction ? ` junction="${junction}"` : ' junction="-1"'}>
  <link>${link}</link><lanes>${sectionsXml.join('')}</lanes></road></OpenDRIVE>`;
  return { id, path, body };
};

export const junctionDocument = ({ id = 'j1', path = 'junction.xodr', connectionId = 'c1',
  incomingRoad, connectingRoad, contactPoint = 'start', from = '-1', to = '-1' }) => ({
  id, path,
  body: `<OpenDRIVE><junction id="${id}"><connection id="${connectionId}" incomingRoad="${incomingRoad}"
  connectingRoad="${connectingRoad}" contactPoint="${contactPoint}">
  <laneLink from="${from}" to="${to}"/></connection></junction></OpenDRIVE>`,
});
