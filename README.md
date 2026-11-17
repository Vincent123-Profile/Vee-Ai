# Vee - Ai

**A multilingual AI assistant with persistent conversations and a private visitor management dashboard.**

Vee - Ai is a personal AI project developed by **Agboola Vincent Oluwaseyi**. The project combines a responsive chat experience with cloud-backed conversation history, anonymous visitor identity, network-change grouping, and an administrator dashboard.

## Project highlights

- **Conversational AI:** Chat interface designed for natural conversations in English, Nigerian Pidgin, Yoruba, Hausa, Igbo, and other languages supported by the model.
- **Persistent conversations:** Recent chat sessions are cached in the visitor's browser and synchronised with Firebase Realtime Database.
- **Anonymous visitor identity:** Firebase Authentication assigns each browser an anonymous UID.
- **Network-change grouping:** A server-side keyed HMAC-SHA256 fingerprint groups activity by network without writing the raw IP address into the app's database.
- **Private admin dashboard:** An authenticated administrator reviews visitor records, activity dates, network fingerprints, conversation titles, and saved transcripts.
- **Responsive interface:** Mobile-friendly layout with light and dark themes.
- **Server-side AI requests:** The model API key is stored in Netlify environment variables rather than in frontend JavaScript.

## Technology

| Area | Technology |
| --- | --- |
| Frontend | HTML, CSS, JavaScript |
| Serverless backend | Netlify Functions |
| AI inference | Groq API |
| Authentication | Firebase Authentication |
| Conversation storage | Firebase Realtime Database |
| Source control | GitHub |
| Hosting | Netlify |

## Application structure

```text
/
├── index.html
├── admin.html
├── database.rules.json
├── README.md
└── netlify/
    └── functions/
        └── chat.js
```

- `index.html` contains the public chat interface and Firebase conversation synchronisation.
- `admin.html` contains the administrator sign-in and visitor dashboard.
- `database.rules.json` contains the Realtime Database access rules.
- `netlify/functions/chat.js` handles AI requests and generates the network fingerprint.

## Visitor data flow

1. A visitor opens the chat interface.
2. Firebase Anonymous Authentication assigns a UID to the browser session.
3. The browser requests a network fingerprint from the Netlify Function.
4. The function calculates a keyed HMAC-SHA256 fingerprint using the connection IP supplied by Netlify and the server-side `IP_HASH_SECRET`.
5. The browser stores conversation sessions under its own UID and network fingerprint.
6. The administrator signs in through Firebase Email/Password Authentication to review records permitted by the database rules.

The database structure follows this pattern:

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

The fingerprint is a keyed hash. It is not a raw IP address and is not designed to identify a person or recover an IP address. A cleared browser profile, deleted site data, or a different browser might receive a new anonymous UID.

## Administrator dashboard

The dashboard is available at:

```text
https://YOUR-SITE-DOMAIN/admin.html
```

The dashboard provides:

- Visitor count, network fingerprint count, and conversation count.
- Search by visitor UID, fingerprint, or conversation title.
- Visitor activity dates.
- Network fingerprint history.
- Saved conversation transcripts.

The dashboard is read-only. The dashboard page itself is not a security boundary. Firebase Authentication and Realtime Database rules control access to visitor records. The authorised administrator email must match the value configured in both `admin.html` and `database.rules.json`.

## Privacy and security

Vee - Ai uses access controls and data minimisation measures, but no online service should be described as completely private.

- Visitors authenticate anonymously. Their records are scoped to their Firebase UID.
- The administrator account has permission to read the visitor collection.
- The app stores conversation content in Firebase Realtime Database for history and dashboard access.
- Conversation prompts and context are sent to the configured AI inference provider to generate responses.
- Requests pass through Netlify Functions. Netlify supplies the connection IP used to calculate the keyed network fingerprint.
- The app does not write raw IP addresses into its Firebase visitor records.
- The Firebase web configuration is visible in the browser. Firebase security depends on Authentication and database rules, not on hiding the web configuration.
- The AI API key and HMAC secret must stay in Netlify environment variables.
- Never commit API keys, passwords, service-account private keys, or secret environment-variable values to GitHub.

Visitors should avoid entering passwords, financial credentials, government identifiers, or other highly sensitive information into conversations.

## Setup

### 1. Firebase

1. Create a Firebase project.
2. Enable Anonymous Authentication.
3. Enable Email/Password Authentication.
4. Create the administrator account.
5. Create a Realtime Database.
6. Add the Firebase web configuration to the frontend and admin page.
7. Configure the Realtime Database rules.

Use a rules structure like the following. Replace the administrator email with the address used for your own Firebase admin account.

```json
{
  "rules": {
    "visitors": {
      ".read": "auth != null && auth.token.email === 'ADMIN_EMAIL'",
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    }
  }
}
```

The administrator receives read access to the visitor collection. Each authenticated visitor receives read and write access only to their own UID branch. These rules do not grant the administrator write access.

### 2. Netlify

Set these environment variables in the Netlify site settings:

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Server-side AI API authentication |
| `IP_HASH_SECRET` | Secret used to create keyed network fingerprints |

Use long, unique secret values. Do not put their values in frontend files or GitHub. Redeploy after changing environment variables.

### 3. Deploy

1. Connect the GitHub repository to Netlify.
2. Confirm the Netlify Functions directory is configured.
3. Add the required environment variables.
4. Deploy a feature branch preview.
5. Test visitor sign-in, chat responses, conversation persistence, and administrator access before promoting changes to production.

## Testing checklist

- [ ] A new visitor receives an anonymous Firebase UID.
- [ ] A visitor's conversation remains available after a page refresh.
- [ ] A visitor cannot read another visitor's records.
- [ ] A signed-out user cannot read visitor records.
- [ ] A non-admin account cannot list the visitor collection.
- [ ] The authorised administrator can sign in and view saved records.
- [ ] The administrator dashboard does not grant write access.
- [ ] Netlify environment variables are configured and absent from Git history.

## Project status

The visitor dashboard and Firebase access rules have been implemented and tested in a Netlify Deploy Preview. Production release should follow a separate review and approval.

## Developer

**Agboola Vincent Oluwaseyi**

Vee - Ai is an independent project focused on conversational AI, web development, cloud data storage, authentication, and practical visitor management.
