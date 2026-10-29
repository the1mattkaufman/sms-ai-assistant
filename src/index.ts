import { onRequest } from 'firebase-functions/v2/https';
import { createApp } from './app.js';

export { createApp };

/**
 * Firebase Cloud Functions (2nd Gen) HTTPS entrypoint.
 * Deploys the Express application to Google Cloud Run via Firebase CLI (`firebase deploy`).
 */
export const smsAiAssistant = onRequest(
  {
    region: 'us-central1',
    maxInstances: 2,
    timeoutSeconds: 60,
    memory: '256MiB',
    invoker: 'public',
  },
  createApp()
);
