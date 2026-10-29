import { ChatMessage } from '../conversation.js';

export interface GenerateReplyOptions {
  /**
   * Prior multi-turn conversation messages in chronological order.
   */
  history?: ChatMessage[];
  /**
   * Optional model override for this request (falls back to provider default).
   */
  model?: string;
  /**
   * Optional system instruction override for this request.
   */
  systemInstruction?: string;
}

/**
 * Provider-agnostic interface for LLM chat backends (Gemini, OpenAI, Anthropic, etc.).
 */
export interface AIProvider {
  /**
   * Unique lowercase identifier for the provider (e.g., 'gemini', 'openai', 'anthropic').
   */
  readonly name: string;

  /**
   * Returns the default model name configured for this provider.
   */
  getDefaultModel(): string;

  /**
   * Generates a plain-text reply given a user prompt and optional conversation history/settings.
   */
  generateReply(prompt: string, options?: GenerateReplyOptions): Promise<string>;
}
