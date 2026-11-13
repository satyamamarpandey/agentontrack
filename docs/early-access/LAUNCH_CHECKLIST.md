# Early-access launch checklist (controlled beta)

Status at 2026-11-12. "Verified" means run against production or the real release; "owner" means it needs the owner's console or inbox.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Site live over HTTPS, early-access form stores applications | Verified | the maintainers' record "live-early-access-2026-11-12.json" (not published) (113/113) |
| 2 | Authentication (email/password, Google) on; rules deployed and equal to the repository file | Verified | PRODUCT_READINESS, 2026-11-11 sections |
| 3 | Administrator provisioned; review page approves, invites, revokes, reinstates | Verified | `live-admin-2026-11-12.json` (49/49; the 6 owner-record checks need `--owner-uid`, 55/55 on 2026-11-11) |
| 4 | Invitation: single use, expiry, address-bound | Verified | live walkthrough, phases invite/expiry/join |
| 5 | Install page: pinned rc.7 first, one command per system, "ZIP is not an installer", AI agent needed separately | Verified | `e2e/site.spec.ts` (desktop + phone), screenshots in `docs/uat/evidence/` |
| 6 | Real install of rc.7 from the live script: checksum, first launch, doctor, setup, manual from-folder install, tampered archive refused, uninstall | Verified (Windows) | the maintainers' record "live-install-2026-11-12.json" (not published) (12/12). Linux/macOS/Arm: `public-install` workflow, five runners, 2026-11-11 |
| 7 | Upgrade, rollback, uninstall through the published installer | Verified (Windows) | `scripts/release/upgrade-rollback-check.mjs`, 2026-11-12 |
| 8 | Connect: no contact with this computer until "Check for helper"; Allow, Block, missing helper, wrong port, timeout | Verified (Chromium; Edge and others in CI) | `e2e/public-pairing.spec.ts` |
| 9 | Pairing and a real agent task through the deployed site (real Claude Code, approval, denial, VERIFIED) | Verified once | `e2e/live-public-workspace.spec.ts`, 2026-11-12, 1.1 min |
| 10 | Email text: product name, sender name, subject, message | **Owner, unconfirmed**: the live configuration read by API still shows Firebase defaults; the owner should open the received message and read the subject and sender, or re-save the templates in the console (`EMAIL_SETUP.md`) |
| 11 | Genuine email delivery | Verified 2026-11-13 (received, opened, confirmed by the owner; 9/9 checks, cleanup done) | the maintainers' record "live-email-2026-11-13.json" (not published) |
| 12 | Revoke, reinstate, leave account, old-token denial | Verified | live walkthroughs |
| 13 | Public CI (7 jobs) and Pages deploy on the published commit | Verified: ci and pages green on public `f50f6af` | GitHub Actions |
| 14 | Stable v1.0 | Not approved. rc.7 stays a pre-release; rc.3 stays the latest non-pre-release |

Not available to this assistant: a second physical machine or phone, a real external applicant's inbox other than the owner's, Codex/Hermes logins, code signing, independent evaluation.
