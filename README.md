# Vee-AI

A multilingual conversational assistant with persistent browser identity, saved conversations, and a private visitor management dashboard.

## Project structure

- `index.html`: public chat interface, browser identity, and chat history.
- `admin.html`: private administrator dashboard for visitor records and conversations.
- `database.rules.json`: access rules for Firebase Realtime Database.
- `netlify/functions/chat.js`: chat backend.
- `netlify/functions/visitor.js`: visitor identity, profile, conversation storage, and protected administrator operations.
- `package.json`: Firebase Admin SDK dependency.

## Visitor identity

1. On first visit, the server creates one visitor ID.
2. The browser stores the visitor ID and signed token in local storage.
3. Returning visits from the same browser reuse the existing ID.
4. The browser uses one shared identity initialisation process to avoid duplicate visitor records.
5. Clearing browser site data or switching browsers/devices creates a new visitor ID.
6. Network fingerprints are secondary activity records. They do not determine visitor identity.
7. Visitor conversations and profile data are stored in Firebase Realtime Database through the Netlify function.

No visitor sign-in is required. Firebase Authentication is retained for administrator access only.

## Realtime Database structure

```text
visitors/
  {visitorId}/
    profile/
      createdAtMs
      lastSeenAtMs
      visitCount
      displayName
      historyClearedAtMs
    networks/
      {networkFingerprint}/
        lastSeenAtMs
        sessions/
          {sessionId}/
            id
            title
            createdAtMs
            updatedAtMs
            messages/
```

Network fingerprints use keyed HMAC-SHA256 values. Raw IP addresses are not stored.

## Netlify environment variables

Configure these under Netlify environment variables. Never commit their values to GitHub.

| Variable | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase service-account JSON for server-side database access |
| `FIREBASE_DATABASE_URL` | `https://vee-ai-e745e-default-rtdb.firebaseio.com` |
| `VISITOR_TOKEN_SECRET` | Random secret of at least 32 characters for signed visitor tokens |
| `IP_HASH_SECRET` | Existing secret used to create network fingerprints |
| `GROQ_API_KEY` | Existing chat service credential |
| `GROQ_MODEL` | Optional single Groq model ID. Defaults to `openai/gpt-oss-20b`. No automatic model fallback is used. |
| `BUSINESS_AUTOMATION_ENCRYPTION_KEY` | Base64-encoded 32-byte key for encrypting opted-in background business profiles. Keep only in Netlify environment variables. |
| `GMAIL_CLIENT_ID` | Google OAuth web application client ID. |
| `GMAIL_CLIENT_SECRET` | Google OAuth web application client secret. Keep only in Netlify environment variables. |
| `GMAIL_REDIRECT_URI` | Exact Google OAuth callback URL, for example `https://YOUR-SITE.netlify.app/.netlify/functions/gmail?action=callback`. |
| `GMAIL_APP_REDIRECT_URL` | Vee-AI site URL users return to after Google authorisation, for example `https://YOUR-SITE.netlify.app/`. |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | Base64-encoded random 32-byte key used to encrypt Gmail OAuth tokens at rest. Keep only in Netlify environment variables. |

Keep the service-account JSON only in Netlify environment variables.

## Firebase configuration

Enable Email/Password authentication for the administrator account. Visitor sign-in is not used.

Publish the rules from `database.rules.json`. Direct database access requires the authorised administrator email and a verified email claim. The admin dashboard enforces the same check. The Netlify function uses Firebase Admin SDK for visitor operations and transaction-safe conversation writes. Chat rate limiting uses hashed network fingerprints in Firebase. The public client has no direct access to rate-limit records.

Administrator email: `agboolavincent67@gmail.com`.

## Private Business Workspace

The development branch includes a user-owned business profile vault.

- Business profile fields are encrypted in the browser with AES-256-GCM before Firebase storage.
- A passphrase is used to derive the encryption key with PBKDF2-SHA256.
- The passphrase and derived key are not sent to Firebase or the Netlify chat function.
- Encrypted profile records are stored at `privateBusiness/{uid}/vault`.
- Realtime Database rules permit only the matching authenticated UID to read or write this path. The admin dashboard does not query this path.
- The vault is separate from the existing `users/{uid}` data, which retains its existing administrator access rules.
- Losing the vault passphrase means the encrypted profile cannot be recovered. Unlock an existing vault before replacing its contents.
- The user may explicitly send the decrypted profile to Vee-AI for content generation. The selected text is then processed by the configured AI provider.
- Business text import currently supports TXT, Markdown and CSV files, up to 20 KB per file and 50 KB total. Imported text is included in the encrypted profile. PDF and Word extraction are not implemented yet.

This is client-side encrypted storage, not end-to-end encryption for AI processing. Server-side AI generation requires the user to explicitly provide the selected plaintext context. Telegram reminders, automated content delivery and email/document integrations are not implemented by this stage.

## Optional background business processing

The feature branch adds an explicit opt-in endpoint for scheduled business content preparation.

- Background processing is off by default.
- A verified signed-in user must unlock their private vault, tick the approval box, and select Enable.
- The browser sends the selected profile over HTTPS to the authenticated Netlify function. The function encrypts the profile with AES-256-GCM before writing it to `privateBusinessAutomation/{uid}/encryptedProfile`.
- The encryption key is a separate Netlify environment variable, `BUSINESS_AUTOMATION_ENCRYPTION_KEY`, containing base64 for exactly 32 random bytes. Generate a value locally with `openssl rand -base64 32`. Never commit or share the value.
- Firebase client rules deny direct reads and writes to both `privateBusinessAutomation` and its rate-limit path. The function uses Firebase Admin SDK.
- The admin dashboard does not query this path. Firebase project owners and anyone with access to the Netlify service credentials and encryption secret remain trusted infrastructure administrators.
- Disable removes the encrypted automation profile and records revocation. The normal passphrase-encrypted vault is unchanged.
- The scheduled worker checks each user's saved content schedule every minute on published Netlify deployments. The user chooses the delivery time, days, and IANA time zone from the device's local settings. Generation requires both background-processing consent and an enabled content schedule.
- The planner reminder worker also checks every minute. It sends due and overdue task reminders to a linked private Telegram chat at the user's selected local time. Each task is deduplicated per user and local date. Users can pause reminders without deleting their schedule.
- Netlify scheduled functions do not run automatically on Deploy Previews or branch deploys. Use the Netlify Functions page Run now control to test each scheduler in a preview.
- The content worker checks consent and the saved schedule before and after generation, decrypts only for the task, sends the approved profile to Groq, and stores generated drafts under the private automation record. If a linked Telegram account exists, the generated idea is also delivered to that private chat. Users can review generated drafts in Business Workspace.
- Users can retrieve the latest 12 generated drafts through the authenticated function and view them in Business Workspace. Disabling background processing deletes the encrypted automation profile and generated drafts.
- Automatic content delivery uses the user's chosen local schedule. Planner reminders and scheduled content delivery are separate settings. Email intelligence and bank-email analysis are not implemented yet.
- The recurring schedule only becomes active on a published Netlify deployment. Do not merge this feature branch into production until the preview and scheduled function have been tested and the production deployment is approved.

## Gmail Email Intelligence (first implementation)

The development branch adds a Gmail read-only OAuth integration.

- Users sign in to Vee-AI with a verified account before connecting Gmail.
- Google OAuth requests only `https://www.googleapis.com/auth/gmail.readonly`. Vee-AI does not request permission to send, delete, or modify emails.
- OAuth state is random, expires after 10 minutes, and is consumed once.
- Access and refresh tokens are encrypted with AES-256-GCM using `GMAIL_TOKEN_ENCRYPTION_KEY` before Firebase storage. Client database rules deny direct access to Gmail token and OAuth state paths.
- The first scan reads up to 30 recent Gmail messages. It stores selected metadata, snippets and rule-based categories for the user's dashboard. It does not yet create Finance transactions automatically.
- Initial categories include bank alerts, flights, job-related messages, promotions and general mail. Suspicious link indicators include known URL shorteners, raw IP links, internationalised domains and credential-pressure language.
- The initial security checks are heuristic triage, not a malware sandbox or a guarantee that a link is safe. Vee-AI does not open extracted links.
- Dashboard actions include connect, scan, filter, and disconnect. Disconnect deletes the stored token and scanned message records from Vee-AI. It does not delete messages from Gmail.
- Linked Telegram users can use `/emails` for recent email intelligence and `/security` for flagged findings.
- Email content is not sent to the AI model in this first implementation. Classification is performed with local deterministic rules in the Netlify function.
- Gmail API must be enabled in Google Cloud. Configure an OAuth consent screen and a Web application OAuth client. Add the exact callback URL from `GMAIL_REDIRECT_URI` to the authorised redirect URIs. Add the deployed Vee-AI domain to authorised JavaScript origins only if Google Console requests it.
- Generate `GMAIL_TOKEN_ENCRYPTION_KEY` locally with `openssl rand -base64 32`. Never paste the key into chat or commit it to GitHub.
- Configure all Gmail environment variables for the Netlify Deploy Preview context before testing. Google OAuth may require the account to be listed as a test user while the consent screen is in Testing. Public release may require Google's verification process for Gmail restricted scopes.

This first stage does not yet include Outlook, full attachment scanning, automatic bank transaction posting, continuous Gmail push notifications, or advanced malware detonation.

## Admin dashboard

Open `/admin.html` on the deployed site and sign in with the authorised administrator account.

The dashboard reads visitor records from Firebase and displays:
- Total visitors, new visitors, and returning visitors.
- Visitors who supplied a display name.
- Visitor IDs, first visit, last activity, and visit count.
- Network fingerprints.
- Conversation titles, timestamps, and saved message transcripts.
- Search by visitor ID, network fingerprint, or conversation title.
- A control to delete a visitor's saved conversation history while retaining the visitor ID.

Firebase Console is not needed for routine visitor or conversation review.

## Deployment and testing

1. Configure the Netlify environment variables.
2. Confirm Email/Password authentication is enabled for the administrator.
3. Publish the updated database rules.
4. Deploy a preview from the feature branch.
5. Visit Vee-AI, refresh, and confirm the same visitor ID is reused.
6. Confirm invalid chat roles are rejected and the sixteenth request within one minute from the same network fingerprint receives a rate-limit response.
7. Start a conversation and confirm the transcript appears in the admin dashboard.
8. Clear browser site data to verify a fresh visitor ID is created.

Production branch `main` is not changed by feature-branch commits.
