import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  AIProvider,
  GenerateReplyOptions,
  providerRegistry,
  generateAIReply,
} from '../src/providers/index.js';
import { handleSmsCommand } from '../src/commands.js';
import { ConversationStore } from '../src/conversation.js';

class MockAltProvider implements AIProvider {
  public readonly name = 'mock-ai';

  public getDefaultModel(): string {
    return 'mock-fast-1';
  }

  public async generateReply(prompt: string, options: GenerateReplyOptions = {}): Promise<string> {
    const model = options.model || this.getDefaultModel();
    const turns = options.history?.length ?? 0;
    return `[${this.name}:${model}|hist=${turns}] ${prompt}`;
  }
}

describe('Model-Agnostic AIProvider & ProviderRegistry', () => {
  beforeEach(() => {
    providerRegistry.resetDefaults();
    config.aiProvider = 'gemini';
    config.aiModel = 'gemini-2.5-flash';
    config.geminiModel = 'gemini-2.5-flash';
  });

  test('has gemini registered by default', () => {
    assert.equal(providerRegistry.has('gemini'), true);
    assert.deepEqual(providerRegistry.listNames(), ['gemini']);
    const provider = providerRegistry.get('gemini');
    assert.equal(provider.name, 'gemini');
  });

  test('registers and dispatches to a custom AIProvider via generateAIReply', async () => {
    providerRegistry.register(new MockAltProvider());
    assert.equal(providerRegistry.has('mock-ai'), true);

    const reply = await generateAIReply('Hello world', {
      provider: 'mock-ai',
      model: 'mock-pro-2',
      history: [
        { role: 'user', content: 'Hi', timestamp: 1000 },
        { role: 'assistant', content: 'Hello', timestamp: 1000 },
      ],
    });

    assert.equal(reply, '[mock-ai:mock-pro-2|hist=2] Hello world');
  });

  test('throws helpful error when requesting an unregistered provider', () => {
    assert.throws(
      () => providerRegistry.get('nonexistent'),
      /AI provider "nonexistent" is not registered/
    );
  });

  test('/model command views and switches models and providers', async () => {
    const store = new ConversationStore();
    const phone = '+14155552671';
    providerRegistry.register(new MockAltProvider());

    // View current model
    const viewRes = handleSmsCommand(phone, '/model', store);
    assert.equal(viewRes.handled, true);
    assert.match(viewRes.reply || '', /Active AI: gemini \/ gemini-2.5-flash/);
    assert.match(viewRes.reply || '', /Providers: gemini, mock-ai/);

    // Switch model within current provider
    const switchModelRes = handleSmsCommand(phone, '/model gemini-2.5-pro', store);
    assert.equal(switchModelRes.handled, true);
    assert.equal(config.aiModel, 'gemini-2.5-pro');

    // Switch provider and model with provider:model syntax
    const switchProviderModelRes = handleSmsCommand(phone, '/model mock-ai:mock-ultra', store);
    assert.equal(switchProviderModelRes.handled, true);
    assert.equal(config.aiProvider, 'mock-ai');
    assert.equal(config.aiModel, 'mock-ultra');

    // Verify generateAIReply uses updated config defaults
    const reply = await generateAIReply('Test after switch');
    assert.equal(reply, '[mock-ai:mock-ultra|hist=0] Test after switch');

    // Reject unknown provider gracefully
    const badProviderRes = handleSmsCommand(phone, '/model unknown:foo', store);
    assert.equal(badProviderRes.handled, true);
    assert.match(badProviderRes.reply || '', /Unknown provider "unknown"/);
  });
});
