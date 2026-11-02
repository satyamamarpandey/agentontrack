# Origin isolation: what the public site is trusted with

Status: assessment and the changes made in the onboarding release. Self-reviewed. No outside party has tested it.

## The question

The helper that runs on your computer (the companion) lets a web page talk to it only if the page's **origin** is on an allowlist. By default that origin is `https://pandeysatyam.com`. An origin is the whole site, not one folder of it, so every page and script served from `pandeysatyam.com` is trusted equally with the AgentOnTrack dashboard at `/agentontrack/dashboard/`. That domain also serves other content. If any of it were compromised, it would sit inside the trust boundary.

## What a script on that origin can and cannot do today

| Action | Result |
|---|---|
| Pair with the companion | Needs the one-time pairing code from your terminal. A script cannot read it. It could try to talk you into typing it. |
| Read the project's state, records and approvals | Possible only inside a tab that is already paired. The session token lives in that tab's session storage. |
| Read **source files** | **Closed by default since this release.** Needs a terminal-confirmed grant that lasts at most 120 minutes (the page asks for 30), covers one project and one session, and can be withdrawn. |
| Change anything (approve, edit a file, change the goal, start a run, merge) | Needs a code that appears in your terminal and is bound to that exact request. |
| Reach the companion from another origin | Refused: the companion checks `Host`, `Origin` and a CSRF token. |

## Changes in this release

1. **Source reads need a grant.** `/api/files`, `/api/file`, worktree diffs and the spec check return `403 needsGrant` to a page on an outside origin until you allow it with `POST /api/files/grant`, which needs a terminal code like any other change. The local address and editor sessions are unaffected. Tested in `packages/companion/test/workspace.test.ts` and in a real browser in `e2e/public-pairing.spec.ts`.
2. **A Content-Security-Policy on the dashboard page**, the page that holds the session token: scripts only from itself, no frames, no `eval`, no plugins, and network access only to itself, your own computer and, in a build with accounts, Firebase. Injected markup therefore cannot load a script from elsewhere or send the token to another host. The marketing pages keep their previous behavior because their framework needs inline scripts; the dashboard is where the token is.
3. **`agentontrack dashboard --allow-origin https://host`** takes one exact https origin (no path, no wildcard). A dedicated hostname needs no code change.
4. **Sign-in is a separate page.** Signing in with Google, GitHub or email happens on `/account/`, a different document from the one that holds the companion token, and grants nothing on your computer.

## Recommendation: a dedicated hostname

Move AgentOnTrack to its own origin, for example `agentontrack.<your domain>`, so only AgentOnTrack's own pages share it. Then run the companion with `--allow-origin https://agentontrack.<your domain>` and, in a later release, drop `pandeysatyam.com` from the default list.

This needs two things only the owner can do:

1. Create a DNS `CNAME` record for the subdomain pointing at `satyamamarpandey.github.io`.
2. In the public repository's Pages settings, set that custom domain and enable HTTPS, and tell me, so the site's base path, the companion default and the install scripts can follow.

Until then the grant and the confirmation codes are what stand between another page on the domain and your code.

## Not done

* No Content-Security-Policy on the marketing pages.
* No test of what happens if another page on `pandeysatyam.com` is hostile, because none exists to test against.
* The companion still treats a paired outside session as able to read state, records and approvals. Only source is held back.
