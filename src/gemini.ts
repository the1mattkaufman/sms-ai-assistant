import { ChatMessage } from './conversation.js';
import {
  buildGeminiContents,
  GeminiProvider,
  geminiProvider,
} from './providers/gemini-provider.js';

export { buildGeminiContents, GeminiProvider, geminiProvider };

/**
 * Sends prompt (with optional multi-turn conversation history) to Gemini model and returns the response text.
 */
export async function generateGeminiReply(
  prompt: string,
  history: ChatMessage[] = []
): Promise<string> {
  return geminiProvider.generateReply(prompt, { history });
}
