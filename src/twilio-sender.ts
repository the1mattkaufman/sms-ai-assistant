import twilio from 'twilio';
import { config } from './config.js';

export type OutboundSmsSender = (to: string, from: string, body: string) => Promise<void>;

const defaultOutboundSender: OutboundSmsSender = async (to: string, from: string, body: string) => {
  if (!config.twilioAccountSid || !config.twilioAuthToken) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for outbound SMS.');
  }
  const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
  await client.messages.create({ to, from, body });
};

let customOutboundSender: OutboundSmsSender | null = null;

/**
 * Overrides the outbound SMS sender (for unit/integration tests).
 */
export function setOutboundSmsSender(sender: OutboundSmsSender): void {
  customOutboundSender = sender;
}

export function resetOutboundSmsSender(): void {
  customOutboundSender = null;
}

/**
 * Checks whether async outbound SMS fallback can be used when a webhook nears Twilio's timeout.
 */
export function canUseAsyncOutboundFallback(inboundToNumber?: string): boolean {
  if (customOutboundSender) {
    return true;
  }
  const fromNumber = inboundToNumber || config.twilioPhoneNumber;
  return Boolean(config.twilioAccountSid && config.twilioAuthToken && fromNumber);
}

/**
 * Sends one or more SMS chunks sequentially via the Twilio REST API (or injected test sender).
 */
export async function sendOutboundSmsChunks(
  to: string,
  from: string,
  chunks: string[]
): Promise<void> {
  const sender = customOutboundSender || defaultOutboundSender;
  for (const chunk of chunks) {
    if (chunk.trim()) {
      await sender(to, from, chunk);
    }
  }
}
