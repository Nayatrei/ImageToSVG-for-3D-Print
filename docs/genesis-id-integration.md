# Genesis Editor — Genesis ID integration

Genesis Editor (`GenesisImageConverter`) keeps every local converter free and
usable without an account. Genesis ID is an optional connection that exposes a
user's current tier and whole-Spark balance and records this app in the central
connected-app list.

Plus and Pro benefits include Editor with no additional fee and no Spark
deduction. The account card reads the active tier from canonical account access
and labels this inclusion. Existing public local converters remain free; this
benefit does not introduce an anonymous/Free paywall. A future paid-only feature
requires a separately approved access policy, not a browser-only tier check.

## Fixed client contract

- App ID: `genesis-editor`
- Production origin: `https://editor.genesisframeworks.com`
- Exact production callback: `https://editor.genesisframeworks.com/auth/callback/`
- Identity/gateway origin: `https://id.genesisframeworks.com`
- Protocol: authorization code + S256 PKCE + random state
- Pending verifier/state storage: per-tab `sessionStorage`
- Connected Firebase session storage: per-tab `sessionStorage`

The gateway production configuration must include the following exact values:

```text
CORS_ORIGINS += https://editor.genesisframeworks.com
SSO_CLIENTS_JSON["genesis-editor"] += https://editor.genesisframeworks.com/auth/callback/
```

For local manual QA only, add these exact temporary entries and remove them if
the environment does not need browser-to-production SSO:

```text
CORS_ORIGINS += http://127.0.0.1:4173
SSO_CLIENTS_JSON["genesis-editor"] += http://127.0.0.1:4173/auth/callback/
```

The checked-in `genesis-id-*` meta values are public routing configuration, not
credentials. Firebase Web API configuration is read from the public Genesis ID
config endpoint only when a token must be exchanged or refreshed.

## Browser connection and logout

Select **Genesis ID 연결**. The Editor creates a 32-byte PKCE verifier and a
separate random state, stores them only for the current tab, and sends the
challenge to Genesis ID. The callback requires the exact state, app ID,
callback URI, pending lifetime, and one-time central code before it accepts a
Firebase custom token. Return navigation is restricted to this Editor origin.

**이 기기 연결 해제** clears the Editor's per-tab session. It does not revoke
the user's other Genesis applications. Account-wide session revocation remains
available from the Genesis ID membership portal.

The widget accepts only the canonical `microcredit` projection and converts
`available` with the canonical `microcreditsPerSpark: 1_000_000` divisor before rendering.
Raw microcredit units are never displayed; whole or fractional Spark values may
appear as appropriate, or `Unlimited Sparks` for the dedicated Agent account.

The card rechecks canonical account access and balance whenever it opens and
when the tab regains focus or becomes visible. Concurrent refresh triggers share
one request sequence. Visible connected tabs also recheck at most 60 seconds
after the previous successful load, or sooner at the token refresh boundary;
hidden tabs defer network refresh until they resume. `access.recomputeAt` is a
past projection recomputation timestamp, not a future grant expiry deadline.
While rechecking, the card shows a neutral loading message instead of a stale
paid benefit or balance. Failed, suspended, mismatched-UID, and unauthorized
responses remove the local connection; public conversion remains available.
Session-generation and exact stored-session checks prevent late account or
token-refresh responses from resurrecting a disconnected or different account.
Keyboard focus stays on the corresponding refreshed account control, but is
never pulled back if the user has moved to a converter control.

## Passwordless Agent testing

The central Agent credential exchange must allow app ID `genesis-editor`.
Trusted non-browser API runners may use Genesis ID's guarded `agent:access`
workflow to obtain a short-lived, app-bound ID token for direct API checks. The
token stays in process memory and must never be transplanted into the Editor or
another browser context.

Deployed visual browser QA must follow **배포 브라우저 PKCE 로그인** in
`/Users/jongmac/Documents/WebTools/GenesisChat/docs/agent-testing-access.md`.
Start **Genesis ID 연결** in an isolated browser so that tab owns the random
state and PKCE verifier. A trusted non-browser runner requests the one-time
Agent browser code from the public authorization fields, and the same browser
then completes the exact `/auth/callback/`. Disable HAR, trace, screenshots,
and console or network-body capture until the callback query has been removed.

Do not inject an ID token, Firebase custom token, cookie, `sessionStorage`,
`localStorage`, or IndexedDB value, and do not call
`window.GenesisId.useManagedIdToken(...)` in a deployed browser. That method is
retained only as an internal local-test hook for synthetic tokens; it is not a
production access or visual-QA procedure.

Use **이 기기 연결 해제** at the end of the test and destroy the isolated
browser profile. The Editor's conversion code does not consume Sparks and
remains independent of any Genesis ID session.

## Deployment verification

Render deploys the repository as the `genesis-image-converter` static service:

```text
buildCommand: npm ci --omit=dev && npm run build
staticPublishPath: .
rewrite /auth/callback and /auth/callback/ -> /auth/callback/index.html
```

The explicit Blueprint rewrites make the exact callback independent of CDN
directory-index behavior. Render serves an existing static file before broader
fallback rules, so these narrow rules do not affect converter entrypoints.

Before promoting a commit, run `npm test`, `npm run build`, and
`npm run check:cache`. Verify `/`, one converter route, and
`/auth/callback/` on desktop and mobile. A real SSO canary must confirm that the
callback returns to the originating Editor route, displays only Sparks, and
that local disconnect leaves all converter actions enabled.
