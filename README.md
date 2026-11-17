# Vee-AI

A multilingual conversational assistant with persistent conversations and a private visitor management dashboard.

## Project structure

```text
/
├── index.html
├── admin.html
├── database.rules.json
├── package.json
└── netlify/
    └── functions/
        ├── chat.js
        └── visitor.js
```

- `index.html` contains the public chat interface, persistent browser identity, and optional Google account linking.
- `admin.html` contains administrator sign-in and visitor analytics.
- `database.rules.json` restricts direct database access to the authorised administrator.
- `netlify/functions/chat.js` handles chat requests and network fingerprint generation.
- `netlify/functions/visitor.js` verifies visitor tokens, stores conversations, links Google identities, and serves administrator operations.
- `package.json` installs the Firebase Admin SDK for secure server-side database access.

## Visitor identity

1. A visitor starts with a persistent browser identity stored in local storage.
2. The server issues a signed visitor token. Refreshing the page reuses the same visitor record.
3. No Firebase anonymous account is created for guest visits.
4. Visitors optionally sign in with Google to link their Google UID to the existing visitor record.
5. After browser data is cleared, a visitor signs in with the same Google account to recover the linked record.
6. Network changes create additional hashed network entries under the same visitor.
7. Conversation records are written through the Netlify function, not directly from the public browser.

A visitor who clears browser data before linking Google starts a new identity. A Google account already linked to another visitor cannot be linked to a second visitor.

## Realtime Database structure

```text
visitors/
  {visitorId}/
    profile/
      createdAtMs
      lastSeenAtMs
      googleLinked
      historyClearedAtMs
    identity/
      googleUid
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

googleIndex/
  {googleUid}: {visitorId}
```

Network fingerprints use keyed HMAC-SHA256 values. Raw IP addresses are not stored in the database.

## Required Netlify environment variables

Configure these under Netlify site environment variables. Never commit their values to GitHub.

| Variable | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Full Firebase service-account JSON for the server-side Admin SDK |
| `FIREBASE_DATABASE_URL` | `https://vee-ai-e745e-default-rtdb.firebaseio.com` |
| `VISITOR_TOKEN_SECRET` | Random secret of at least 32 characters for signing visitor tokens |
| `IP_HASH_SECRET` | Existing secret used to create network fingerprints |
| `GROQ_API_KEY` | Existing chat service credential |

The service-account JSON belongs only in Netlify environment variables. Never place the private key in frontend code, README files, or GitHub.

## Firebase configuration

Enable these Firebase Authentication providers:

- Google, for optional visitor linking and recovery.
- Email/Password, for administrator access.

Guest visitors do not use Firebase Anonymous Authentication.

Publish the rules from `database.rules.json`. Direct Realtime Database reads and writes are restricted to the authorised administrator email. The Netlify function uses the Firebase Admin SDK for visitor operations.

The administrator email configured in the rules and `admin.html` is `agboolavincent67@icloud.com`.

## Admin dashboard

Open `/admin.html` on the deployed site and sign in with the authorised administrator account.

The dashboard displays:

- Total visitors.
- Network fingerprints.
- Conversation count.
- Google-linked visitor count.
- Visitor IDs, activity and conversation transcripts.
- Search and visitor history deletion.

## Deployment and testing

1. Configure the required Netlify environment variables.
2. Confirm Google and Email/Password providers are enabled in Firebase Authentication.
3. Publish the database rules.
4. Deploy the feature branch preview.
5. Test a guest visit and refresh. The visitor count must stay unchanged.
6. Link a Google account, clear browser site data, then sign in again to test recovery.
7. Test a network change and confirm the visitor ID stays the same.
8. Test the admin dashboard and history deletion.
9. Review the feature branch before approving any production deployment.

Production branch `main` is not changed by feature-branch commits.
