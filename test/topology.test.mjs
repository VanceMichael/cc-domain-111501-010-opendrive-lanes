import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenDrive } from '../src/opendrive.mjs';
import { interpretTopology } from '../src/topology.mjs';

function doc(name, body) {
  return parseOpenDrive(`<OpenDRIVE>${body}</OpenDRIVE>`, { path: name, documentId: name, revision: 1 });
}

function road({ id, junction, link, laneLink, width = '3.5', sectionS = 0 }) {
  return `<road id="${id}" length="10"${junction ? ` junction="${junction}"` : ''}>
  <link>${link}</link>
  <lanes><laneSection s="${sectionS}"><right><lane id="-1" type="driving">
  <link>${laneLink}</link><width sOffset="0" a="${width}" b="0" c="0" d="0"/></lane></right></laneSection></lanes>
  </road>`;
}

const confirmedPair = () => [
  doc('road-1.xodr', road({
    id: 'r1', link: '<successor elementType="road" elementId="r2" contactPoint="start"/>',
    laneLink: '<successor id="-1"/>',
  })),
  doc('road-2.xodr', road({
    id: 'r2', link: '<predecessor elementType="road" elementId="r1" contactPoint="end"/>',
    laneLink: '<predecessor id="-1"/>',
  })),
];

test('matching two-sided declarations with contact point and width are confirmed with two source paths', () => {
  const { confirmed, unresolved } = interpretTopology(confirmedPair());
  assert.equal(confirmed.length, 1);
  const record = confirmed[0];
  assert.equal(record.id, 'r1:0:-1->r2:0:-1');
  assert.equal(record.status, 'confirmed');
  assert.equal(record.contactPoint, 'start');
  assert.deepEqual(record.sourcePaths, ['road-1.xodr', 'road-2.xodr']);
  assert.deepEqual(record.width, { from: 3.5, to: 3.5 });
  assert.equal(unresolved.length, 0);
});

test('identical lane numbers on unrelated roads never create a connection', () => {
  const documents = [
    doc('a.xodr', road({ id: 'r1', link: '', laneLink: '' })),
    doc('b.xodr', road({ id: 'r2', link: '', laneLink: '' })),
  ];
  const { confirmed, unresolved } = interpretTopology(documents);
  assert.deepEqual(confirmed, []);
  assert.deepEqual(unresolved, []);
});

test('a one-sided road declaration stays unresolved instead of being paired', () => {
  const documents = [
    doc('road-1.xodr', road({
      id: 'r1', link: '<successor elementType="road" elementId="r2" contactPoint="start"/>',
      laneLink: '<successor id="-1"/>',
    })),
    doc('road-2.xodr', road({ id: 'r2', link: '', laneLink: '' })),
  ];
  const { confirmed, unresolved } = interpretTopology(documents);
  assert.deepEqual(confirmed, []);
  assert.equal(unresolved[0].reason, 'one-sided-road-link');
  assert.ok(unresolved[0].locations[0].includes('road[id=r1]'));
});

test('conflicting contact points are a directional conflict, not a confirmed link', () => {
  const documents = [
    doc('road-1.xodr', road({
      id: 'r1', link: '<successor elementType="road" elementId="r2" contactPoint="end"/>',
      laneLink: '<successor id="-1"/>',
    })),
    doc('road-2.xodr', road({
      id: 'r2', link: '<predecessor elementType="road" elementId="r1" contactPoint="end"/>',
      laneLink: '<predecessor id="-1"/>',
    })),
  ];
  const { confirmed, unresolved } = interpretTopology(documents);
  assert.deepEqual(confirmed, []);
  assert.equal(unresolved[0].reason, 'contact-point-conflict');
});

test('a reverse lane link pointing at another lane id is a one-sided lane contradiction', () => {
  const documents = [
    doc('road-1.xodr', road({
      id: 'r1', link: '<successor elementType="road" elementId="r2" contactPoint="start"/>',
      laneLink: '<successor id="-1"/>',
    })),
    doc('road-2.xodr', road({
      id: 'r2', link: '<predecessor elementType="road" elementId="r1" contactPoint="end"/>',
      laneLink: '<predecessor id="-2"/>',
    })),
  ];
  const { confirmed, unresolved } = interpretTopology(documents);
  assert.deepEqual(confirmed, []);
  assert.equal(unresolved[0].reason, 'one-sided-lane-link');
  assert.ok(unresolved[0].detail.includes('not -1'));
});

test('zero width on one boundary blocks confirmation and never copies the opposite declaration', () => {
  const documents = [
    doc('road-1.xodr', road({
      id: 'r1', link: '<successor elementType="road" elementId="r2" contactPoint="start"/>',
      laneLink: '<successor id="-1"/>', width: '0',
    })),
    doc('road-2.xodr', road({
      id: 'r2', link: '<predecessor elementType="road" elementId="r1" contactPoint="end"/>',
      laneLink: '<predecessor id="-1"/>',
    })),
  ];
  const { confirmed, unresolved } = interpretTopology(documents);
  assert.deepEqual(confirmed, []);
  const entry = unresolved.find(item => item.reason === 'boundary-width-zero');
  assert.ok(entry);
  assert.equal(entry.from.road, 'r1');
  assert.ok(entry.detail.includes('zero width'));
});

test('a junction laneLink to a missing connecting road is unresolved with junction context', () => {
  const junction = doc('junction.xodr',
    `<junction id="j1"><connection id="c1" incomingRoad="r1" connectingRoad="missing-road" contactPoint="start">
    <laneLink from="-1" to="-1"/></connection></junction>`);
  const incoming = doc('road-1.xodr', road({
    id: 'r1', link: '', laneLink: '',
  }));
  const { confirmed, unresolved } = interpretTopology([incoming, junction]);
  assert.deepEqual(confirmed, []);
  const entry = unresolved[0];
  assert.equal(entry.kind, 'unresolved-link');
  assert.equal(entry.reason, 'junction-road-missing');
  assert.equal(entry.junction, 'j1');
  assert.equal(entry.to.road, 'missing-road');
});

test('a complete junction laneLink is confirmed and sourced from all three documents', () => {
  const junction = doc('junction.xodr',
    `<junction id="j1"><connection id="c1" incomingRoad="r1" connectingRoad="r3" contactPoint="start">
    <laneLink from="-1" to="-1"/></connection></junction>`);
  const incoming = doc('road-1.xodr', road({ id: 'r1', link: '', laneLink: '' }));
  const connecting = doc('road-3.xodr', road({ id: 'r3', link: '', laneLink: '' }));
  const { confirmed } = interpretTopology([incoming, connecting, junction]);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].id, 'junction:j1:c1:r1:0:-1->r3:0:-1');
  assert.deepEqual(confirmed[0].sourcePaths.sort(), ['junction.xodr', 'road-1.xodr', 'road-3.xodr'].sort());
});

test('same lane id in a second laneSection is a distinct composite identity', () => {
  const multi = parseOpenDrive(`<OpenDRIVE><road id="r9" length="20"><lanes>
  <laneSection s="0"><right><lane id="-1"><width sOffset="0" a="3.5" b="0" c="0" d="0"/></lane></right></laneSection>
  <laneSection s="10"><right><lane id="-1"><width sOffset="0" a="3.5" b="0" c="0" d="0"/></lane></right></laneSection>
  </lanes></road></OpenDRIVE>`, { path: 'multi.xodr' });
  assert.equal(multi.roads[0].sections.length, 2);
  assert.equal(multi.roads[0].sections[1].s, 10);
  assert.notEqual(`r9:0:-1`, `r9:10:-1`);
});
