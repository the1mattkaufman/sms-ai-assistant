import express, { Express } from 'express';
import { validateConfig } from './config.js';
import { webhookRouter } from './webhook.js';

export function createApp(): Express {
  const app = express();

  // Trust proxy headers for reverse proxies (ngrok, Cloud Run, etc.)
  app.set('trust proxy', true);

  // Parse Twilio's application/x-www-form-urlencoded webhook payload
  app.use(express.urlencoded({ extended: false }));

  // Parse JSON payloads (for /test and API queries)
  app.use(express.json());

  // Root route
  app.get('/', (_req, res) => {
    res.send('Twilio Gemini SMS AI Assistant is running. Webhook endpoint: POST /sms');
  });

  // Mount the webhook router
  app.use(webhookRouter);

  // Support /webhook/sms as well as /sms
  app.use('/webhook', webhookRouter);

  // Validate environment settings on setup
  validateConfig();

  return app;
}
