// 拓扑解释器：只把两侧道路声明、contactPoint 方向与边界宽度都核对一致的连接发布为 confirmed。
// 任何缺件、单侧声明、方向矛盾、车道缺失、边界宽度为零或不可求值的情况都产出带具体
// 资料位置与原因的未决条目；不按车道编号相同或几何距离补连。
import { boundaryWidth } from './opendrive.mjs';

export function laneRef(road, section, lane) {
  return `${road.id}:${section.s}:${lane.id}`;
}

export function interpretTopology(documents) {
  const confirmed = [];
  const unresolved = [];
  const roadIndex = new Map();
  const junctionIndex = new Map();
  const isolated = [];
  for (const document of documents) {
    for (const road of document.roads) {
      if (road.id === null) continue;
      if (roadIndex.has(road.id)) {
        unresolved.push(unresolvedEntry('duplicate-road-id', {
          location: `/OpenDRIVE/road[id=${road.id}]`, sourcePaths: [document.sourcePath],
          detail: `road id ${road.id} is declared by more than one document` }));
        continue;
      }
      roadIndex.set(road.id, { document, road });
    }
    for (const junction of document.junctions) {
      if (junction.id === null) continue;
      if (junctionIndex.has(junction.id)) {
        unresolved.push(unresolvedEntry('duplicate-junction-id', {
          sourcePaths: [document.sourcePath],
          locations: [`/OpenDRIVE/junction[id=${junction.id}]`],
          detail: `junction id ${junction.id} is declared by more than one document`,
          junction: junction.id }));
        continue;
      }
      junctionIndex.set(junction.id, { document, junction });
    }
    for (const entry of document.isolated) isolated.push({ ...entry, path: entry.path ?? document.sourcePath });
  }

  interpretRoadLinks({ documents, roadIndex, confirmed, unresolved });
  interpretJunctions({ roadIndex, junctionIndex, confirmed, unresolved });
  return { confirmed, unresolved, isolated };
}

function interpretRoadLinks({ roadIndex, confirmed, unresolved }) {
  const pairs = new Map();
  for (const { document, road } of roadIndex.values()) {
    for (const direction of ['predecessor', 'successor']) {
      const declared = road.links[direction];
      if (!declared || declared.elementType !== 'road' || declared.elementId === null) continue;
      const side = direction === 'predecessor' ? 'start' : 'end';
      const target = roadIndex.get(declared.elementId);
      if (!target) {
        unresolved.push(unresolvedEntry('referenced-road-missing', {
          sourcePaths: [document.sourcePath],
          locations: [`/OpenDRIVE/road[id=${road.id}]/link/${direction}`],
          detail: `road ${road.id} ${direction} references unknown road ${declared.elementId}`,
          from: { road: road.id, boundary: side }, to: { road: declared.elementId } }));
        continue;
      }
      const key = pairKey(road.id, declared.elementId);
      const pair = pairs.get(key) ?? { sides: new Map() };
      pair.sides.set(road.id, {
        boundary: side, contactPoint: declared.contactPoint,
        document, road, direction, targetId: declared.elementId,
      });
      pairs.set(key, pair);
    }
  }

  for (const pair of pairs.values()) {
    const declarations = [...pair.sides.values()];
    if (declarations.length === 1) {
      const only = declarations[0];
      unresolved.push(unresolvedEntry('one-sided-road-link', {
        sourcePaths: [only.document.sourcePath],
        locations: [`/OpenDRIVE/road[id=${only.road.id}]/link/${only.direction}`],
        detail: `road ${only.road.id} declares ${only.direction} road ${only.targetId}, but the counterpart declares nothing`,
        from: { road: only.road.id, boundary: only.boundary }, to: { road: only.targetId } }));
      continue;
    }
    const [first, second] = declarations;
    const expectedContact = first.boundary === 'start' ? 'end' : 'start';
    if (first.contactPoint !== expectedContact || second.contactPoint !== (second.boundary === 'start' ? 'end' : 'start')) {
      unresolved.push(unresolvedEntry('contact-point-conflict', {
        sourcePaths: [first.document.sourcePath, second.document.sourcePath],
        locations: [
          `/OpenDRIVE/road[id=${first.road.id}]/link/${first.direction}`,
          `/OpenDRIVE/road[id=${second.road.id}]/link/${second.direction}`],
        detail: `contactPoint declarations between ${first.road.id} and ${second.road.id} do not meet at matching boundaries`,
        from: { road: first.road.id, boundary: first.boundary }, to: { road: second.road.id, boundary: second.boundary } }));
      continue;
    }
    pairLanes({ sideA: first, sideB: second, confirmed, unresolved });
  }
}

function pairLanes({ sideA, sideB, confirmed, unresolved }) {
  const seenLanePairs = new Set();
  for (const [side, counterpart] of [[sideA, sideB], [sideB, sideA]]) {
    const section = boundarySection(side.road, side.boundary);
    if (!section) {
      unresolved.push(unresolvedEntry('lane-section-missing', {
        sourcePaths: [side.document.sourcePath],
        locations: [`/OpenDRIVE/road[id=${side.road.id}]/lanes`],
        detail: `road ${side.road.id} has no laneSection on its ${side.boundary} boundary`,
        from: { road: side.road.id, boundary: side.boundary }, to: { road: counterpart.road.id } }));
      continue;
    }
    for (const lane of boundaryLanes(section)) {
      const linkDirection = side.boundary === 'start' ? 'predecessor' : 'successor';
      const targetLaneId = lane.links[linkDirection];
      if (targetLaneId === null) continue;
      const targetSection = boundarySection(counterpart.road, counterpart.boundary);
      const targetLane = findLane(targetSection, targetLaneId);
      const fromLocation = `/OpenDRIVE/road[id=${side.road.id}]/laneSection[s=${section.s}]/lane[id=${lane.id}]/link/${linkDirection}`;
      const toLocation = targetSection
        ? `/OpenDRIVE/road[id=${counterpart.road.id}]/laneSection[s=${targetSection.s}]/lane[id=${targetLaneId}]/link/${counterpart.boundary === 'start' ? 'predecessor' : 'successor'}`
        : `/OpenDRIVE/road[id=${counterpart.road.id}]/lanes`;
      const fromRef = laneRef(side.road, section, lane);
      const toRef = targetLane ? laneRef(counterpart.road, targetSection, targetLane)
        : `${counterpart.road.id}:${targetSection?.s ?? '?'}:${targetLaneId}`;
      const dedupe = canonicalLaneKey(fromRef, toRef);
      if (seenLanePairs.has(dedupe)) continue;
      seenLanePairs.add(dedupe);
      const base = {
        sourcePaths: [side.document.sourcePath, counterpart.document.sourcePath],
        locations: [fromLocation, toLocation],
        from: { road: side.road.id, sectionS: section.s, lane: lane.id, boundary: side.boundary },
        to: { road: counterpart.road.id, sectionS: targetSection?.s ?? null, boundary: counterpart.boundary, lane: targetLaneId },
      };
      if (!targetLane) {
        unresolved.push(unresolvedEntry('counterpart-lane-missing', { ...base,
          detail: `lane ${lane.id} on ${side.road.id} points to lane ${targetLaneId} which does not exist on ${counterpart.road.id} boundary ${counterpart.boundary}` }));
        continue;
      }
      const reverse = targetLane.links[counterpart.boundary === 'start' ? 'predecessor' : 'successor'];
      if (reverse !== lane.id) {
        unresolved.push(unresolvedEntry('one-sided-lane-link', { ...base,
          detail: reverse === null
            ? `lane ${targetLaneId} on ${counterpart.road.id} declares no reverse lane link`
            : `lane ${targetLaneId} on ${counterpart.road.id} links back to lane ${reverse}, not ${lane.id}` }));
        continue;
      }
      const widthIssue = checkWidths([
        { document: side.document, road: side.road, section, lane, boundary: side.boundary },
        { document: counterpart.document, road: counterpart.road, section: targetSection, lane: targetLane, boundary: counterpart.boundary },
      ], unresolved);
      if (widthIssue) continue;
      const widthFrom = boundaryWidth(lane, section, side.road, side.boundary);
      const widthTo = boundaryWidth(targetLane, targetSection, counterpart.road, counterpart.boundary);
      confirmed.push({
        id: `${fromRef}->${toRef}`,
        kind: 'road-link',
        status: 'confirmed',
        from: { ...base.from, contactPoint: counterpart.boundary },
        to: { road: counterpart.road.id, sectionS: targetSection.s, lane: targetLane.id, boundary: counterpart.boundary, contactPoint: side.boundary },
        contactPoint: counterpart.boundary,
        width: { from: widthFrom, to: widthTo },
        sourcePaths: [...new Set([side.document.sourcePath, counterpart.document.sourcePath])],
        sources: [
          { documentId: side.document.documentId, path: side.document.sourcePath, revision: side.document.revision, location: fromLocation },
          { documentId: counterpart.document.documentId, path: counterpart.document.sourcePath, revision: counterpart.document.revision, location: toLocation },
        ],
      });
    }
  }
}

function interpretJunctions({ roadIndex, junctionIndex, confirmed, unresolved }) {
  for (const { document, junction } of junctionIndex.values()) {
    for (const connection of junction.connections) {
      const connectionLocation = `/OpenDRIVE/junction[id=${junction.id}]/connection[id=${connection.id ?? ''}]`;
      const incoming = connection.incomingRoad === null ? null : roadIndex.get(connection.incomingRoad);
      const connecting = connection.connectingRoad === null ? null : roadIndex.get(connection.connectingRoad);
      if (!incoming || !connecting) {
        const missingRoad = !incoming ? connection.incomingRoad : connection.connectingRoad;
        unresolved.push(unresolvedEntry('junction-road-missing', {
          junction: junction.id, connection: connection.id,
          sourcePaths: [document.sourcePath], locations: [connectionLocation],
          detail: `junction ${junction.id} connection ${connection.id ?? '?'} references missing road ${missingRoad}`,
          from: { road: connection.incomingRoad }, to: { road: connection.connectingRoad } }));
        continue;
      }
      if (connection.contactPoint !== 'start' && connection.contactPoint !== 'end') {
        unresolved.push(unresolvedEntry('contact-point-missing', {
          junction: junction.id, connection: connection.id,
          sourcePaths: [document.sourcePath, incoming.document.sourcePath, connecting.document.sourcePath],
          locations: [connectionLocation],
          detail: `junction connection ${connection.id ?? '?'} lacks a usable contactPoint`,
          from: { road: incoming.road.id }, to: { road: connecting.road.id } }));
        continue;
      }
      const incomingBoundary = 'end';
      const connectingBoundary = connection.contactPoint;
      const incomingSection = boundarySection(incoming.road, incomingBoundary);
      const connectingSection = boundarySection(connecting.road, connectingBoundary);
      if (!incomingSection || !connectingSection) {
        unresolved.push(unresolvedEntry('lane-section-missing', {
          junction: junction.id, connection: connection.id,
          sourcePaths: [document.sourcePath], locations: [connectionLocation],
          detail: 'a road referenced by the junction connection has no boundary laneSection' }));
        continue;
      }
      for (const laneLink of connection.laneLinks) {
        const laneLocation = `${connectionLocation}/laneLink[from=${laneLink.from ?? ''};to=${laneLink.to ?? ''}]`;
        const fromLane = findLane(incomingSection, laneLink.from);
        const toLane = findLane(connectingSection, laneLink.to);
        if (!fromLane || !toLane) {
          unresolved.push(unresolvedEntry('junction-lane-missing', {
            junction: junction.id, connection: connection.id,
            sourcePaths: [document.sourcePath], locations: [laneLocation],
            detail: `laneLink references lane ${!fromLane ? laneLink.from : laneLink.to} that is absent on the connected road`,
            from: { road: incoming.road.id, sectionS: incomingSection.s, lane: laneLink.from },
            to: { road: connecting.road.id, sectionS: connectingSection.s, lane: laneLink.to } }));
          continue;
        }
        const widthIssue = checkWidths([
          { document: incoming.document, road: incoming.road, section: incomingSection, lane: fromLane, boundary: incomingBoundary },
          { document: connecting.document, road: connecting.road, section: connectingSection, lane: toLane, boundary: connectingBoundary },
        ], unresolved, { junction: junction.id, connection: connection.id, extraPaths: [document.sourcePath], locations: [laneLocation] });
        if (widthIssue) continue;
        const fromRef = laneRef(incoming.road, incomingSection, fromLane);
        const toRef = laneRef(connecting.road, connectingSection, toLane);
        confirmed.push({
          id: `junction:${junction.id}:${connection.id ?? '?'}:${fromRef}->${toRef}`,
          kind: 'junction-link',
          status: 'confirmed',
          junction: junction.id,
          connection: connection.id,
          from: { road: incoming.road.id, sectionS: incomingSection.s, lane: fromLane.id, boundary: incomingBoundary },
          to: { road: connecting.road.id, sectionS: connectingSection.s, lane: toLane.id, boundary: connectingBoundary, contactPoint: connection.contactPoint },
          contactPoint: connection.contactPoint,
          width: {
            from: boundaryWidth(fromLane, incomingSection, incoming.road, incomingBoundary),
            to: boundaryWidth(toLane, connectingSection, connecting.road, connectingBoundary),
          },
          sourcePaths: [...new Set([document.sourcePath, incoming.document.sourcePath, connecting.document.sourcePath])],
          sources: [
            { documentId: document.documentId, path: document.sourcePath, revision: document.revision, location: laneLocation },
            { documentId: incoming.document.documentId, path: incoming.document.sourcePath, revision: incoming.document.revision,
              location: `/OpenDRIVE/road[id=${incoming.road.id}]/laneSection[s=${incomingSection.s}]/lane[id=${fromLane.id}]` },
            { documentId: connecting.document.documentId, path: connecting.document.sourcePath, revision: connecting.document.revision,
              location: `/OpenDRIVE/road[id=${connecting.road.id}]/laneSection[s=${connectingSection.s}]/lane[id=${toLane.id}]` },
          ],
        });
      }
    }
  }
}

function checkWidths(endpoints, unresolved, context = {}) {
  for (const endpoint of endpoints) {
    const width = boundaryWidth(endpoint.lane, endpoint.section, endpoint.road, endpoint.boundary);
    const location = `/OpenDRIVE/road[id=${endpoint.road.id}]/laneSection[s=${endpoint.section.s}]/lane[id=${endpoint.lane.id}]`;
    const common = {
      sourcePaths: [...new Set([...(context.extraPaths ?? []), endpoint.document.sourcePath])],
      locations: [...(context.locations ?? []), location],
      junction: context.junction, connection: context.connection,
      from: { road: endpoint.road.id, sectionS: endpoint.section.s, lane: endpoint.lane.id, boundary: endpoint.boundary },
    };
    if (width === null) {
      unresolved.push(unresolvedEntry('boundary-width-unknown', { ...common,
        detail: `lane ${endpoint.lane.id} on road ${endpoint.road.id} has no width polynomial evaluable at the ${endpoint.boundary} boundary` }));
      return true;
    }
    if (width === 0) {
      unresolved.push(unresolvedEntry('boundary-width-zero', { ...common,
        detail: `lane ${endpoint.lane.id} on road ${endpoint.road.id} evaluates to zero width at the ${endpoint.boundary} boundary; the counterpart connection declaration is not copied across` }));
      return true;
    }
  }
  return false;
}

function boundarySection(road, boundary) {
  if (!road.sections.length) return null;
  const ordered = [...road.sections].sort((a, b) => a.s - b.s);
  return boundary === 'start' ? ordered[0] : ordered[ordered.length - 1];
}

function boundaryLanes(section) {
  return [...section.left, ...section.center, ...section.right];
}

function findLane(section, laneId) {
  if (!section || laneId === null) return null;
  return boundaryLanes(section).find(lane => lane.id === laneId) ?? null;
}

function pairKey(firstRoad, secondRoad) {
  return [firstRoad, secondRoad].sort().join('|');
}

function canonicalLaneKey(firstRef, secondRef) {
  return [firstRef, secondRef].sort().join('->');
}

function unresolvedEntry(reason, fields) {
  return {
    kind: 'unresolved-link',
    reason,
    junction: fields.junction ?? null,
    connection: fields.connection ?? null,
    from: fields.from ?? null,
    to: fields.to ?? null,
    detail: fields.detail ?? '',
    sourcePaths: [...new Set(fields.sourcePaths ?? [])],
    locations: fields.locations ?? [],
    observedAt: new Date().toISOString(),
  };
}
