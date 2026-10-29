import { Router, Request, Response } from 'express';
import twilio from 'twilio';
import { config } from './config.js';
import { generateAIReply } from './providers/index.js';
import { chunkMessage } from './sms-formatter.js';
import {
  verifyTwilioSignature,
  enforceSenderAllowlist,
  enforceRateLimit,
} from './security.js';
import { ChatMessage, conversationStore } from './conversation.js';
import { handleSmsCommandAsync } from './commands.js';
import {
  canUseAsyncOutboundFallback,
  sendOutboundSmsChunks,
} from './twilio-sender.js';

const { MessagingResponse } = twilio.twiml;

export type ReplyGenerator = (prompt: string, history: ChatMessage[]) => Promise<string>;

const defaultReplyGenerator: ReplyGenerator = (prompt: string, history: ChatMessage[]) =>
  generateAIReply(prompt, {
    history,
    provider: config.aiProvider,
    model: config.aiModel,
  });

let activeReplyGenerator: ReplyGenerator = defaultReplyGenerator;

/**
 * Overrides the AI reply generator (useful for unit/integration testing or custom providers).
 */
export function setReplyGenerator(generator: ReplyGenerator): void {
  activeReplyGenerator = generator;
}

export function resetReplyGenerator(): void {
  activeReplyGenerator = defaultReplyGenerator;
}

export const webhookRouter = Router();

/**
 * Health check endpoint
 */
webhookRouter.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    aiProvider: config.aiProvider,
    aiModel: config.aiModel,
    geminiModel: config.geminiModel,
    phoneFilteringActive: config.allowedPhoneNumbers.length > 0,
    signatureValidationActive: config.validateTwilioSignature,
    firestoreEnabled: config.useFirestore,
  });
});

/**
 * JSON test endpoint to test prompt, commands, and multi-turn conversation directly (disabled by default)
 */
webhookRouter.post('/test', async (req: Request, res: Response) => {
  if (!config.enableTestEndpoint) {
    return res.status(403).json({
      error: 'Test endpoint is disabled. Set ENABLE_TEST_ENDPOINT=true in .env for local testing.',
    });
  }

  const prompt = (req.body?.prompt || req.body?.message || '') as string;
  const sender = (req.body?.from as string) || 'local-test';
  if (!prompt.trim()) {
    return res.status(400).json({ error: 'Please provide a "prompt" or "message" in the JSON request body.' });
  }

  const cmdResult = await handleSmsCommandAsync(sender, prompt, conversationStore);
  if (cmdResult.handled) {
    return res.json({ prompt, reply: cmdResult.reply, command: true });
  }

  const effectivePrompt = cmdResult.forwardedPrompt ?? prompt;
  const history = await conversationStore.getHistoryAsync(sender);
  const reply = await activeReplyGenerator(effectivePrompt, history);
  const updated = await conversationStore.addExchangeAsync(sender, effectivePrompt, reply);

  return res.json({
    prompt: effectivePrompt,
    reply,
    provider: config.aiProvider,
    model: config.aiModel,
    turnCount: Math.floor(updated.messages.length / 2),
  });
});

/**
 * Main Twilio SMS Webhook
 * Twilio sends an HTTP POST request with application/x-www-form-urlencoded data
 * when an incoming SMS is received.
 */
webhookRouter.post(
  '/sms',
  verifyTwilioSignature,
  enforceSenderAllowlist,
  enforceRateLimit,
  async (req: Request, res: Response) => {
    const from = (req.body?.From as string) || '';
    const to = (req.body?.To as string) || config.twilioPhoneNumber || '';
    const body = (req.body?.Body as string) || '';
    const messageSid = (req.body?.MessageSid as string) || 'unknown';

    console.log(`[SMS Received] ID: ${messageSid} | From: ${from} | Text: "${body}"`);

    const twiml = new MessagingResponse();

    try {
      // 1. Check for SMS slash commands (/new, /reset, /model, /status, /help)
      const cmdResult = await handleSmsCommandAsync(from, body, conversationStore);
      if (cmdResult.handled && cmdResult.reply) {
        const chunks = chunkMessage(cmdResult.reply);
        for (const chunk of chunks) {
          twiml.message(chunk);
        }
        res.type('text/xml');
        return res.send(twiml.toString());
      }

      const effectivePrompt = (cmdResult.forwardedPrompt ?? body).trim();
      if (!effectivePrompt) {
        twiml.message('Please send a question or prompt to receive an answer.');
        res.type('text/xml');
        return res.send(twiml.toString());
      }

      // 2. Load active multi-turn conversation history for this sender
      const history = await conversationStore.getHistoryAsync(from);

      // 3. Query AI model (racing against webhookTimeoutMs if async outbound fallback is available)
      const generationPromise = activeReplyGenerator(effectivePrompt, history);

      if (config.webhookTimeoutMs > 0 && canUseAsyncOutboundFallback(to)) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutSentinel = Symbol('timeout');

        const raceResult = await Promise.race([
          generationPromise,
          new Promise<typeof timeoutSentinel>((resolve) => {
            timer = setTimeout(() => resolve(timeoutSentinel), config.webhookTimeoutMs);
          }),
        ]);

        if (timer) {
          clearTimeout(timer);
        }

        if (raceResult === timeoutSentinel) {
          console.log(
            `[SMS Async Fallback] Generation exceeded ${config.webhookTimeoutMs}ms for ${from}; acknowledging webhook and delivering via Twilio REST API.`
          );

          generationPromise
            .then(async (aiReply) => {
              await conversationStore.addExchangeAsync(from, effectivePrompt, aiReply);
              const chunks = chunkMessage(aiReply);
              await sendOutboundSmsChunks(from, to || config.twilioPhoneNumber || '', chunks);
              console.log(`[SMS Async Sent] To: ${from} | Chunks: ${chunks.length}`);
            })
            .catch((err) => {
              console.error('[SMS Async Error] Background generation/delivery failed:', err);
            });

          // Acknowledge webhook immediately with empty <Response/>
          res.type('text/xml');
          return res.send(twiml.toString());
        }

        const aiReply = raceResult;
        await conversationStore.addExchangeAsync(from, effectivePrompt, aiReply);
        const chunks = chunkMessage(aiReply);
        for (const chunk of chunks) {
          twiml.message(chunk);
        }

        console.log(
          `[SMS Replied] To: ${from} | Provider: ${config.aiProvider}/${config.aiModel} | Chunks: ${chunks.length} | History msgs: ${history.length + 2}`
        );
        res.type('text/xml');
        return res.send(twiml.toString());
      }

      // Synchronous path (when async fallback is not configured)
      const aiReply = await generationPromise;
      await conversationStore.addExchangeAsync(from, effectivePrompt, aiReply);

      const chunks = chunkMessage(aiReply);
      for (const chunk of chunks) {
        twiml.message(chunk);
      }

      console.log(
        `[SMS Replied] To: ${from} | Provider: ${config.aiProvider}/${config.aiModel} | Chunks: ${chunks.length} | History msgs: ${history.length + 2}`
      );
    } catch (error) {
      console.error('[SMS Error] Failed to process SMS:', error);
      twiml.message('Sorry, something went wrong while processing your prompt. Please try again.');
    }

    res.type('text/xml');
    return res.send(twiml.toString());
  }
);
