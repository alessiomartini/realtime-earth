import { describe, expect, it } from 'vitest';
import { binanceFailureMessage, GEO_BLOCKED_MESSAGE, UNREACHABLE_MESSAGE } from './binance-geo.js';

describe('binanceFailureMessage', () => {
  it('reports HTTP 451 and 403 as geo-restriction', () => {
    expect(binanceFailureMessage({ status: 451 })).toBe(GEO_BLOCKED_MESSAGE);
    expect(binanceFailureMessage({ status: 403 })).toBe(GEO_BLOCKED_MESSAGE);
  });
  it('recognises the restricted-location body whatever the status', () => {
    const body = '{"msg":"Service unavailable from a restricted location according to b. Eligibility"}';
    expect(binanceFailureMessage({ status: 400, body })).toBe(GEO_BLOCKED_MESSAGE);
  });
  it('is hedged for network failures where no status is readable', () => {
    expect(binanceFailureMessage({ network: true })).toBe(UNREACHABLE_MESSAGE);
  });
  it('ignores unrelated failures', () => {
    expect(binanceFailureMessage({ status: 500 })).toBeNull();
  });
});
