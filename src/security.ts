import { Request, Response, NextFunction } from 'express';
import twilio from 'twilio';
import { config, normalizePhoneNumber } from './config.js';

const { MessagingResponse } = twilio.twiml;

/**
 * Checks whether a sender phone number is explicitly on the allowlist.
 * Fail-closed: returns false if the allowlist is empty or the sender is invalid.
 */
export function isPhoneNumberAllowed(from: string, allowedPhoneNumbers: string[]): boolean {
  if (!allowedPhoneNumbers || allowedPhoneNumbers.length === 0) {
    return false;
  }

  const normalizedFrom = normalizePhoneNumber(from);
  if (!normalizedFrom) {
    return false;
  }

  return allowedPhoneNumbers.some((allowed) => {
    const normalizedAllowed = normalizePhoneNumber(allowed);
    return normalizedAllowed.length > 0 && normalizedFrom === normalizedAllowed;
  });
}

/**
 * Sliding-window in-memory rate limiter.
 */
export class SlidingWindowRateLimiter {
  private hits: Map<string, number[]> = new Map();

  /**
   * Records a request for `key` and returns true if allowed, or false if rate-limited.
   */
  public isAllowed(key: string, maxRequests: number, windowMs: number, now: number = Date.now()): boolean {
    if (maxRequests <= 0) {
      return false;
    }

    const windowStart = now - windowMs;
    const timestamps = this.hits.get(key) || [];
    const recent = timestamps.filter((ts) => ts > windowStart);

    if (recent.length >= maxRequests) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /**
   * Clears all tracked rate-limit state (useful for tests).
   */
  public reset(): void {
    this.hits.clear();
  }
}

export const smsRateLimiter = new SlidingWindowRateLimiter();

/**
 * Sends a silent empty TwiML <Response/> so Twilio acknowledges the webhook
 * without sending an outbound SMS or retrying.
 */
function sendSilentTwimlResponse(res: Response): Response {
  const twiml = new MessagingResponse();
  res.type('text/xml');
  return res.status(200).send(twiml.toString());
}

/**
 * Middleware: Verifies that the incoming webhook request is cryptographically signed by Twilio.
 */
export function verifyTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  if (!config.validateTwilioSignature) {
    next();
    return;
  }

  if (!config.twilioAuthToken) {
    console.error('[Security] Twilio signature validation is enabled, but TWILIO_AUTH_TOKEN is not set.');
    res.status(500).send('Server authentication configuration error');
    return;
  }

  const twilioSignature = req.headers['x-twilio-signature'] as string | undefined;
  if (!twilioSignature) {
    console.warn(`[Security] Missing X-Twilio-Signature header from IP ${req.ip}`);
    res.status(403).send('Invalid Twilio Signature');
    return;
  }

  const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host');
  const fullUrl = `${protocol}://${host}${req.originalUrl}`;

  let isValid = twilio.validateRequest(
    config.twilioAuthToken,
    twilioSignature,
    fullUrl,
    req.body || {}
  );

  // Support Firebase Functions URLs (https://<region>-<project>.cloudfunctions.net/<fnName>/sms)
  // where Google Frontend strips /<fnName> from req.originalUrl before passing to Express
  const fnTarget = process.env.FUNCTION_TARGET || process.env.K_SERVICE;
  if (!isValid && fnTarget && !req.originalUrl.startsWith(`/${fnTarget}`)) {
    const fnPrefixedUrl = `${protocol}://${host}/${fnTarget}${req.originalUrl}`;
    isValid = twilio.validateRequest(
      config.twilioAuthToken,
      twilioSignature,
      fnPrefixedUrl,
      req.body || {}
    );
  }

  if (!isValid) {
    console.warn(`[Security] Invalid Twilio signature for request from IP ${req.ip}`);
    res.status(403).send('Invalid Twilio Signature');
    return;
  }

  next();
}

/**
 * Middleware: Enforces fail-closed sender phone number allowlisting.
 * Rejects unauthorized numbers silently with an empty TwiML <Response/> to avoid outbound SMS costs.
 */
export function enforceSenderAllowlist(req: Request, res: Response, next: NextFunction): void {
  const from = (req.body?.From as string) || '';

  if (!isPhoneNumberAllowed(from, config.allowedPhoneNumbers)) {
    console.warn(
      `[Security] Blocked unauthorized SMS sender: "${from || 'unknown'}" (Allowed count: ${config.allowedPhoneNumbers.length})`
    );
    sendSilentTwimlResponse(res);
    return;
  }

  next();
}

/**
 * Middleware: Enforces per-sender (or per-IP fallback) rate limiting.
 */
export function enforceRateLimit(req: Request, res: Response, next: NextFunction): void {
  const from = normalizePhoneNumber((req.body?.From as string) || '');
  const key = from || req.ip || 'unknown';

  const allowed = smsRateLimiter.isAllowed(
    key,
    config.rateLimitMaxRequests,
    config.rateLimitWindowMs
  );

  if (!allowed) {
    console.warn(`[Security] Rate limit exceeded for key: ${key}`);
    sendSilentTwimlResponse(res);
    return;
  }

  next();
}
