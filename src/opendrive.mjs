// OpenDRIVE profile 规范化器。
// 复合身份来自 road id + laneSection s + lane id（另保留 laneSection 序号便于核对）。
// 文件名永远不参与身份；未建模的元素与属性不静默丢弃，进入 isolated 清单由上层记录。
import { child, children, parseXml } from './xml.mjs';

const ROAD_LINK_ELEMENTS = new Set(['predecessor', 'successor']);
const LANE_LINK_ELEMENTS = new Set(['predecessor', 'successor']);

export function parseOpenDrive(raw, source = {}) {
  const root = parseXml(raw);
  const openDrive = child(root, 'OpenDRIVE');
  if (!openDrive) throw new Error('OpenDRIVE root element unavailable');
  const isolated = [];
  const roads = children(openDrive, 'road').map(node => parseRoad(node, isolated));
  const junctions = children(openDrive, 'junction').map(node => parseJunction(node, isolated));
  for (const node of openDrive.children) {
    if (node.name !== 'road' && node.name !== 'junction') {
      isolated.push({ path: source.path ?? null, location: `/OpenDRIVE/${node.name}`,
        element: node.name, reason: 'element is outside the intake profile' });
    }
  }
  return {
    sourcePath: source.path ?? null,
    documentId: source.documentId ?? null,
    revision: source.revision ?? null,
    roads,
    junctions,
    isolated,
  };
}

function parseRoad(roadNode, isolated) {
  const roadId = requiredId(roadNode, 'road', isolated);
  const location = `/OpenDRIVE/road[id=${roadId}]`;
  const linkNode = child(roadNode, 'link');
  const links = { predecessor: null, successor: null };
  if (linkNode) {
    for (const node of linkNode.children) {
      if (ROAD_LINK_ELEMENTS.has(node.name)) links[node.name] = parseElementLink(node);
      else isolated.push(isolatedEntry(roadId, `${location}/link/${node.name}`, node.name));
    }
  }
  const lanesNode = child(roadNode, 'lanes');
  const sections = [];
  if (lanesNode) {
    children(lanesNode, 'laneSection').forEach((sectionNode, index) => {
      sections.push(parseLaneSection(roadId, index, sectionNode, isolated));
    });
    for (const node of lanesNode.children) {
      if (node.name !== 'laneSection') {
        isolated.push(isolatedEntry(roadId, `${location}/lanes/${node.name}`, node.name));
      }
    }
  }
  for (const node of roadNode.children) {
    if (!['link', 'lanes'].includes(node.name)) {
      isolated.push(isolatedEntry(roadId, `${location}/${node.name}`, node.name));
    }
  }
  return {
    id: String(roadId),
    junction: roadNode.attrs.junction === undefined ? null : String(roadNode.attrs.junction),
    length: parseNumber(roadNode.attrs.length),
    sections,
    links,
  };
}

function parseLaneSection(roadId, index, sectionNode, isolated) {
  const s = parseNumber(sectionNode.attrs.s);
  const location = `/OpenDRIVE/road[id=${roadId}]/laneSection[s=${sectionNode.attrs.s ?? ''}]`;
  const sides = { left: [], right: [], center: [] };
  for (const side of ['left', 'center', 'right']) {
    const sideNode = child(sectionNode, side);
    if (!sideNode) continue;
    for (const laneNode of children(sideNode, 'lane')) {
      sides[side].push(parseLane(roadId, sectionNode.attrs.s, laneNode, isolated));
    }
    for (const node of sideNode.children) {
      if (node.name !== 'lane') {
        isolated.push(isolatedEntry(roadId, `${location}/${side}/${node.name}`, node.name));
      }
    }
  }
  for (const node of sectionNode.children) {
    if (!['left', 'center', 'right'].includes(node.name)) {
      isolated.push(isolatedEntry(roadId, `${location}/${node.name}`, node.name));
    }
  }
  return { s, index, ...sides };
}

function parseLane(roadId, sectionS, laneNode, isolated) {
  const laneId = requiredId(laneNode, 'lane', isolated);
  const location = `/OpenDRIVE/road[id=${roadId}]/laneSection[s=${sectionS ?? ''}]/lane[id=${laneId}]`;
  const linkNode = child(laneNode, 'link');
  const links = { predecessor: null, successor: null };
  if (linkNode) {
    for (const node of linkNode.children) {
      if (LANE_LINK_ELEMENTS.has(node.name)) {
        links[node.name] = node.attrs.id === undefined ? null : String(node.attrs.id);
      } else {
        isolated.push(isolatedEntry(roadId, `${location}/link/${node.name}`, node.name));
      }
    }
  }
  const widths = [];
  for (const widthNode of children(laneNode, 'width')) {
    const width = {
      sOffset: parseNumber(widthNode.attrs.sOffset),
      a: parseNumber(widthNode.attrs.a),
      b: parseNumber(widthNode.attrs.b),
      c: parseNumber(widthNode.attrs.c),
      d: parseNumber(widthNode.attrs.d),
    };
    if (Object.values(width).some(value => value === null || Number.isNaN(value))) {
      isolated.push(isolatedEntry(roadId, `${location}/width[sOffset=${widthNode.attrs.sOffset ?? ''}]`,
        'width', 'width polynomial has a missing or non-numeric coefficient'));
    } else {
      widths.push(width);
    }
  }
  for (const node of laneNode.children) {
    if (!['link', 'width'].includes(node.name)) {
      isolated.push(isolatedEntry(roadId, `${location}/${node.name}`, node.name));
    }
  }
  return { id: String(laneId), type: laneNode.attrs.type ?? null, level: laneNode.attrs.level ?? null, links, widths };
}

function parseJunction(junctionNode, isolated) {
  const junctionId = requiredId(junctionNode, 'junction', isolated);
  const location = `/OpenDRIVE/junction[id=${junctionId}]`;
  const connections = children(junctionNode, 'connection').map(connectionNode => {
    const laneLinks = children(connectionNode, 'laneLink').map(laneLinkNode => ({
      from: laneLinkNode.attrs.from === undefined ? null : String(laneLinkNode.attrs.from),
      to: laneLinkNode.attrs.to === undefined ? null : String(laneLinkNode.attrs.to),
    }));
    for (const node of connectionNode.children) {
      if (node.name !== 'laneLink') {
        isolated.push({ path: null, location: `${location}/connection[id=${connectionNode.attrs.id ?? ''}]/${node.name}`,
          element: node.name, reason: 'element is outside the intake profile' });
      }
    }
    return {
      id: connectionNode.attrs.id === undefined ? null : String(connectionNode.attrs.id),
      incomingRoad: connectionNode.attrs.incomingRoad === undefined ? null : String(connectionNode.attrs.incomingRoad),
      connectingRoad: connectionNode.attrs.connectingRoad === undefined ? null : String(connectionNode.attrs.connectingRoad),
      contactPoint: connectionNode.attrs.contactPoint ?? null,
      laneLinks,
    };
  });
  for (const node of junctionNode.children) {
    if (node.name !== 'connection') {
      isolated.push({ path: null, location: `${location}/${node.name}`, element: node.name,
        reason: 'element is outside the intake profile' });
    }
  }
  return { id: String(junctionId), name: junctionNode.attrs.name ?? null, connections };
}

function parseElementLink(node) {
  return {
    elementType: node.attrs.elementType ?? null,
    elementId: node.attrs.elementId === undefined ? null : String(node.attrs.elementId),
    contactPoint: node.attrs.contactPoint ?? null,
  };
}

function requiredId(node, kind, isolated) {
  if (node.attrs.id === undefined) {
    isolated.push({ path: null, location: `/OpenDRIVE/${kind}`, element: kind, reason: 'missing required id attribute' });
    return null;
  }
  return String(node.attrs.id);
}

function isolatedEntry(roadId, location, element, reason = 'element is outside the intake profile') {
  return { path: null, roadId: roadId === null ? null : String(roadId), location, element, reason };
}

function parseNumber(value) {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

// 宽度多项式只在道路/分段边界求值（OpenDRIVE: width(ds)=a+b*ds+c*ds^2+d*ds^3）。
// 返回 null 表示无法根据已解释资料求值（缺宽度、缺 sOffset 或系数不可用），
// 调用方必须按未决处理，不能拿几何或对侧车道补一个宽度。
export function boundaryWidth(lane, section, road, boundary) {
  if (!lane.widths.length) return null;
  const ordered = [...lane.widths].sort((first, second) => {
    const left = first.sOffset ?? Number.NEGATIVE_INFINITY;
    const right = second.sOffset ?? Number.NEGATIVE_INFINITY;
    return left - right;
  });
  const at = (offset, ds) => offset.a + offset.b * ds + offset.c * ds ** 2 + offset.d * ds ** 3;
  if (boundary === 'start') {
    const first = ordered[0];
    if (first.sOffset === null || Number.isNaN(first.sOffset)) return null;
    if (first.sOffset > 0) return null;
    return at(first, 0);
  }
  const sectionStart = section.s ?? 0;
  const roadLength = road.length ?? null;
  if (roadLength === null || Number.isNaN(roadLength) || section.s === null || Number.isNaN(section.s)) return null;
  const sectionEnd = roadLength - sectionStart;
  if (sectionEnd < 0) return null;
  let active = ordered[0];
  for (const width of ordered) {
    if (width.sOffset === null || Number.isNaN(width.sOffset)) return null;
    if (width.sOffset <= sectionEnd) active = width;
  }
  return at(active, sectionEnd - active.sOffset);
}
