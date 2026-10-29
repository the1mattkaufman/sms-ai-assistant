import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConversationSession,
  ConversationStore,
  FirestoreCollectionLike,
} from '../src/conversation.js';
import { handleSmsCommand, handleSmsCommandAsync } from '../src/commands.js';
import { buildGeminiContents } from '../src/gemini.js';

function createMockFirestoreCollection(): {
  collection: FirestoreCollectionLike;
  docs: Map<string, ConversationSession>;
} {
  const docs = new Map<string, ConversationSession>();
  const collection: FirestoreCollectionLike = {
    doc(id: string) {
      return {
        async get() {
          const data = docs.get(id);
          return {
            exists: Boolean(data),
            data: () => (data ? structuredClone(data) : undefined),
          };
        },
        async set(data: ConversationSession) {
          docs.set(id, structuredClone(data));
        },
        async delete() {
          docs.delete(id);
        },
      };
    },
  };
  return { collection, docs };
}

describe('ConversationStore - Multi-Turn History, Sliding Window & TTL', () => {
  test('stores and retrieves multi-turn history normalized by phone number', () => {
    const store = new ConversationStore();
    const t0 = 1_000_000;

    store.addExchange('+14155552671', 'Hi, my name is Matt.', 'Hello Matt!', t0);
    store.addExchange('(415) 555-2671', 'What is my name?', 'Your name is Matt.', t0 + 5000);

    const history = store.getHistory('+14155552671', t0 + 6000);
    assert.equal(history.length, 4);
    assert.equal(history[0].role, 'user');
    assert.equal(history[0].content, 'Hi, my name is Matt.');
    assert.equal(history[1].role, 'assistant');
    assert.equal(history[1].content, 'Hello Matt!');
    assert.equal(history[2].role, 'user');
    assert.equal(history[3].role, 'assistant');
  });

  test('trims oldest turns to respect maxMessages and starts with a user message', () => {
    const store = new ConversationStore();
    const maxMessages = 4; // 2 turns max
    const t0 = 1_000_000;

    store.addExchange('+14155552671', 'Turn 1 user', 'Turn 1 assistant', t0, maxMessages);
    store.addExchange('+14155552671', 'Turn 2 user', 'Turn 2 assistant', t0 + 1000, maxMessages);
    store.addExchange('+14155552671', 'Turn 3 user', 'Turn 3 assistant', t0 + 2000, maxMessages);

    const history = store.getHistory('+14155552671', t0 + 3000);
    assert.equal(history.length, 4);
    assert.equal(history[0].role, 'user');
    assert.equal(history[0].content, 'Turn 2 user');
    assert.equal(history[3].content, 'Turn 3 assistant');
  });

  test('auto-expires inactive session after TTL elapses', () => {
    const store = new ConversationStore();
    const ttlMs = 60_000; // 1 minute
    const t0 = 1_000_000;

    store.addExchange('+14155552671', 'Hello', 'Hi there!', t0, 20, ttlMs);
    assert.equal(store.getHistory('+14155552671', t0 + 30_000, ttlMs).length, 2);

    // After TTL (60s + 1ms), session expires and returns empty history
    assert.equal(store.getHistory('+14155552671', t0 + 60_001, ttlMs).length, 0);
  });

  test('persists and reloads sessions from disk when storagePath is configured', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-ai-test-'));
    const filePath = path.join(tmpDir, 'sessions.json');

    try {
      const store1 = new ConversationStore(filePath);
      const now = Date.now();
      store1.addExchange('+14155552671', 'Persist me', 'Persisted!', now);

      const store2 = new ConversationStore(filePath);
      const history = store2.getHistory('+14155552671', now + 1000);
      assert.equal(history.length, 2);
      assert.equal(history[0].content, 'Persist me');
      assert.equal(history[1].content, 'Persisted!');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('persists, reloads, expires, and clears sessions via Cloud Firestore adapter across stateless instances', async () => {
    const { collection, docs } = createMockFirestoreCollection();
    const t0 = 1_000_000;
    const ttlMs = 60_000;

    // Instance 1 writes an exchange to Firestore
    const instance1 = new ConversationStore(undefined, collection);
    await instance1.addExchangeAsync('+14155552671', 'In-flight Q1', 'In-flight A1', t0, 20, ttlMs);
    assert.equal(docs.has('+14155552671'), true);

    // Instance 2 (fresh cold start with empty local RAM) reads history from Firestore
    const instance2 = new ConversationStore(undefined, collection);
    const history = await instance2.getHistoryAsync('+14155552671', t0 + 10_000, ttlMs);
    assert.equal(history.length, 2);
    assert.equal(history[0].content, 'In-flight Q1');
    assert.equal(history[1].content, 'In-flight A1');

    // /status via handleSmsCommandAsync reads from Firestore
    const statusRes = await handleSmsCommandAsync('+14155552671', '/status', instance2, t0 + 15_000);
    assert.match(statusRes.reply || '', /Thread: 1 turn\(s\)/);

    // /reset via handleSmsCommandAsync deletes from Firestore
    await handleSmsCommandAsync('+14155552671', '/reset', instance2, t0 + 20_000);
    assert.equal(docs.has('+14155552671'), false);
  });
});

describe('SMS Slash Commands (handleSmsCommand)', () => {
  test('/new and /reset clear active conversation thread', () => {
    const store = new ConversationStore();
    const phone = '+14155552671';
    store.addExchange(phone, 'Question 1', 'Answer 1');
    assert.equal(store.getHistory(phone).length, 2);

    const res = handleSmsCommand(phone, '/reset', store);
    assert.equal(res.handled, true);
    assert.match(res.reply || '', /Conversation cleared/);
    assert.equal(store.getHistory(phone).length, 0);
  });

  test('/new <prompt> clears thread and forwards inline prompt to AI', () => {
    const store = new ConversationStore();
    const phone = '+14155552671';
    store.addExchange(phone, 'Old topic', 'Old reply');

    const res = handleSmsCommand(phone, '/new Tell me a joke', store);
    assert.equal(res.handled, false);
    assert.equal(res.forwardedPrompt, 'Tell me a joke');
    assert.equal(store.getHistory(phone).length, 0);
  });

  test('/status reports model and current thread turn count', () => {
    const store = new ConversationStore();
    const phone = '+14155552671';
    const t0 = 1_000_000;
    store.addExchange(phone, 'Q1', 'A1', t0);

    const res = handleSmsCommand(phone, '/status', store, t0 + 45_000);
    assert.equal(res.handled, true);
    assert.match(res.reply || '', /Thread: 1 turn\(s\)/);
    assert.match(res.reply || '', /Last active: 45s ago/);
  });

  test('/help and unknown commands return appropriate guidance', () => {
    const store = new ConversationStore();
    const phone = '+14155552671';

    const helpRes = handleSmsCommand(phone, '/help', store);
    assert.equal(helpRes.handled, true);
    assert.match(helpRes.reply || '', /\/new/);
    assert.match(helpRes.reply || '', /\/status/);

    const unknownRes = handleSmsCommand(phone, '/unknowncmd', store);
    assert.equal(unknownRes.handled, true);
    assert.match(unknownRes.reply || '', /Unknown command "\/unknowncmd"/);
  });
});

describe('Gemini Multi-Turn Content Formatting', () => {
  test('buildGeminiContents maps user/assistant history to Gemini user/model Content[]', () => {
    const history = [
      { role: 'user' as const, content: 'First question', timestamp: 1000 },
      { role: 'assistant' as const, content: 'First answer', timestamp: 1000 },
    ];
    const contents = buildGeminiContents('Follow-up question', history);
    assert.equal(contents.length, 3);
    assert.equal(contents[0].role, 'user');
    assert.deepEqual(contents[0].parts, [{ text: 'First question' }]);
    assert.equal(contents[1].role, 'model');
    assert.deepEqual(contents[1].parts, [{ text: 'First answer' }]);
    assert.equal(contents[2].role, 'user');
    assert.deepEqual(contents[2].parts, [{ text: 'Follow-up question' }]);
  });
});
