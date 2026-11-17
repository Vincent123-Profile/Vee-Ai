# Vee-AI

A multilingual conversational assistant with persistent conversations and a private visitor management dashboard.

Vee-AI is a personal project developed by Agboola Vincent Oluwaseyi. The project combines a responsive chat experience with cloud-backed conversation history, anonymous visitor identity, network-change grouping, and an administrator dashboard.

## Project highlights

- Conversational experience in English, Nigerian Pidgin, Yoruba, Hausa, Igbo, and other supported languages.
- Persistent conversations cached in the visitor's browser and synchronised with Firebase Realtime Database.
- Anonymous visitor identity through Firebase Authentication.
- Network-change grouping through keyed HMAC-SHA256 fingerprints. Raw IP addresses are not written into the app database.
- Private administrator dashboard for visitor IDs, activity dates, network fingerprints, conversation titles, and saved transcripts.
- Responsive mobile interface with light and dark themes.

## Technology

| Area | Technology |
| --- | --- |
| Frontend | HTML, CSS, JavaScript |
| Serverless backend | Netlify Functions |
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

- `index.html` contains the public chat interface and conversation synchronisation.
- `admin.html` contains administrator sign-in and the visitor dashboard.
- `database.rules.json` contains Realtime Database access rules.
- `netlify/functions/chat.js` handles chat requests and generates the network fingerprint.

## Visitor data flow

1. A visitor opens the chat interface.
2. Firebase Anonymous Authentication assigns a unique UID.
3. The browser requests a network fingerprint from the Netlify Function.
4. The function calculates a keyed HMAC-SHA256 fingerprint using the connection IP supplied by Netlify and the server-side `IP_HASH_SECRET`.
5. The browser stores conversation sessions under its own UID and network fingerprint.
6. The administrator signs in through Firebase Email/Password Authentication to review records permitted by the database rules.

The database structure follows this pattern:

```text
visitors/
  {visitorUid}/
    profile/
      createdAtMs
      lastSeenAtMs
      historyClearedAtMs
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

The fingerprint is a keyed hash. It is not a raw IP address and does not identify a person or recover an IP address. A cleared browser profile, deleted site data, or a different browser might receive a new anonymous UID.

## Administrator dashboard

The dashboard is available at:

```text
https://YOUR-SITE-DOMAIN/admin.html
```

The dashboard provides:

- Visitor count, network fingerprint count, and conversation count.
- Unique visitor IDs.
- Visitor activity dates.
- Network fingerprint history.
- Saved conversation transcripts.
- Search by visitor ID, fingerprint, or conversation title.
- Permanent deletion of a selected visitor's saved conversation history and network fingerprints. The visitor UID is retained.

The dashboard page itself is not a security boundary. Firebase Authentication and Realtime Database rules control access to visitor records. The authorised administrator email must match the value configured in both `admin.html` and `database.rules.json`.

## Privacy and security

- Visitors authenticate anonymously. Their records are scoped to their Firebase UID.
- The administrator account has permission to read the visitor collection and manage visitor records.
- The app stores conversation content in Firebase Realtime Database for history and dashboard access.
- Chat requests are processed by the application's server-side function.
- Netlify supplies the connection IP used to calculate the keyed network fingerprint.
- Raw IP addresses are not written into Firebase visitor records.
- The Firebase web configuration is visible in the browser. Database access depends on Authentication and security rules.
- The HMAC secret must stay in Netlify environment variables.
- Never commit passwords, service-account private keys, or secret environment-variable values to GitHub.

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
        ".read": "auth != null && (auth.uid === $uid || auth.token.email === 'ADMIN_EMAIL')",
        ".write": "auth != null && (auth.uid === $uid || auth.token.email === 'ADMIN_EMAIL')"
      }
    }
  }
}
```

The administrator receives read and write access within visitor records for history management. Each authenticated visitor receives read and write access only to their own UID branch.

### 2. Netlify

Set the `IP_HASH_SECRET` environment variable in the Netlify site settings. Use a long, unique secret value. Do not put the value in frontend files or GitHub. Redeploy after changing environment variables.

### 3. Deploy

1. Connect the GitHub repository to Netlify.
2. Confirm the Netlify Functions directory is configured.
3. Add the required environment variable.
4. Deploy a feature branch preview.
5. Test visitor sign-in, chat responses, conversation persistence, and administrator access before promoting changes to production.

## Testing checklist

- [ ] A new visitor receives an anonymous Firebase UID.
- [ ] A visitor's conversation remains available after a page refresh.
- [ ] A visitor cannot read another visitor's records.
- [ ] A signed-out user cannot read visitor records.
- [ ] A non-admin account cannot list the visitor collection.
- [ ] The authorised administrator can sign in and view saved records.
- [ ] The administrator can delete a visitor's conversations and network fingerprints while retaining the visitor ID.
- [ ] Deleted conversations do not return from the visitor browser cache.
- [ ] Secret environment-variable values are absent from GitHub.

## Project status

The visitor dashboard and Firebase access rules are implemented in the feature branch. Production release should follow a separate review and approval.

## Developer

**Agboola Vincent Oluwaseyi**

Vee-AI is an independent project focused on web development, cloud data storage, authentication, and visitor management.
