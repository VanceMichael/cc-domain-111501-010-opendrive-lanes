// 仅支持本接入 profile 需要的 XML 子集：元素、属性、文本、CDATA、注释。
// 明确拒绝 DTD/DOCTYPE/ENTITY 与任何其他声明，实体只接受预定义五个与数字字符引用，
// 因此不依赖外部解析器也不会产生外部实体或实体膨胀攻击面。
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const NAME_PATTERN = /^[A-Za-z_][\w:.-]*$/;

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = isHex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) throw new Error('invalid numeric character reference');
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body];
    if (named === undefined) throw new Error(`unsupported entity &${body};`);
    return named;
  });
}

export function parseXml(raw) {
  if (typeof raw !== 'string') throw new Error('xml input must be text');
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error('external definitions not supported');
  const documentNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [documentNode];
  let index = 0;
  while (index < raw.length) {
    const next = raw.indexOf('<', index);
    if (next === -1) {
      appendText(stack, raw.slice(index));
      break;
    }
    if (next > index) appendText(stack, raw.slice(index, next));
    if (raw.startsWith('<!--', next)) {
      const end = raw.indexOf('-->', next + 4);
      if (end === -1) throw new Error('unterminated xml comment');
      index = end + 3;
      continue;
    }
    if (raw.startsWith('<![CDATA[', next)) {
      const end = raw.indexOf(']]>', next + 9);
      if (end === -1) throw new Error('unterminated cdata section');
      appendText(stack, raw.slice(next + 9, end));
      index = end + 3;
      continue;
    }
    if (raw.startsWith('<?', next)) {
      const end = raw.indexOf('?>', next + 2);
      if (end === -1) throw new Error('unterminated processing instruction');
      index = end + 2;
      continue;
    }
    if (raw[next + 1] === '!') throw new Error('xml declarations are not supported');
    const close = raw.indexOf('>', next);
    if (close === -1) throw new Error('unterminated xml tag');
    const tag = raw.slice(next + 1, close);
    index = close + 1;
    if (tag[0] === '/') {
      const name = tag.slice(1).trim();
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error(`unexpected closing tag ${name}`);
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const gap = body.search(/\s/);
    const name = (gap === -1 ? body : body.slice(0, gap)).trim();
    if (!NAME_PATTERN.test(name)) throw new Error(`invalid xml element name ${name}`);
    const attrs = {};
    if (gap !== -1) {
      const attributePattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let match;
      while ((match = attributePattern.exec(body.slice(gap)))) {
        attrs[match[1]] = decodeEntities(match[2] ?? match[3]);
      }
    }
    const node = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error('unbalanced xml elements');
  return documentNode;
}

function appendText(stack, chunk) {
  if (!chunk) return;
  stack[stack.length - 1].text += decodeEntities(chunk);
}

export function children(node, name) {
  return node.children.filter(child => child.name === name);
}

export function child(node, name) {
  return node.children.find(candidate => candidate.name === name) ?? null;
}
