import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenDrive, boundaryWidth } from '../src/opendrive.mjs';

const roadXml = (overrides = '') => `<OpenDRIVE><road id="r1" length="10" junction="-1">
<link><successor elementType="road" elementId="r2" contactPoint="start"/></link>
<lanes><laneSection s="0"><right><lane id="-1" type="driving">
<link><successor id="-1"/></link>
<width sOffset="0" a="3.5" b="0" c="0" d="0"/></lane></right></laneSection></lanes>
</road>${overrides}</OpenDRIVE>`;

test('parseOpenDrive composes road, laneSection and lane identities without using file names', () => {
  const parsed = parseOpenDrive(roadXml(), { path: 'whatever-name.xodr', documentId: 'doc-9', revision: 3 });
  assert.equal(parsed.roads.length, 1);
  const road = parsed.roads[0];
  assert.equal(road.id, 'r1');
  assert.equal(road.links.successor.elementId, 'r2');
  assert.equal(road.links.successor.contactPoint, 'start');
  const section = road.sections[0];
  assert.equal(section.s, 0);
  assert.equal(section.index, 0);
  const lane = section.right[0];
  assert.equal(lane.id, '-1');
  assert.equal(lane.links.successor, '-1');
  assert.equal(parsed.sourcePath, 'whatever-name.xodr');
});

test('boundaryWidth evaluates the polynomial only at the section boundary', () => {
  const parsed = parseOpenDrive(roadXml(), {});
  const road = parsed.roads[0];
  const section = road.sections[0];
  const lane = section.right[0];
  assert.equal(boundaryWidth(lane, section, road, 'start'), 3.5);
  assert.equal(boundaryWidth(lane, section, road, 'end'), 3.5);
});

test('boundaryWidth picks the active width polynomial at the end boundary', () => {
  const xml = `<OpenDRIVE><road id="r1" length="10"><lanes><laneSection s="0"><right><lane id="-1">
  <width sOffset="0" a="4" b="0" c="0" d="0"/>
  <width sOffset="5" a="2" b="1" c="0" d="0"/></lane></right></laneSection></lanes></road></OpenDRIVE>`;
  const { roads: [road] } = parseOpenDrive(xml, {});
  const section = road.sections[0];
  const lane = section.right[0];
  assert.equal(boundaryWidth(lane, section, road, 'start'), 4);
  assert.equal(boundaryWidth(lane, section, road, 'end'), 7); // a=2, ds=5 -> 2+1*5
});

test('a zero width boundary is reported numerically rather than inferred away', () => {
  const xml = `<OpenDRIVE><road id="r1" length="10"><lanes><laneSection s="0"><right><lane id="-1">
  <width sOffset="0" a="0" b="0" c="0" d="0"/></lane></right></laneSection></lanes></road></OpenDRIVE>`;
  const { roads: [road] } = parseOpenDrive(xml, {});
  const section = road.sections[0];
  assert.equal(boundaryWidth(section.right[0], section, road, 'end'), 0);
});

test('missing or malformed width coefficients become evaluable null and isolated diagnostics', () => {
  const xml = `<OpenDRIVE><road id="r1" length="10"><lanes><laneSection s="0"><right><lane id="-1">
  <width sOffset="0" a="x" b="0" c="0" d="0"/></lane></right></laneSection></lanes></road></OpenDRIVE>`;
  const parsed = parseOpenDrive(xml, { path: 'road-bad.xodr' });
  const { roads: [road] } = parsed;
  const section = road.sections[0];
  assert.equal(boundaryWidth(section.right[0], section, road, 'end'), null);
  assert.ok(parsed.isolated.some(entry => entry.element === 'width' && entry.location.includes('lane[id=-1]')));
});

test('unmodeled elements and missing ids are isolated instead of being silently dropped', () => {
  const parsed = parseOpenDrive(roadXml('<elevation><userData secret="x"/></elevation>'), { path: 'r.xodr' });
  assert.ok(parsed.isolated.some(entry => entry.element === 'elevation'));
  const missingId = parseOpenDrive('<OpenDRIVE><road length="1"><lanes/></road></OpenDRIVE>', {});
  assert.ok(missingId.isolated.some(entry => entry.reason.includes('missing required id')));
});

test('junction connections retain laneLink from/to identity', () => {
  const xml = `<OpenDRIVE><junction id="j1"><connection id="c1" incomingRoad="r1" connectingRoad="r3" contactPoint="start">
  <laneLink from="-1" to="-2"/></connection></junction></OpenDRIVE>`;
  const parsed = parseOpenDrive(xml, { path: 'junction.xodr' });
  const connection = parsed.junctions[0].connections[0];
  assert.deepEqual(connection.laneLinks, [{ from: '-1', to: '-2' }]);
  assert.equal(connection.contactPoint, 'start');
});
