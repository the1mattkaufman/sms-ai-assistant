import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMessage, formatForSms } from '../src/sms-formatter.js';

describe('SMS Formatter - formatForSms & chunkMessage', () => {
  test('returns single chunk for short messages', () => {
    const text = 'Hello from Gemini!';
    const chunks = chunkMessage(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], 'Hello from Gemini!');
  });

  test('splits message exceeding max length gracefully', () => {
    const paragraph1 = 'A'.repeat(800);
    const paragraph2 = 'B'.repeat(800);
    const combined = `${paragraph1}\n\n${paragraph2}`;

    const chunks = chunkMessage(combined, 1000);
    assert.equal(chunks.length, 2);
    assert.match(chunks[0], /\[1\/2\]/);
    assert.match(chunks[1], /\[2\/2\]/);
  });

  test('handles empty and whitespace-only text', () => {
    const chunks = chunkMessage('   ');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], '');
  });

  test('formatForSms strips Markdown headings, bold/italics, code fences, and formats links', () => {
    const markdown = [
      '### Flight Status Summary',
      '',
      '',
      'Here are the **key details** for __your flight__:',
      '* Gate: `B12`',
      '* Status: *On Time*',
      'Check [Airline Portal](https://example.com/flight) for updates.',
      '```json',
      '{"flight": "UA123"}',
      '```',
    ].join('\n');

    const formatted = formatForSms(markdown);
    assert.equal(
      formatted,
      [
        'Flight Status Summary',
        '',
        'Here are the key details for your flight:',
        '- Gate: B12',
        '- Status: On Time',
        'Check Airline Portal (https://example.com/flight) for updates.',
        '{"flight": "UA123"}',
      ].join('\n')
    );
  });
});
