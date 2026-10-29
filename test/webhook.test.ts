import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import twilio from 'twilio';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { smsRateLimiter } from '../src/security.js';
import { conversationStore } from '../src/conversation.js';
import { setReplyGenerator, resetReplyGenerator } from '../src/webhook.js';
import { setOutboundSmsSender, resetOutboundSmsSender } from '../src/twilio-sender.js';

describe('Webhook, Security Middleware & Multi-Turn Conversation Integration', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  beforeEach(() => {
    config.allowedPhoneNumbers = ['+14155552671'];
    config.validateTwilioSignature = false;
    config.twilioAuthToken = 'test_auth_token_12345';
    config.webhookTimeoutMs = 12_000;
    config.rateLimitMaxRequests = 20;
    config.rateLimitWindowMs = 60_000;
    config.enableTestEndpoint = false;
    smsRateLimiter.reset();
    conversationStore.clearAll();
    resetReplyGenerator();
    resetOutboundSmsSender();
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  test('GET /health returns healthy status', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.status, 'healthy');
    assert.equal(typeof json.geminiModel, 'string');
  });

  test('GET / returns informational message', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /Twilio Gemini SMS AI Assistant/);
  });

  test('POST /sms silently rejects unauthorized phone number with empty <Response/>', async () => {
    const params = new URLSearchParams({
      From: '+19999999999',
      Body: 'Hello AI',
    });

    const res = await fetch(`${baseUrl}/sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type')?.includes('text/xml'), true);
    const xml = await res.text();
    assert.doesNotMatch(xml, /<Message>/);
    assert.match(xml, /<Response\/>/);
  });

  test('POST /sms fails closed when ALLOWED_PHONE_NUMBERS is empty', async () => {
    config.allowedPhoneNumbers = [];

    const params = new URLSearchParams({
      From: '+14155552671',
      Body: 'Hello AI',
    });

    const res = await fetch(`${baseUrl}/sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    assert.equal(res.status, 200);
    const xml = await res.text();
    assert.doesNotMatch(xml, /<Message>/);
    assert.match(xml, /<Response\/>/);
  });

  test('POST /sms rejects missing or invalid Twilio signature when validation is enabled', async () => {
    config.validateTwilioSignature = true;

    const params = new URLSearchParams({
      From: '+14155552671',
      Body: 'Hello AI',
    });

    const resMissing = await fetch(`${baseUrl}/sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    assert.equal(resMissing.status, 403);

    const resInvalid = await fetch(`${baseUrl}/sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': 'invalid_signature',
      },
      body: params.toString(),
    });
    assert.equal(resInvalid.status, 403);
  });

  test('POST /sms accepts valid cryptographic Twilio signature', async () => {
    config.validateTwilioSignature = true;
    const url = `${baseUrl}/sms`;
    const bodyObj = {
      From: '+14155552671',
      Body: '   ',
    };
    const validSignature = twilio.getExpectedTwilioSignature(
      config.twilioAuthToken!,
      url,
      bodyObj
    );

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': validSignature,
      },
      body: new URLSearchParams(bodyObj).toString(),
    });

    assert.equal(res.status, 200);
    const xml = await res.text();
    assert.match(xml, /<Message>Please send a question or prompt/);
  });

  test('POST /sms enforces per-sender rate limiting silently', async () => {
    config.rateLimitMaxRequests = 2;

    const sendSms = () =>
      fetch(`${baseUrl}/sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          From: '+14155552671',
          Body: '   ',
        }).toString(),
      });

    const r1 = await sendSms();
    assert.match(await r1.text(), /<Message>/);

    const r2 = await sendSms();
    assert.match(await r2.text(), /<Message>/);

    // 3rd request exceeds limit of 2 -> silent <Response/>
    const r3 = await sendSms();
    const xml3 = await r3.text();
    assert.doesNotMatch(xml3, /<Message>/);
    assert.match(xml3, /<Response\/>/);
  });

  test('POST /sms maintains multi-turn thread history across SMS messages and supports /status and /reset', async () => {
    setReplyGenerator(async (prompt, history) => {
      return `Echo: "${prompt}" (prior msgs: ${history.length})`;
    });

    const sendText = async (body: string) => {
      const res = await fetch(`${baseUrl}/sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          From: '+14155552671',
          Body: body,
        }).toString(),
      });
      return res.text();
    };

    // Turn 1: fresh thread (0 prior messages)
    const xml1 = await sendText('First message');
    assert.match(xml1, /Echo: "First message" \(prior msgs: 0\)/);

    // Turn 2: continues thread (2 prior messages: user + assistant from Turn 1)
    const xml2 = await sendText('Second message');
    assert.match(xml2, /Echo: "Second message" \(prior msgs: 2\)/);

    // Command: /status shows 2 turns (4 messages)
    const xmlStatus = await sendText('/status');
    assert.match(xmlStatus, /Thread: 2 turn\(s\) \(4\/20 msgs\)/);

    // Command: /reset clears the thread
    const xmlReset = await sendText('/reset');
    assert.match(xmlReset, /Conversation cleared/);

    // Turn 3 after reset: back to 0 prior messages
    const xml3 = await sendText('After reset');
    assert.match(xml3, /Echo: "After reset" \(prior msgs: 0\)/);
  });

  test('POST /sms falls back to async outbound SMS when AI generation exceeds webhookTimeoutMs', async () => {
    config.webhookTimeoutMs = 25;

    const sentOutbound: Array<{ to: string; from: string; body: string }> = [];
    let outboundResolved!: () => void;
    const outboundPromise = new Promise<void>((resolve) => {
      outboundResolved = resolve;
    });

    setOutboundSmsSender(async (to, from, body) => {
      sentOutbound.push({ to, from, body });
      outboundResolved();
    });

    setReplyGenerator(async (prompt) => {
      await new Promise((r) => setTimeout(r, 80));
      return `**Delayed reply** to: ${prompt}`;
    });

    const res = await fetch(`${baseUrl}/sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        From: '+14155552671',
        To: '+18005559999',
        Body: 'Deep question',
      }).toString(),
    });

    // Immediate webhook response is an empty <Response/> before the 80ms AI generation finishes
    assert.equal(res.status, 200);
    const xml = await res.text();
    assert.doesNotMatch(xml, /<Message>/);
    assert.match(xml, /<Response\/>/);

    // Wait for background outbound SMS delivery
    await outboundPromise;
    assert.equal(sentOutbound.length, 1);
    assert.equal(sentOutbound[0].to, '+14155552671');
    assert.equal(sentOutbound[0].from, '+18005559999');
    // Markdown (**Delayed reply**) was also stripped by formatForSms!
    assert.equal(sentOutbound[0].body, 'Delayed reply to: Deep question');

    // Conversation store also recorded the exchange
    const history = conversationStore.getHistory('+14155552671');
    assert.equal(history.length, 2);
  });

  test('POST /test is disabled by default unless ENABLE_TEST_ENDPOINT=true', async () => {
    const res = await fetch(`${baseUrl}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Hello' }),
    });
    assert.equal(res.status, 403);
  });
});
