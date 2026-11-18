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
| `GROQ_API_KEY` | Existing chat service credential |\n| `GROQ_MODEL` | Optional single Groq model ID. Defaults to `openai/gpt-oss-20b`. No automatic model fallback is used. |

Keep the service-account JSON only in Netlify environment variables.

## Firebase configuration

Enable Email/Password authentication for the administrator account. Visitor sign-in is not used.

Publish the rules from `database.rules.json`. Direct database access requires the authorised administrator email and a verified email claim. The admin dashboard enforces the same check. The Netlify function uses Firebase Admin SDK for visitor operations and transaction-safe conversation writes. Chat rate limiting uses hashed network fingerprints in Firebase. The public client has no direct access to rate-limit records.

Administrator email: `agboolavincent67@icloud.com`.

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
3. Publish the database rules.
4. Deploy the feature branch preview.
5. Visit Vee-AI, refresh, and confirm the same visitor ID is reused.\n6. Confirm the chat endpoint accepts only user and assistant history roles and returns a rate-limit response after 15 requests in one minute from the same network fingerprint.
6. Save an optional display name in settings.
7. Start a conversation and confirm the transcript appears in the admin dashboard.
8. Clear browser site data to verify a fresh visitor ID is created.

Production branch `main` is not changed by feature-branch commits.
