import { describe, expect, it } from 'vitest';
import { canonicalJson, fromB64, fromHex, toB64, toHex, uint64be } from '../src';

describe('encoding', () => {
  it('base64url round-trips bytes containing + / - _ (pitfall C2)', () => {
    const tricky = new Uint8Array([0xfb, 0xff, 0xbe, 0x3e, 0x3f, 0x00, 0xff]);
    const s = toB64(tricky);
    expect(s).not.toMatch(/[+/=]/);
    expect(Array.from(fromB64(s))).toEqual(Array.from(tricky));
  });
  it('round-trips every length 0..40', () => {
    for (let n = 0; n <= 40; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      expect(Array.from(fromB64(toB64(b)))).toEqual(Array.from(b));
    }
  });
  it('rejects padding and foreign alphabet', () => {
    expect(() => fromB64('AA==')).toThrow();
    expect(() => fromB64('a+b/')).toThrow();
  });
  it('hex round-trip', () => {
    expect(toHex(fromHex('0x00ff10'))).toBe('0x00ff10');
    expect(() => fromHex('0xzz')).toThrow();
  });
  it('uint64be is big-endian and handles > 2^32 (pitfall C4)', () => {
    expect(Array.from(uint64be(1))).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(Array.from(uint64be(2 ** 40))).toEqual([0, 0, 1, 0, 0, 0, 0, 0]);
    expect(() => uint64be(-1)).toThrow();
  });
  it('canonicalJson sorts keys recursively, drops undefined, has no whitespace (pitfall C3)', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});
