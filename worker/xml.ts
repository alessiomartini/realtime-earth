/**
 * A small XML reader, because Workers have no `DOMParser` and Meteored answers
 * in XML.
 *
 * Deliberately structural rather than schema-aware. It turns a document into a
 * tree of `{ name, attrs, children, text }` and stops there — it does not know
 * what a forecast is, and nothing here assumes an element is called `day` or
 * `temperature`. That matters for one specific reason: Meteored's exact element
 * names have NOT been observed, because the API refuses every request without a
 * registered key. A parser written against remembered field names would be a
 * guess wearing the clothes of a fact, and when it found nothing it would
 * report an empty document rather than an unrecognised one.
 *
 * So the tree is generic, the caller searches it by name, and whatever is not
 * found is reported as absent by name. That way a wrong guess about the schema
 * shows up as "this field was not in the response" instead of silence.
 *
 * Scope: elements, attributes, text, comments, CDATA, self-closing tags, and
 * the XML declaration. No namespaces resolution, no DTDs, no entity definitions
 * beyond the five predefined ones plus numeric character references. That is
 * enough for a weather API and small enough to be read in full.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text content of this element, trimmed. Empty when it has none. */
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body];
    // An entity we do not know is left exactly as written rather than dropped:
    // silently deleting part of a document is worse than showing it verbatim.
    return named ?? whole;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const name = match[1];
    const value = match[3] ?? match[4] ?? '';
    if (name !== undefined) attrs[name] = decodeEntities(value);
    match = pattern.exec(source);
  }
  return attrs;
}

/**
 * Parse a document into a root node. Returns null when there is no element at
 * all — an empty or non-XML body is reported as such rather than as an empty
 * document, because those mean different things.
 */
export function parseXml(source: string): XmlNode | null {
  // Strip what carries no data: declaration, comments, doctype. CDATA is kept
  // by unwrapping it, since its content IS data.
  const cleaned = source
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_whole, inner: string) => inner);

  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  const tagPattern = /<\s*(\/?)\s*([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)\s*>/g;

  let lastIndex = 0;
  let match = tagPattern.exec(cleaned);
  while (match !== null) {
    const isClose = match[1] === '/';
    const name = match[2] ?? '';
    const attrSource = match[3] ?? '';
    const selfClosing = match[4] === '/';

    // Text sitting between the previous tag and this one belongs to whatever
    // element is currently open.
    const between = cleaned.slice(lastIndex, match.index).trim();
    if (between !== '' && stack.length > 0) {
      const parent = stack[stack.length - 1]!;
      parent.text = parent.text === '' ? decodeEntities(between) : `${parent.text} ${decodeEntities(between)}`;
    }
    lastIndex = tagPattern.lastIndex;

    if (isClose) {
      // Pop to the matching name. A stray close tag is ignored rather than
      // allowed to unwind the whole document.
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]!.name === name) {
          stack.length = i;
          break;
        }
      }
    } else {
      const node: XmlNode = { name, attrs: parseAttributes(attrSource), children: [], text: '' };
      const parent = stack[stack.length - 1];
      if (parent === undefined) {
        // Documents with more than one top-level element keep the first; the
        // rest are unreachable, which is what a malformed document deserves.
        root ??= node;
      } else {
        parent.children.push(node);
      }
      if (!selfClosing) stack.push(node);
    }

    match = tagPattern.exec(cleaned);
  }

  return root;
}

/** Every descendant with this element name, in document order. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = [];
  const walk = (current: XmlNode): void => {
    for (const child of current.children) {
      if (child.name === name) found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}

/** The first descendant with this name, or null. */
export function findFirst(node: XmlNode, name: string): XmlNode | null {
  return findAll(node, name)[0] ?? null;
}

/**
 * Every element name present in the document, with how many times each occurs.
 *
 * This exists so an unrecognised response can describe itself. When a parser
 * built on assumed names finds nothing, this is what distinguishes "the source
 * sent an empty document" from "the source sent something we do not recognise",
 * and it is what a diagnostic prints so the real schema can be read off a real
 * response rather than guessed at again.
 */
export function elementCensus(node: XmlNode): Record<string, number> {
  const census: Record<string, number> = {};
  const walk = (current: XmlNode): void => {
    census[current.name] = (census[current.name] ?? 0) + 1;
    for (const child of current.children) walk(child);
  };
  walk(node);
  return census;
}

/**
 * A value looked up by trying several candidate element names in order.
 *
 * Returns which name actually matched alongside the value, so the caller can
 * report the schema it really encountered instead of the one it hoped for.
 */
export function firstValueOf(
  node: XmlNode,
  candidates: readonly string[],
): { name: string; value: string } | null {
  for (const candidate of candidates) {
    const found = findFirst(node, candidate);
    if (found !== null && found.text !== '') return { name: candidate, value: found.text };
    // Some APIs put the value in an attribute rather than the text node.
    if (found !== null) {
      const attrValue = found.attrs['value'] ?? found.attrs['val'];
      if (attrValue !== undefined && attrValue !== '') return { name: candidate, value: attrValue };
    }
  }
  return null;
}
