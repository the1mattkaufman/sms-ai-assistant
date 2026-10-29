import { GoogleGenAI, Content } from '@google/genai';
import { config } from '../config.js';
import { ChatMessage } from '../conversation.js';
import { AIProvider, GenerateReplyOptions } from './types.js';

/**
 * Converts agnostic ChatMessage history + current user prompt into Gemini Content[] array.
 */
export function buildGeminiContents(prompt: string, history: ChatMessage[] = []): Content[] {
  const contents: Content[] = history.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));

  contents.push({
    role: 'user',
    parts: [{ text: prompt.trim() }],
  });

  return contents;
}

export class GeminiProvider implements AIProvider {
  public readonly name = 'gemini';
  private client: GoogleGenAI | null = null;
  private lastApiKey: string = '';

  private getClient(): GoogleGenAI {
    if (!config.geminiApiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not configured.');
    }
    if (!this.client || this.lastApiKey !== config.geminiApiKey) {
      this.client = new GoogleGenAI({ apiKey: config.geminiApiKey });
      this.lastApiKey = config.geminiApiKey;
    }
    return this.client;
  }

  public getDefaultModel(): string {
    return config.aiModel || config.geminiModel || 'gemini-2.5-flash';
  }

  public async generateReply(prompt: string, options: GenerateReplyOptions = {}): Promise<string> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return 'Please send a question or prompt to receive an answer.';
    }

    const history = options.history ?? [];
    const model = options.model || this.getDefaultModel();
    const systemInstruction = options.systemInstruction || config.systemInstruction;

    try {
      const ai = this.getClient();
      const contents = buildGeminiContents(trimmed, history);

      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
        },
      });

      const reply = response.text?.trim();
      if (!reply) {
        return "I received your message, but didn't receive a response from Gemini.";
      }

      return reply;
    } catch (error: any) {
      console.error('Error generating response from Gemini:', error);

      if (error?.message?.includes('API_KEY_INVALID') || error?.status === 'INVALID_ARGUMENT') {
        return 'Error: Invalid Gemini API key configured on the server.';
      }
      if (error?.status === 429 || error?.message?.includes('RESOURCE_EXHAUSTED')) {
        return 'Notice: Gemini API rate limit reached. Please wait a moment and try again.';
      }

      return 'Sorry, an error occurred while processing your request with Gemini.';
    }
  }
}

export const geminiProvider = new GeminiProvider();
