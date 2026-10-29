import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneNumber, parseAllowedNumbers } from '../src/config.js';
import { isPhoneNumberAllowed, SlidingWindowRateLimiter } from '../src/security.js';

describe('Security - Phone Number Normalization & Allowlist', () => {
  test('normalizes valid E.164 and US phone numbers', () => {
    assert.equal(normalizePhoneNumber('+14155552671'), '+14155552671');
    assert.equal(normalizePhoneNumber(' +1 (415) 555-2671 '), '+14155552671');
    assert.equal(normalizePhoneNumber('415-555-2671'), '+14155552671');
    assert.equal(normalizePhoneNumber('14155552671'), '+14155552671');
  });

  test('returns empty string for invalid phone numbers', () => {
    assert.equal(normalizePhoneNumber(''), '');
    assert.equal(normalizePhoneNumber('   '), '');
    assert.equal(normalizePhoneNumber('abc'), '');
    assert.equal(normalizePhoneNumber('+0123'), '');
    assert.equal(normalizePhoneNumber('12345'), '');
  });

  test('parseAllowedNumbers parses comma-separated list and drops invalid entries', () => {
    const parsed = parseAllowedNumbers('+14155552671, (212) 555-1234, invalid, ');
    assert.deepEqual(parsed, ['+14155552671', '+12125551234']);
  });

  test('isPhoneNumberAllowed fails closed when allowlist is empty', () => {
    assert.equal(isPhoneNumberAllowed('+14155552671', []), false);
  });

  test('isPhoneNumberAllowed requires exact E.164 match and blocks suffix spoofing', () => {
    const allowlist = ['+14155552671'];
    assert.equal(isPhoneNumberAllowed('+14155552671', allowlist), true);
    assert.equal(isPhoneNumberAllowed('+1 (415) 555-2671', allowlist), true);

    // Different country code with same suffix must be rejected
    assert.equal(isPhoneNumberAllowed('+4414155552671', allowlist), false);
    assert.equal(isPhoneNumberAllowed('+19999999999', allowlist), false);
    assert.equal(isPhoneNumberAllowed('', allowlist), false);
  });
});

describe('Security - SlidingWindowRateLimiter', () => {
  test('enforces maxRequests within windowMs and recovers after window expires', () => {
    const limiter = new SlidingWindowRateLimiter();
    const key = '+14155552671';
    const windowMs = 60_000;
    const maxRequests = 3;
    const t0 = 1_000_000;

    assert.equal(limiter.isAllowed(key, maxRequests, windowMs, t0), true);
    assert.equal(limiter.isAllowed(key, maxRequests, windowMs, t0 + 1000), true);
    assert.equal(limiter.isAllowed(key, maxRequests, windowMs, t0 + 2000), true);

    // 4th request within window is blocked
    assert.equal(limiter.isAllowed(key, maxRequests, windowMs, t0 + 3000), false);

    // Different key is unaffected
    assert.equal(limiter.isAllowed('+12125551234', maxRequests, windowMs, t0 + 3000), true);

    // After first request ages out of the 60s window, a new request is allowed
    assert.equal(limiter.isAllowed(key, maxRequests, windowMs, t0 + 60_001), true);
  });
});
