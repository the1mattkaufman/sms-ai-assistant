import fs from 'node:fs';
import path from 'node:path';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { config, normalizePhoneNumber } from './config.js';

export type MessageRole = 'user' | 'assistant';

export interface ChatMessage {
  role: MessageRole;
  content: string;
  timestamp: number;
}

export interface ConversationSession {
  phoneNumber: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Minimal interface for a Firestore DocumentReference / CollectionReference,
 * allowing both real `firebase-admin/firestore` and lightweight unit test mocks.
 */
export interface FirestoreDocLike {
  get(): Promise<{ exists: boolean; data(): ConversationSession | undefined }>;
  set(data: ConversationSession): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface FirestoreCollectionLike {
  doc(id: string): FirestoreDocLike;
}

let defaultFirestoreCollection: FirestoreCollectionLike | null = null;

function resolveDefaultFirestoreCollection(): FirestoreCollectionLike {
  if (!defaultFirestoreCollection) {
    if (getApps().length === 0) {
      initializeApp();
    }
    const db = getFirestore();
    defaultFirestoreCollection = db.collection(
      config.firestoreCollection || 'conversations'
    ) as unknown as FirestoreCollectionLike;
  }
  return defaultFirestoreCollection;
}

/**
 * Manages stateful multi-turn conversation threads per sender phone number.
 * Supports Cloud Firestore (serverless persistence), optional local JSON file persistence,
 * and in-memory storage with sliding context windows and automatic TTL expiration.
 */
export class ConversationStore {
  private sessions: Map<string, ConversationSession> = new Map();
  private storagePath?: string;
  private customFirestore?: FirestoreCollectionLike;

  constructor(storagePath?: string, customFirestore?: FirestoreCollectionLike) {
    this.storagePath = storagePath;
    this.customFirestore = customFirestore;
    if (this.storagePath) {
      this.loadFromDisk();
    }
  }

  private getActiveFirestore(): FirestoreCollectionLike | null {
    if (this.customFirestore) {
      return this.customFirestore;
    }
    if (config.useFirestore) {
      return resolveDefaultFirestoreCollection();
    }
    return null;
  }

  private resolveKey(phoneNumber: string): string {
    return normalizePhoneNumber(phoneNumber) || phoneNumber.trim();
  }

  private isExpired(session: ConversationSession, ttlMs: number, now: number): boolean {
    if (ttlMs <= 0) {
      return true;
    }
    return now - session.updatedAt > ttlMs;
  }

  private trimMessages(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
    if (maxMessages <= 0) {
      return [];
    }
    let result = [...messages];
    if (result.length > maxMessages) {
      result = result.slice(result.length - maxMessages);
      while (result.length > 0 && result[0].role !== 'user') {
        result.shift();
      }
    }
    return result;
  }

  /**
   * Synchronous session lookup (in-memory / local disk).
   */
  public getSession(
    phoneNumber: string,
    now: number = Date.now(),
    ttlMs: number = config.sessionTtlMs
  ): ConversationSession | null {
    const key = this.resolveKey(phoneNumber);
    const session = this.sessions.get(key);
    if (!session) {
      return null;
    }

    if (this.isExpired(session, ttlMs, now)) {
      this.sessions.delete(key);
      this.saveToDisk();
      return null;
    }

    return session;
  }

  /**
   * Asynchronous session lookup (reads from Cloud Firestore when enabled, otherwise local store).
   */
  public async getSessionAsync(
    phoneNumber: string,
    now: number = Date.now(),
    ttlMs: number = config.sessionTtlMs
  ): Promise<ConversationSession | null> {
    const firestoreCol = this.getActiveFirestore();
    if (!firestoreCol) {
      return this.getSession(phoneNumber, now, ttlMs);
    }

    const key = this.resolveKey(phoneNumber);
    const snap = await firestoreCol.doc(key).get();
    if (!snap.exists) {
      this.sessions.delete(key);
      return null;
    }

    const session = snap.data();
    if (!session || !Array.isArray(session.messages)) {
      return null;
    }

    if (this.isExpired(session, ttlMs, now)) {
      await firestoreCol.doc(key).delete();
      this.sessions.delete(key);
      return null;
    }

    this.sessions.set(key, session);
    return session;
  }

  /**
   * Synchronous conversation history lookup.
   */
  public getHistory(
    phoneNumber: string,
    now: number = Date.now(),
    ttlMs: number = config.sessionTtlMs
  ): ChatMessage[] {
    const session = this.getSession(phoneNumber, now, ttlMs);
    return session ? [...session.messages] : [];
  }

  /**
   * Asynchronous conversation history lookup (reads from Cloud Firestore when enabled).
   */
  public async getHistoryAsync(
    phoneNumber: string,
    now: number = Date.now(),
    ttlMs: number = config.sessionTtlMs
  ): Promise<ChatMessage[]> {
    const session = await this.getSessionAsync(phoneNumber, now, ttlMs);
    return session ? [...session.messages] : [];
  }

  /**
   * Synchronously records a user prompt and assistant response in the sender's thread.
   */
  public addExchange(
    phoneNumber: string,
    userPrompt: string,
    assistantReply: string,
    now: number = Date.now(),
    maxMessages: number = config.sessionMaxMessages,
    ttlMs: number = config.sessionTtlMs
  ): ConversationSession {
    const key = this.resolveKey(phoneNumber);
    let session = this.getSession(key, now, ttlMs);

    if (!session) {
      session = {
        phoneNumber: key,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
    }

    session.messages.push(
      { role: 'user', content: userPrompt.trim(), timestamp: now },
      { role: 'assistant', content: assistantReply.trim(), timestamp: now }
    );
    session.updatedAt = now;
    session.messages = this.trimMessages(session.messages, maxMessages);

    this.sessions.set(key, session);
    this.saveToDisk();
    return session;
  }

  /**
   * Asynchronously records a user prompt and assistant response (persisting to Cloud Firestore when enabled).
   */
  public async addExchangeAsync(
    phoneNumber: string,
    userPrompt: string,
    assistantReply: string,
    now: number = Date.now(),
    maxMessages: number = config.sessionMaxMessages,
    ttlMs: number = config.sessionTtlMs
  ): Promise<ConversationSession> {
    const firestoreCol = this.getActiveFirestore();
    if (!firestoreCol) {
      return this.addExchange(phoneNumber, userPrompt, assistantReply, now, maxMessages, ttlMs);
    }

    const key = this.resolveKey(phoneNumber);
    let session = await this.getSessionAsync(key, now, ttlMs);

    if (!session) {
      session = {
        phoneNumber: key,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
    }

    session.messages.push(
      { role: 'user', content: userPrompt.trim(), timestamp: now },
      { role: 'assistant', content: assistantReply.trim(), timestamp: now }
    );
    session.updatedAt = now;
    session.messages = this.trimMessages(session.messages, maxMessages);

    this.sessions.set(key, session);
    await firestoreCol.doc(key).set(session);
    return session;
  }

  /**
   * Synchronously clears the conversation session for a phone number.
   */
  public clearSession(phoneNumber: string): boolean {
    const key = this.resolveKey(phoneNumber);
    const existed = this.sessions.delete(key);
    if (existed) {
      this.saveToDisk();
    }
    return existed;
  }

  /**
   * Asynchronously clears the conversation session (deleting from Cloud Firestore when enabled).
   */
  public async clearSessionAsync(phoneNumber: string): Promise<boolean> {
    const firestoreCol = this.getActiveFirestore();
    const key = this.resolveKey(phoneNumber);
    const existedLocal = this.clearSession(key);

    if (firestoreCol) {
      await firestoreCol.doc(key).delete();
      return true;
    }

    return existedLocal;
  }

  /**
   * Clears all sessions in memory and on disk.
   */
  public clearAll(): void {
    this.sessions.clear();
    this.saveToDisk();
  }

  private loadFromDisk(): void {
    if (!this.storagePath) {
      return;
    }
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, ConversationSession>;
        this.sessions.clear();
        for (const [key, session] of Object.entries(parsed)) {
          if (session && Array.isArray(session.messages)) {
            this.sessions.set(key, session);
          }
        }
      }
    } catch (error) {
      console.error(`[ConversationStore] Failed to load sessions from ${this.storagePath}:`, error);
    }
  }

  private saveToDisk(): void {
    if (!this.storagePath) {
      return;
    }
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const serialized = JSON.stringify(Object.fromEntries(this.sessions.entries()), null, 2);
      fs.writeFileSync(this.storagePath, serialized, 'utf-8');
    } catch (error) {
      console.error(`[ConversationStore] Failed to save sessions to ${this.storagePath}:`, error);
    }
  }
}

export const conversationStore = new ConversationStore(config.sessionStoragePath);
