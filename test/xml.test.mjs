import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, decodeEntities } from '../src/xml.mjs';

test('parseXml builds elements, attributes and nested children', () => {
  const doc = parseXml('<OpenDRIVE><road id="r1" length="10"><lanes/></road></OpenDRIVE>');
  const road = doc.children[0].children[0];
  assert.equal(road.name, 'road');
  assert.equal(road.attrs.id, 'r1');
  assert.equal(road.attrs.length, '10');
  assert.equal(road.children[0].name, 'lanes');
});

test('parseXml accepts CDATA, comments and self closing tags', () => {
  const doc = parseXml('<root><!-- note --><a><![CDATA[1 < 2 & 3]]></a><b x="1"/></root>');
  const root = doc.children[0];
  assert.equal(root.children[0].name, 'a');
  assert.equal(root.children[0].text, '1 < 2 & 3');
  assert.equal(root.children[1].attrs.x, '1');
});

test('parseXml rejects external definitions and unsupported entities', () => {
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY x "y">]><root/>'), /external definitions/);
  assert.throws(() => parseXml('<root>&evil;</root>'), /unsupported entity/);
});

test('parseXml decodes only predefined and numeric entities', () => {
  assert.equal(decodeEntities('a&amp;b&lt;c&gt;&quot;&apos;'), 'a&b<c>"\'');
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
  assert.throws(() => decodeEntities('&#0;'), /invalid numeric/);
});

test('parseXml rejects unbalanced and malformed tags', () => {
  assert.throws(() => parseXml('<a><b></a></b>'), /unexpected closing tag/);
  assert.throws(() => parseXml('<a><b>text'), /unbalanced xml elements/);
  assert.throws(() => parseXml('<a><b/'), /unterminated xml tag/);
});
