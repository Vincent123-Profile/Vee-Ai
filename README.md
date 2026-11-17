# Vee - Ai

Vee - Ai is a multilingual conversational AI assistant created by Agboola Vincent Oluwaseyi. The project contains a browser-based chat interface, a Netlify serverless chat function, Firebase Authentication, Firebase Realtime Database conversation storage, and a private visitor administration page.

## Main features

- Conversational interface with English, Nigerian Pidgin, Yoruba, Hausa, Igbo and other supported languages.
- Chat requests handled by a Netlify Function.
- Groq chat completion integration. The API key stays on the server as a Netlify environment variable.
- Anonymous Firebase Authentication for visitor identity.
- Conversation history stored in Firebase Realtime Database and locally cached in the visitor's browser.
- Network-change grouping through a one-way HMAC fingerprint. Raw visitor IP addresses are not written to the database.
- Private administrator dashboard at `/admin.html`.
- Visitor search, visitor IDs, network fingerprint history, first and last activity, conversation titles and message transcripts.
- Responsive public chat interface with light and dark themes.

## Project structure

```text
/
├── index.html                  Public Vee - Ai chat interface
├── admin.html                  Private administrator dashboard
├── database.rules.json         Realtime Database security rules
└── netlify/
    └── functions/
        └── chat.js             Chat completion and network fingerprint endpoint
```

## How visitor identity and storage work

1. A visitor opens the public chat page.
2. Firebase Anonymous Authentication assigns a stable Firebase UID to the browser's authenticated session.
3. The Netlify Function reads the client connection IP supplied by Netlify and creates an HMAC-SHA256 fingerprint using the server-side `IP_HASH_SECRET`.
4. The browser stores conversations under the visitor UID and network fingerprint.
5. A later network change creates another network group under the same UID when the Firebase anonymous identity is retained.
6. Conversation records contain a session ID, title, creation time, update time and recent messages.

The database structure is:

```text
visitors/
  {visitorUid}/
    networks/
      {networkFingerprint}/
        sessions/
          {sessionId}/
            id
            title
            createdAtMs
            updatedAtMs
            messages/
```

The fingerprint is a keyed hash, not a raw IP address. It is intended for grouping network changes, not identifying a person or recovering an IP address. A browser reset, cleared site data or a different browser profile might create a new anonymous UID.

## Administrator dashboard

Open:

```text
https://YOUR-SITE-DOMAIN/admin.html
```

The dashboard uses Firebase Email/Password Authentication. The authorised administrator email is configured in the dashboard and Realtime Database rules as:

```text
agboolavincent67@icloud.com
```

The dashboard is read-only. It displays visitor IDs, network fingerprints, activity dates, conversation totals and transcripts. It does not provide controls to edit or delete visitor records.

A hidden URL is not an access-control mechanism. Database access is restricted by Firebase Realtime Database rules. Only the administrator email is allowed to read the top-level visitor collection. Anonymous visitors retain read/write access only to their own UID branch.

## Firebase setup

Firebase project used by this application:

- Project ID: `vee-ai-e745e`
- Authentication providers: Anonymous and Email/Password
- Database: Firebase Realtime Database

The Firebase web configuration is included in the client-side application. Firebase web configuration identifies the project and is not a substitute for database security rules. Never put service-account private keys or administrator passwords in browser files or GitHub.

### Authentication

1. Enable Anonymous Authentication for public visitors.
2. Enable Email/Password Authentication for the administrator.
3. Create the administrator account using the authorised email above.
4. Keep the administrator password private.

### Realtime Database rules

The current rules are stored in `database.rules.json`. Publish the same rules in Firebase Console under Realtime Database > Rules:

```json
{
  "rules": {
    "visitors": {
      ".read": "auth != null && auth.token.email === 'agboolavincent67@icloud.com'",
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    }
  }
}
```

The top-level read rule permits the administrator to list visitor records. Each visitor can read and write only their own UID branch. No administrator write permission is granted by these rules.

## Netlify deployment

The project uses Netlify Functions. Connect the GitHub repository to Netlify and configure the site's functions directory according to the repository's Netlify build settings.

Required Netlify environment variables:

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Secret key used by the server-side chat function |
| `IP_HASH_SECRET` | Long random secret used to create keyed network fingerprints |

Set both variables in Netlify's environment variable settings. Do not commit their values to GitHub. Redeploy the site after changing environment variables.

The Firebase database URL and public Firebase web configuration are client-side project settings. They are not server credentials.

## Deploy Preview workflow

Use a feature branch for changes and test the Netlify Deploy Preview before production. The production branch should remain `main`. Do not merge a pull request or publish a production deploy until the owner has reviewed and approved the preview.

## Privacy and security design

- Do not store raw visitor IP addresses in Realtime Database.
- Do not place Groq API keys, HMAC secrets, service-account keys or administrator passwords in frontend code or repository files.
- Keep visitor reads and writes scoped to the authenticated visitor UID.
- Keep top-level visitor listing restricted to the authorised administrator email.
- The administrator dashboard checks the signed-in email before loading visitor data. Firebase rules enforce the actual database access boundary.
- Do not disclose API provider names, credentials or private implementation details in assistant responses. Do not falsely claim the application does not use an API.
- Treat conversation transcripts and visitor records as private data. Share access only with authorised people.

## Maintenance checklist

- Test chat responses after changes to the Netlify Function.
- Test conversation persistence after a page refresh.
- Test anonymous visitor access to the visitor's own records.
- Test administrator sign-in and dashboard loading.
- Confirm a logged-out user cannot read visitor records.
- Confirm a non-administrator account cannot read the visitor collection.
- Review Firebase Authentication users and Netlify environment variables periodically.
- Keep production changes behind owner approval.

## Important implementation notes

The public chat currently keeps a local session cache in browser storage and synchronises cloud history after Firebase initialisation. The browser cache is not the authoritative administrator record. The dashboard reads records stored in Firebase Realtime Database.

Visitor history is currently limited to the records saved by the chat application. The dashboard does not recover deleted browser history or records removed from Firebase.
