# SMS AI Assistant

An SMS-based AI chat assistant built with Node.js, TypeScript, Twilio, and Firebase / Google Cloud. Designed to keep you productive when you have cellular/SMS connectivity but no internet access—such as flying on an airplane with free in-flight messaging or working in low-bandwidth areas.

---

## 🎯 Goals & Core Requirements

1. **Offline / SMS-Only Productivity**: Interact with a capable AI assistant entirely over standard SMS via Twilio.
2. **Strict Owner-Only Security**: Fail-closed access control combining Twilio cryptographic webhook signature verification (`X-Twilio-Signature`) and strict sender phone number allowlisting so only you can use the service.
3. **Stateful Multi-Turn Conversations**: Maintain conversation threads across messages (backed by **Cloud Firestore** in production or in-memory/JSON locally) so you can pause for hours mid-flight and resume right where you left off.
4. **Provider-Agnostic AI Architecture**: Decouple the SMS/session pipeline from any single LLM vendor using a clean provider interface, starting with the **Google Gemini API** (`@google/genai`).

---

## 🏗️ Architecture

### High-Level Data Flow

```
┌─────────────┐     SMS      ┌────────────┐   Webhook (POST /sms)   ┌──────────────────────────────────────────┐
│  Your Phone │ ───────────> │   Twilio   │ ──────────────────────> │             SMS AI Assistant             │
│ (Authorized)│ <─────────── │ Phone Num  │ <────────────────────── │  (Firebase Functions v2 / Cloud Run)     │
└─────────────┘   SMS Reply  └────────────┘      TwiML Response     └────────────────────┬─────────────────────┘
                                                                                         │
                         ┌───────────────────────────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────┐
│ 1. Security & Auth Middleware (src/security.ts) │
│    • Twilio Signature Verification              │
│    • Fail-Closed Sender Allowlist (E.164)       │
│    • Sliding-Window Rate Limiting               │
└────────────────────────┬────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────┐      ┌────────────────────────┐
│ 2. Command & Session Manager                    │ <──> │  Cloud Firestore       │
│    • Slash Commands (/new, /model, /status)     │      │  (conversations/{num}) │
│    • Per-Sender Thread Store & History Window   │      │  Serverless Persistence│
│    • Session TTL / Auto-Expiry                  │      └────────────────────────┘
└────────────────────────┬────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────┐      ┌────────────────────────┐
│ 3. Agnostic AI Provider Layer (src/providers/)  │ ───> │  Google Gemini API     │
│    • Unified AIProvider Interface & Registry    │      │  (Primary Provider)    │
│    • Pluggable Provider Adapters                │      ├────────────────────────┤
└────────────────────────┬────────────────────────┘ ───> │  Future Providers      │
                         ▼                               │  (OpenAI / Claude / …) │
┌─────────────────────────────────────────────────┐      └────────────────────────┘
│ 4. SMS Formatter & Delivery                     │
│    • Plain-text Markdown stripping              │
│    • Smart multi-chunk splitting ([1/N])        │
│    • Sync TwiML + Async Twilio REST Fallback    │
└─────────────────────────────────────────────────┘
```

### Core Components

| Component | File(s) | Responsibility |
| :--- | :--- | :--- |
| **Entrypoints** | [`src/index.ts`](src/index.ts), [`src/server.ts`](src/server.ts) | `src/index.ts` exports the Firebase Cloud Functions (2nd Gen) `smsAiAssistant` HTTPS handler; `src/server.ts` runs the standalone Express server for local dev and Docker/Cloud Run. |
| **HTTP & Webhook Layer** | [`src/app.ts`](src/app.ts), [`src/webhook.ts`](src/webhook.ts) | Receives Twilio `POST /sms` webhooks, validates requests, orchestrates session + AI calls, and returns TwiML XML. |
| **Security Middleware** | [`src/security.ts`](src/security.ts) | Enforces fail-closed phone number allowlisting (`ALLOWED_PHONE_NUMBERS`), verifies `X-Twilio-Signature` (supporting both `.a.run.app` and `cloudfunctions.net` URLs), and drops unauthorized traffic silently (`<Response/>`). |
| **Conversation Store** | [`src/conversation.ts`](src/conversation.ts), [`firestore.rules`](firestore.rules) | Manages multi-turn chat history keyed by normalized E.164 phone number via **Cloud Firestore** (`firebase-admin/firestore`) or local in-memory/JSON storage. |
| **Command Handler** | [`src/commands.ts`](src/commands.ts) | Intercepts control commands (`/new`, `/reset`, `/clear`, `/model`, `/status`, `/help`) before hitting the LLM. |
| **AI Provider Layer** | [`src/providers/`](src/providers/index.ts), [`src/gemini.ts`](src/gemini.ts) | Defines the provider-agnostic `AIProvider` interface, `ProviderRegistry`, and implements `GeminiProvider` as the default adapter. |
| **SMS Formatter** | [`src/sms-formatter.ts`](src/sms-formatter.ts) | Strips Markdown (`formatForSms`), splits long responses cleanly on paragraph/sentence boundaries, and adds `[1/N]` pagination markers. |
| **Async Outbound Sender** | [`src/twilio-sender.ts`](src/twilio-sender.ts) | Delivers delayed AI responses via the Twilio REST API when LLM generation exceeds the synchronous webhook timeout (`WEBHOOK_TIMEOUT_MS`). |

---

## ✅ Implementation Roadmap

### Phase 1: Security Hardening (Owner-Only Access)
- [x] **Fail-Closed Allowlist**: Require `ALLOWED_PHONE_NUMBERS` by default (reject requests if allowlist is empty).
- [x] **Silent Rejection for Unauthorized Numbers**: Return an empty `<Response/>` for unauthorized senders instead of sending an `"Access Denied"` SMS that costs Twilio credits.
- [x] **Strict E.164 Matching**: Exact normalized E.164 phone number comparison.
- [x] **Enforce Twilio Signature Validation**: Default `VALIDATE_TWILIO_SIGNATURE=true` and support both Cloud Run and Firebase Functions webhook URLs.
- [x] **Rate Limiting**: Per-number sliding-window rate limiting to guard against accidental loops or webhook abuse.

### Phase 2: Multi-Turn Conversation Threads & Firestore Persistence
- [x] **Conversation History Store**: Store multi-turn message history (`user` / `assistant` turns) per phone number.
- [x] **Serverless Cloud Firestore Persistence**: Persist threads in `conversations/{phoneNumber}` via `firebase-admin/firestore` with strict default-deny [`firestore.rules`](firestore.rules) so threads survive scale-to-zero container shutdowns mid-flight.
- [x] **Context Window & TTL Management**: Cap stored history to the last $N$ messages and auto-expire inactive threads after `SESSION_TTL_MS`.
- [x] **SMS Control Commands**: `/new` (`/reset`, `/clear`), `/status`, and `/help`.

### Phase 3: Model-Agnostic AI Layer
- [x] **Define `AIProvider` Interface**: Standard TypeScript interface supporting multi-turn chat, system instructions, and model selection.
- [x] **Refactor Gemini into `GeminiProvider`**: Multi-turn `contents` implementation with `@google/genai`.
- [x] **Provider Registry & `/model` Command**: Configure `AI_PROVIDER` / `AI_MODEL` via `.env` or switch dynamically via `/model` SMS command.

### Phase 4: Offline / In-Flight UX Enhancements
- [x] **Async Outbound Messaging Fallback**: Handle slow LLM responses (>12s) by acknowledging the webhook immediately and sending the reply via Twilio REST API.
- [x] **Concise SMS Mode**: Strip Markdown formatting (`formatForSms`) and tune system instructions for compact plain-text SMS readability.

---

## ☁️ Deployment Guide (Firebase Functions v2 + Firestore or Cloud Run)

The project is configured to support **both** deployment workflows out of the box:
- **Option A: Firebase CLI (`firebase deploy`)** — Deploys the 2nd Gen Cloud Function (`smsAiAssistant`) and locked-down [`firestore.rules`](firestore.rules) together, with automatic Cloud Firestore session persistence (`USE_FIRESTORE=true` automatically in Firebase).
- **Option B: Google Cloud Run (`gcloud run deploy`)** — Deploys the container directly via [`Dockerfile`](Dockerfile) and can also use Cloud Firestore by setting `USE_FIRESTORE=true`.

### Option A: Deploy with Firebase (Recommended for Serverless Firestore Persistence)

1. **Authenticate & Select Your Firebase Project**:
   ```bash
   npx firebase-tools login
   npx firebase-tools use --add YOUR_FIREBASE_PROJECT_ID
   ```

2. **Ensure Cloud Firestore is Provisioned**:
   Create a Firestore database in your project if you haven't already:
   ```bash
   npx firebase-tools firestore:databases:create "(default)" --location="nam5"
   ```

3. **Configure Environment Variables for the Function**:
   Create a `.env.<YOUR_FIREBASE_PROJECT_ID>` (or `.env`) file in the project root with your production settings:
   ```env
   AI_PROVIDER=gemini
   AI_MODEL=gemini-2.5-flash
   GEMINI_API_KEY=your_gemini_api_key
   ALLOWED_PHONE_NUMBERS=+1YOUR_CELL_NUMBER
   VALIDATE_TWILIO_SIGNATURE=true
   TWILIO_ACCOUNT_SID=your_twilio_account_sid
   TWILIO_AUTH_TOKEN=your_twilio_auth_token
   TWILIO_PHONE_NUMBER=+1YOUR_TWILIO_NUMBER
   USE_FIRESTORE=true
   ```

4. **Deploy Functions & Firestore Security Rules**:
   ```bash
   npm run deploy:firebase
   ```

5. **Configure Your Twilio Webhook**:
   - Copy the deployed function URL (either the `.a.run.app` URL or `https://us-central1-<project>.cloudfunctions.net/smsAiAssistant`) and append `/sms`.
   - Paste it into the [Twilio Console](https://console.twilio.com/) under **Phone Numbers** -> **Active numbers** -> **Messaging Configuration** -> **"A MESSAGE COMES IN"** (`HTTP POST`).

---

### Option B: Deploy Directly to Google Cloud Run

```bash
gcloud run deploy sms-ai-assistant \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=2 \
  --set-env-vars="AI_PROVIDER=gemini,AI_MODEL=gemini-2.5-flash,USE_FIRESTORE=true,VALIDATE_TWILIO_SIGNATURE=true,ALLOWED_PHONE_NUMBERS=+1YOUR_CELL_NUMBER,TWILIO_PHONE_NUMBER=+1YOUR_TWILIO_NUMBER,GEMINI_API_KEY=YOUR_GEMINI_KEY,TWILIO_ACCOUNT_SID=YOUR_TWILIO_SID,TWILIO_AUTH_TOKEN=YOUR_TWILIO_AUTH_TOKEN"
```

---

## 🛠️ Local Development & Testing

### 1. Install & Configure
```bash
npm install
cp .env.example .env
```

### 2. Start Local Development Server
```bash
npm run dev
```

### 3. Run Automated Test Suite
```bash
npm test
```

### 4. SMS Commands Reference
Once deployed, text any of these commands from your allowlisted phone number:
- `/new` (or `/reset`, `/clear`) — Clear the current conversation history and start a fresh thread.
- `/new <prompt>` — Reset the thread and immediately ask a new question in a single SMS.
- `/model` — View the active AI provider, model, and available providers.
- `/model <model>` — Switch the active model (e.g., `/model gemini-2.5-pro` or `/model gemini:gemini-2.5-flash`).
- `/status` — Check active provider/model, turn count in the current thread, and time since last message.
- `/help` — List available SMS commands.

---

## 📄 License
ISC
