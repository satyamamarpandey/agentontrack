# AgentOnTrack production launch acceptance specification

**Prepared:** 2026-11-17. **Current verified public site:** `https://pandeysatyam.com/agentontrack/`; **public main:** `5df23f6` (CI and Pages successful); **last published desktop preview:** `v1.0.0-rc.7` (not stable).

This is an implementation and acceptance specification, **not** a certificate that the features have been built or tested. Keep private-core and public-export review separated.

## Gate 0 — Provider terms, eligibility, billing

- Preserve official, unmodified runtimes and official direct user authentication. No provider password collection, session-cookie extraction, token sharing, or bypass of usage restrictions.
- For Claude Code, discover **actual** available models and identify model aliases `fable`, `sonnet`, `opus`, `haiku`, plus supported effort levels. A *single subscription* can provide choices, but availability varies. **Fable can consume additional usage credits** and noninteractive runs may not present a consent dialog. Never silently incur charges. Disable Fable by default until eligibility and no-extra-charge status are confirmed or the user explicitly grants usage-credit spending.
- For Codex, read model availability from the official local runtime/app-server or eligible open-source Sign in with ChatGPT integration. Model/effort dropdowns must display only available capabilities. ChatGPT plan usage for local open-source tools differs from paid/hosted apps.
- Stage orchestration should permit manually initiated Plan → Build → Review → Verify with role-specific models under one authenticated provider. An unattended chain is a **separate permission**; keep subscription-backed chained execution blocked until terms are confirmed. Do not bypass existing grants.
- Enforce usage limits and kill-switches; do not fake dollar costs for subscription activity. No new paid services, credits, or hosted inference without owner authorization.

## Gate 1 — First-user UX / professional UI

- One clearly defined visitor journey: apply → receive invitation → sign up → verify address → sign in → install matching platform/version → guided desktop pairing → automatically discover existing projects → choose connected agent/model → start a task → approve/deny → review diff/tests/evidence.
- Desktop layout: streamlined left project navigation, central session composer/activity with readable changes, right contextual Goal/Plan/Review/Verify area (collapsible). Avoid showing technical evidence internals on the first screen. Clear states: loading, empty, unavailable, offline, permission denied, expired session, spent allowance.
- Mobile layout: phone-specific dashboard with trusted computer, active project, status, review diffs, notifications, constrained approvals, stop and deliberately initiated bounded work. No terminal or local IDE; no pretending the phone can execute agents while the desktop is offline.
- Accessibility: WCAG 2.2 AA where practical, keyboard navigation, focus/contrast, no clipped controls at narrow viewports, reduced motion and meaningful status text. Professional restrained visual system; no false promises or decorative metrics.

## Gate 2 — Mobile production control

- Use the pre-existing encrypted phone↔desktop transport and Firebase Auth/Firestore rules where possible, with **explicit desktop/device trust**. Test link, revoke, device fingerprint, replay, command ownership, stale documents, TTL, offline/reconnect, 2 users and 2 devices, cross-account isolation, consent for high-risk changes and least privileges.
- Desktop must be online and actively running the companion for live control. Phone does not connect to `127.0.0.1` on the phone to reach the user's laptop.
- App Check: configure, observe telemetry, enforce only after legitimate clients are verified. Confirm Firebase quotas, denial semantics, alerting and network disconnect behavior.
- **Do not enable mobile in the published release** until production project + real Firestore rules + physical Android *and* iPhone browser/PWA tests pass, including cross-network LTE/Wi-Fi, phone restart and offline. Clearly mark unsupported flows if hardware isn't available.

## Gate 3 — Official, trustworthy email

- First check Firebase public-facing name `AgentOnTrack`, supported sender/subject/reply-to fields and custom sender domain. For no-cost built-in Firebase emails, do not claim full branded HTML is editable unless actually supported.
- For polished HTML, generate Firebase action links **only on a trusted backend** and send with an owner-approved transactional email provider and a domain authenticated with SPF, DKIM and DMARC. Never embed Admin SDK/service-account credentials in GitHub Pages or the public browser bundle. Provide text-only equivalent. Use approved actual recipient addresses and avoid tracking pixels.
- Provided `verification_email.html` and `.txt` are *starter templates*, not currently deployed. Replace `{{DISPLAY_NAME}}` and `{{VERIFY_URL}}` with escaped values, validate action URLs, and never log action codes. Use the verified sending address; do not literally send from the placeholder domain.
- Test real inbox delivery across Gmail and ideally Outlook (Inbox/Spam), mobile click, unverified/verified account state, already-used/invalid/expired links, unauthorized membership denial, replay, account cleanup, password reset and address-change email.

## Gate 4 — Release, security and tests

- Maintain sanitized open-source export and private owner records separate. No public/private flipping, history rewriting, or accidental inclusion of personal paths/secrets. Public builds must match public source tag exactly; verify checksums and provenance, plus official install, upgrade, rollback, uninstall on OS matrix. Preserve rc.7 pre-release until a new reviewed binary is actually built; do not call rc.3 stable v1.0 by implication.
- CI: typecheck, lint, 3 OS unit tests, Playwright Chromium/Firefox/WebKit/Edge, actual Firebase emulator, rules, feature and security regressions, accessibility, release artifact checks. Record skipped/flaky separately; do not count simulated provider/phone tests as live provider/phone coverage.
- Production smoke: fresh approved applicant, real email, invite, install, authenticated pairing, manually authorized role-specific model runs, evidence and secure revocation. Clean up disposable data only.
- Data safety: no destructive production resets; backups, retention, incident response, rate limits, privacy/terms, appropriate independent security review and bounded spend. Unresolved critical security defects are NO-GO.
- Performance claims only after reproducible native-vs-AgentOnTrack benchmarks. Report overhead, task success, context recovery and tokens separately. Never assert unsupported cost or environmental savings.

## Final report contract

1. Exact feature-by-feature matrix: IMPLEMENTED AND LIVE / EMULATED / MOCKED / DISABLED / BLOCKED, with proof per claim.
2. Verified CI/deployment runs and commits; site and release links; SHA256 and attestation details.
3. Real Android, iPhone, desktop, email deliverability and runtime-model selection results; explicitly name absent physical tests.
4. Provider auth and Fable usage-credits behavior; no unauthorized subscription automation.
5. P0/P1 findings and remediation; GO/NO-GO separately for controlled beta, production mobile, and stable v1.0.

## Official references checked 2026-11-17

- Claude Code models: https://code.claude.com/docs/en/model-config
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code legal: https://code.claude.com/docs/en/legal-and-compliance
- Codex app-server: https://learn.chatgpt.com/docs/app-server
- Sign in with ChatGPT local open-source rules: https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- Firebase template limitations: https://support.google.com/firebase/answer/7000714?hl=en
- Firebase custom email domains: https://firebase.google.com/docs/auth/email-custom-domain
- Firebase action links: https://firebase.google.com/docs/auth/admin/email-action-links
- Firebase App Check: https://firebase.google.com/docs/app-check
- Browser localhost access: https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access
