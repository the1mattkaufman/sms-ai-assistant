import { config } from '../config.js';
import { AIProvider, GenerateReplyOptions } from './types.js';
import { geminiProvider } from './gemini-provider.js';

export * from './types.js';
export * from './gemini-provider.js';

export class ProviderRegistry {
  private providers: Map<string, AIProvider> = new Map();

  constructor() {
    this.register(geminiProvider);
  }

  public register(provider: AIProvider): void {
    this.providers.set(provider.name.toLowerCase(), provider);
  }

  public get(name?: string): AIProvider {
    const targetName = (name || config.aiProvider || 'gemini').trim().toLowerCase();
    const provider = this.providers.get(targetName);
    if (!provider) {
      const available = this.listNames().join(', ');
      throw new Error(
        `AI provider "${targetName}" is not registered. Available providers: ${available}`
      );
    }
    return provider;
  }

  public has(name: string): boolean {
    return this.providers.has(name.trim().toLowerCase());
  }

  public listNames(): string[] {
    return Array.from(this.providers.keys());
  }

  public resetDefaults(): void {
    this.providers.clear();
    this.register(geminiProvider);
  }
}

export const providerRegistry = new ProviderRegistry();

export interface GenerateAIReplyOptions extends GenerateReplyOptions {
  provider?: string;
}

/**
 * Generates a reply using the active or specified AIProvider.
 */
export async function generateAIReply(
  prompt: string,
  options: GenerateAIReplyOptions = {}
): Promise<string> {
  const provider = providerRegistry.get(options.provider);
  return provider.generateReply(prompt, {
    ...options,
    model: options.model || config.aiModel || provider.getDefaultModel(),
  });
}
