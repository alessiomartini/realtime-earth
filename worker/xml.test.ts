import { describe, expect, it } from 'vitest';
import { decodeEntities, elementCensus, findAll, findFirst, firstValueOf, parseXml } from './xml.js';
import { shapeMeteored } from './proxy.js';

/**
 * The XML reader, and the Meteored shaper built on it.
 *
 * The important property here is unusual: this parser is deliberately ignorant
 * of Meteored's schema, because that schema has never been observed — every
 * keyless request is refused. So the tests are about behaviour under
 * uncertainty. Does an unrecognised document describe itself rather than read
 * as empty? Does a refusal delivered inside a 200 response surface as a
 * refusal? Those are the cases that decide whether a wrong guess about field
 * names shows up as a finding or as silence.
 */

describe('parseXml', () => {
  it('builds a tree with attributes and text', () => {
    const root = parseXml('<report><location city="Madrid"><temp>21.5</temp></location></report>');
    expect(root?.name).toBe('report');
    const location = findFirst(root!, 'location');
    expect(location?.attrs['city']).toBe('Madrid');
    expect(findFirst(root!, 'temp')?.text).toBe('21.5');
  });

  it('handles self-closing tags without swallowing what follows', () => {
    const root = parseXml('<r><a/><b>kept</b></r>');
    expect(findFirst(root!, 'b')?.text).toBe('kept');
    expect(findAll(root!, 'a')).toHaveLength(1);
  });

  it('ignores the declaration, comments and the doctype', () => {
    const root = parseXml('<?xml version="1.0"?><!-- note --><!DOCTYPE r><r><v>7</v></r>');
    expect(findFirst(root!, 'v')?.text).toBe('7');
  });

  it('keeps CDATA content, since that content is data', () => {
    const root = parseXml('<r><v><![CDATA[a < b & c]]></v></r>');
    expect(findFirst(root!, 'v')?.text).toBe('a < b & c');
  });

  it('returns null for a body that is not XML, rather than an empty document', () => {
    // These mean different things: one is a broken source, the other is a
    // source with nothing to report.
    expect(parseXml('')).toBeNull();
    expect(parseXml('You are not a registered user.')).toBeNull();
    expect(parseXml('{"json":true}')).toBeNull();
  });

  it('survives a stray closing tag instead of unwinding the document', () => {
    const root = parseXml('<r><a>1</a></b><c>2</c></r>');
    expect(findFirst(root!, 'c')?.text).toBe('2');
  });

  it('finds repeated elements in document order', () => {
    const root = parseXml('<r><day>1</day><day>2</day><day>3</day></r>');
    expect(findAll(root!, 'day').map((d) => d.text)).toEqual(['1', '2', '3']);
  });
});

describe('decodeEntities', () => {
  it('decodes the predefined entities and numeric references', () => {
    expect(decodeEntities('a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;')).toBe(`a & b < c > d "e" 'f'`);
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
  });

  it('leaves an unknown entity exactly as written rather than deleting it', () => {
    // Silently dropping part of a document is worse than showing it verbatim.
    expect(decodeEntities('a &nbsp; b')).toBe('a &nbsp; b');
  });
});

describe('elementCensus', () => {
  it('counts every element, which is how an unknown schema describes itself', () => {
    const root = parseXml('<r><day><t>1</t></day><day><t>2</t></day></r>');
    expect(elementCensus(root!)).toEqual({ r: 1, day: 2, t: 2 });
  });
});

describe('firstValueOf', () => {
  it('reports which candidate name actually matched', () => {
    const root = parseXml('<r><temperature>19</temperature></r>');
    expect(firstValueOf(root!, ['temperatura_actual', 'temperature'])).toEqual({
      name: 'temperature',
      value: '19',
    });
  });

  it('reads a value carried in an attribute rather than as text', () => {
    const root = parseXml('<r><temp value="19"/></r>');
    expect(firstValueOf(root!, ['temp'])?.value).toBe('19');
  });

  it('returns null when no candidate is present', () => {
    const root = parseXml('<r><other>1</other></r>');
    expect(firstValueOf(root!, ['temp', 'temperature'])).toBeNull();
  });
});

describe('shapeMeteored', () => {
  it('surfaces the refusal Meteored actually returns, verbatim', () => {
    // The exact body observed from production on 2026-09-02, delivered with
    // HTTP 200. A shaper that only looked for readings would report this as
    // "no data" and hide the one sentence that says what to do about it.
    const observed =
      '<?xml version="1.0" encoding="UTF-8" ?><report><error>You are not a registered user of the API from tiempo.com or your account has not been activated.</error></report>';
    const shaped = shapeMeteored(observed);
    const data = shaped.data as { error?: string };
    expect(data.error).toContain('not a registered user');
    expect(shaped.count).toBe(0);
    expect(shaped.sourceTimestamp).toBeNull();
  });

  it('reads current values and records which element carried each', () => {
    const body =
      '<report><temperatura_actual>21.5</temperatura_actual><humedad_relativa>44</humedad_relativa><fecha>2026-09-02T22:00:00Z</fecha></report>';
    const shaped = shapeMeteored(body);
    const data = shaped.data as { readings: Array<{ key: string; value: string; matchedElement: string }> };
    expect(data.readings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'temperature', value: '21.5', matchedElement: 'temperatura_actual' }),
        expect.objectContaining({ key: 'humidity', value: '44', matchedElement: 'humedad_relativa' }),
      ]),
    );
    expect(shaped.sourceTimestamp).toBe(Date.parse('2026-09-02T22:00:00Z'));
  });

  it('describes an unrecognised schema instead of reporting it as empty', () => {
    // This is the case the whole design exists for: if the guessed element
    // names are wrong, the response must say what it DID contain.
    const body = '<report><forecast><someUnexpectedName>21.5</someUnexpectedName></forecast></report>';
    const shaped = shapeMeteored(body);
    const data = shaped.data as { readings: unknown[]; missing: string[]; census: Record<string, number> };
    expect(data.readings).toHaveLength(0);
    expect(data.missing.length).toBeGreaterThan(0);
    expect(Object.keys(data.census)).toContain('someUnexpectedName');
  });

  it('reports no timestamp rather than substituting a clock reading', () => {
    const shaped = shapeMeteored('<report><temperatura_actual>3</temperatura_actual></report>');
    expect(shaped.sourceTimestamp).toBeNull();
  });

  it('says the body was not XML when it was not', () => {
    const shaped = shapeMeteored('502 Bad Gateway');
    const data = shaped.data as { error?: string };
    expect(data.error).toContain('not XML');
  });
});
