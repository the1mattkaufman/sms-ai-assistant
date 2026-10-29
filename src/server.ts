import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`\n🚀 SMS AI Assistant is listening on 0.0.0.0:${config.port}`);
  console.log(`📡 Twilio Webhook URL: http://<your-host>:${config.port}/sms`);
  console.log(`🩺 Health check URL:   http://<your-host>:${config.port}/health\n`);
});

const shutdown = () => {
  console.log('Shutting down server...');
  server.close(() => {
    console.log('Server stopped.');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
