# Financial Intelligence data foundation

## Status

Initial server-side foundation, implemented on `firebase-realtime-integration`.

This schema is separate from the existing `users/{uid}/finance` data. Existing personal-finance records are not migrated or overwritten by this stage.

## Protected database path

```text
financialIntelligence/
  {uid}/
    schemaVersion
    preferences/
      reportingTimeZone
      timezoneSource
      currency
    workspaces/
      personal/
      biz_{id}/
    bankAccounts/
      {accountId}/
    transactions/
      {transactionId}/
    ledger/
      {ledgerEntryId}/
    audit/
      {auditId}/
    idempotency/
      {clientRequestId}
```

The Firebase Realtime Database rules deny direct client reads and writes at `financialIntelligence`. The Netlify function uses Firebase Admin after verifying a Vee-AI Firebase ID token and verified email.

## API

Endpoint: `/.netlify/functions/financial-core`

Method: `POST`

Header: `Authorization: Bearer <Firebase ID token>`

Supported actions:

- `bootstrap`: initialise and return the signed-in user's financial foundation.
- `savePreferences`: save device timezone and default currency.
- `createWorkspace`: create a separate business workspace.
- `assignBankAccount`: create or update a bank account assignment.
- `createTransaction`: create a transaction in `needs_review` status.
- `approveTransaction`: approve and post a reviewed transaction exactly once.
- `rejectTransaction`: reject a transaction awaiting review.
- `listTransactions`: list up to 200 transactions, optionally filtered by status or workspace.

## Financial safeguards

- Every record is scoped beneath the authenticated user's UID.
- Email verification is required.
- The server controls writes to the new financial path.
- Transaction creation requires a client request ID for idempotency.
- New transactions are never posted directly. They enter `needs_review`.
- Approval creates a ledger entry and audit event in the same database transaction.
- Repeated approval does not create a second ledger entry.
- Personal, business, shared and unassigned bank account assignments are supported.
- Shared accounts require a workspace classification on each transaction.
- Unassigned accounts cannot post financial transactions.
- Personal and business bank account assignments are checked against the selected workspace.
- Amounts and currencies are validated on the server.
- Existing `users/{uid}/finance` data is left untouched.

## Current limitations

This is the data and API foundation only. The existing Finance interface has not yet been connected to this endpoint. Gmail transaction ingestion, transfer matching, double-entry journals, inventory, debt schedules, reports, backup jobs and shared permissions are later stages.

Do not describe these later stages as implemented until their code and tests are complete.
