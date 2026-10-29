import { config } from './config.js';
import { ConversationSession, ConversationStore, conversationStore } from './conversation.js';
import { providerRegistry } from './providers/index.js';

export interface CommandResult {
  handled: boolean;
  reply?: string;
  /**
   * Optional follow-up prompt to forward to the AI model after executing the command
   * (e.g. `/new Explain quantum computing`).
   */
  forwardedPrompt?: string;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function formatStatusReply(session: ConversationSession | null, now: number): string {
  const turnCount = session ? Math.floor(session.messages.length / 2) : 0;
  const msgCount = session ? session.messages.length : 0;
  const ageInfo = session
    ? `Last active: ${formatDuration(now - session.updatedAt)} ago`
    : 'No active thread';

  return [
    `Provider: ${config.aiProvider}`,
    `Model: ${config.aiModel}`,
    `Thread: ${turnCount} turn(s) (${msgCount}/${config.sessionMaxMessages} msgs)`,
    ageInfo,
  ].join('\n');
}

function handleModelCommand(remainder: string): CommandResult {
  const availableProviders = providerRegistry.listNames();
  if (!remainder) {
    return {
      handled: true,
      reply: [
        `Active AI: ${config.aiProvider} / ${config.aiModel}`,
        `Providers: ${availableProviders.join(', ')}`,
        'Usage: /model <model> or /model <provider>:<model>',
      ].join('\n'),
    };
  }

  if (remainder.includes(':')) {
    const [rawProvider, ...modelParts] = remainder.split(':');
    const targetProvider = rawProvider.trim().toLowerCase();
    const targetModel = modelParts.join(':').trim();

    if (!providerRegistry.has(targetProvider)) {
      return {
        handled: true,
        reply: `Unknown provider "${targetProvider}". Available: ${availableProviders.join(', ')}`,
      };
    }
    if (!targetModel) {
      return {
        handled: true,
        reply: 'Please specify a model name after the colon (e.g., /model gemini:gemini-2.5-pro).',
      };
    }

    config.aiProvider = targetProvider;
    config.aiModel = targetModel;
    if (targetProvider === 'gemini') {
      config.geminiModel = targetModel;
    }

    return {
      handled: true,
      reply: `Switched AI to ${config.aiProvider} / ${config.aiModel}.`,
    };
  }

  const lowerRemainder = remainder.toLowerCase();
  if (providerRegistry.has(lowerRemainder)) {
    const provider = providerRegistry.get(lowerRemainder);
    config.aiProvider = provider.name;
    config.aiModel = provider.getDefaultModel();
    return {
      handled: true,
      reply: `Switched AI provider to ${config.aiProvider} (model: ${config.aiModel}).`,
    };
  }

  config.aiModel = remainder;
  if (config.aiProvider === 'gemini') {
    config.geminiModel = remainder;
  }

  return {
    handled: true,
    reply: `Switched model to ${config.aiModel} (provider: ${config.aiProvider}).`,
  };
}

function handleHelpCommand(): CommandResult {
  return {
    handled: true,
    reply: [
      'SMS AI Assistant Commands:',
      '/new (or /reset) - Start a fresh conversation thread',
      '/new <prompt> - Reset thread and ask a new question',
      '/model [name] - View or switch AI model/provider',
      '/status - View active model and current thread info',
      '/help - Show this help message',
    ].join('\n'),
  };
}

/**
 * Parses and executes SMS slash commands synchronously (in-memory/file store).
 */
export function handleSmsCommand(
  phoneNumber: string,
  rawBody: string,
  store: ConversationStore = conversationStore,
  now: number = Date.now()
): CommandResult {
  const trimmed = rawBody.trim();
  if (!trimmed.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = trimmed.indexOf(' ');
  const command = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const remainder = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (command) {
    case '/new':
    case '/reset':
    case '/clear': {
      store.clearSession(phoneNumber);
      if (remainder.length > 0) {
        return { handled: false, forwardedPrompt: remainder };
      }
      return { handled: true, reply: 'Conversation cleared. Starting a new thread.' };
    }
    case '/model':
      return handleModelCommand(remainder);
    case '/help':
      return handleHelpCommand();
    case '/status': {
      const session = store.getSession(phoneNumber, now);
      return { handled: true, reply: formatStatusReply(session, now) };
    }
    default:
      return {
        handled: true,
        reply: `Unknown command "${command}". Send /help for available commands.`,
      };
  }
}

/**
 * Parses and executes SMS slash commands asynchronously (supporting Cloud Firestore).
 */
export async function handleSmsCommandAsync(
  phoneNumber: string,
  rawBody: string,
  store: ConversationStore = conversationStore,
  now: number = Date.now()
): Promise<CommandResult> {
  const trimmed = rawBody.trim();
  if (!trimmed.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = trimmed.indexOf(' ');
  const command = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const remainder = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (command) {
    case '/new':
    case '/reset':
    case '/clear': {
      await store.clearSessionAsync(phoneNumber);
      if (remainder.length > 0) {
        return { handled: false, forwardedPrompt: remainder };
      }
      return { handled: true, reply: 'Conversation cleared. Starting a new thread.' };
    }
    case '/model':
      return handleModelCommand(remainder);
    case '/help':
      return handleHelpCommand();
    case '/status': {
      const session = await store.getSessionAsync(phoneNumber, now);
      return { handled: true, reply: formatStatusReply(session, now) };
    }
    default:
      return {
        handled: true,
        reply: `Unknown command "${command}". Send /help for available commands.`,
      };
  }
}
