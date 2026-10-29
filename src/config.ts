import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  port: number;
  aiProvider: string;
  aiModel: string;
  geminiApiKey: string;
  geminiModel: string;
  systemInstruction: string;
  allowedPhoneNumbers: string[];
  validateTwilioSignature: boolean;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioPhoneNumber?: string;
  webhookTimeoutMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  enableTestEndpoint: boolean;
  sessionTtlMs: number;
  sessionMaxMessages: number;
  sessionStoragePath?: string;
  useFirestore: boolean;
  firestoreCollection: string;
}

/**
 * Normalizes a phone number string to E.164 format (e.g., +12345678901).
 * Returns an empty string if the input is not a valid phone number.
 */
export function normalizePhoneNumber(raw: string): string {
  if (!raw) {
    return '';
  }
  const cleaned = raw.trim().replace(/[\s().-]/g, '');
  if (!cleaned) {
    return '';
  }

  // Already has leading '+'
  if (cleaned.startsWith('+')) {
    return /^\+[1-9]\d{6,14}$/.test(cleaned) ? cleaned : '';
  }

  // 10-digit NANP number -> prefix +1
  if (/^[2-9]\d{9}$/.test(cleaned)) {
    return `+1${cleaned}`;
  }

  // 11-digit NANP number starting with 1 -> prefix +
  if (/^1[2-9]\d{9}$/.test(cleaned)) {
    return `+${cleaned}`;
  }

  return '';
}

export function parseAllowedNumbers(raw?: string): string[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(',')
    .map((num) => normalizePhoneNumber(num))
    .filter((num) => num.length > 0);
}

const defaultGeminiModel = process.env.AI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const isFirebaseRuntime = Boolean(process.env.FIREBASE_CONFIG || process.env.FIRESTORE_EMULATOR_HOST);

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  aiProvider: (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase(),
  aiModel: defaultGeminiModel,
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: defaultGeminiModel,
  systemInstruction:
    process.env.SYSTEM_INSTRUCTION ||
    'You are a personal SMS AI assistant for an offline/in-flight user. Your replies are sent as standard SMS text messages. Be concise, high-signal, and direct. Use plain text only: do not use Markdown (**bold**, ### headings, or ```code``` fences). Prefer short bullet points (-) when listing items.',
  allowedPhoneNumbers: parseAllowedNumbers(process.env.ALLOWED_PHONE_NUMBERS),
  // Default to true (fail-closed) unless explicitly disabled with 'false'
  validateTwilioSignature: process.env.VALIDATE_TWILIO_SIGNATURE !== 'false',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || undefined,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || undefined,
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || undefined,
  webhookTimeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '12000', 10), // Default: 12s (under Twilio's 15s limit)
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '20', 10),
  enableTestEndpoint: process.env.ENABLE_TEST_ENDPOINT === 'true',
  sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || '86400000', 10), // Default: 24 hours
  sessionMaxMessages: parseInt(process.env.SESSION_MAX_MESSAGES || '20', 10), // Default: 20 messages (10 turns)
  sessionStoragePath: process.env.SESSION_STORAGE_PATH || undefined,
  useFirestore:
    process.env.USE_FIRESTORE === 'true' ||
    (isFirebaseRuntime && process.env.USE_FIRESTORE !== 'false'),
  firestoreCollection: process.env.FIRESTORE_COLLECTION || 'conversations',
};

export function validateConfig(): void {
  if (config.aiProvider === 'gemini' && !config.geminiApiKey) {
    console.warn(
      '⚠️  WARNING: GEMINI_API_KEY is not set. Requests to Gemini will fail until you provide a valid API key in .env'
    );
  }

  if (config.validateTwilioSignature && !config.twilioAuthToken) {
    console.warn(
      '⚠️  WARNING: VALIDATE_TWILIO_SIGNATURE is enabled (default), but TWILIO_AUTH_TOKEN is not provided. Webhook requests will be rejected.'
    );
  }

  if (config.allowedPhoneNumbers.length > 0) {
    console.log(`🔒 Phone number allowlist active. Allowed senders: ${config.allowedPhoneNumbers.join(', ')}`);
  } else {
    console.warn(
      '🔒 FAIL-CLOSED: ALLOWED_PHONE_NUMBERS is empty. All incoming SMS requests will be rejected until at least one phone number is configured.'
    );
  }
}
