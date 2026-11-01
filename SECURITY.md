# Security

## Reporting

Report vulnerabilities privately through GitHub security advisories on this repository. Do not open a public issue. Include the agent and version, your operating system, and the steps to reproduce. This is a project with one maintainer and no response-time promise.

A bypass of something listed below as not covered is not a new vulnerability, but a better way of covering it is welcome. A bypass of something listed as enforced is exactly what we want to hear.

## What it protects, and what it does not

Run `agentontrack doctor` to see this for your own machine and project.

| Situation | Result |
|---|---|
| An action that classifies statically (push, delete, publish, write out of scope) through a hook that fires | Held or denied before it runs |
| A script's file changes inside the project | Standard profile: detected afterwards, and VERIFIED is withheld. Strict profile: the script needs approval first |
| A script's network use, or writes outside the project | **Not seen in the standard profile.** Needs an OS sandbox (`agentontrack install claude-code --sandbox` on Linux or macOS, or `agentontrack run codex`) or the strict profile. Native Windows has no such sandbox |
| Files changed while no hook fired | Found at `agentontrack verify`, and out-of-scope ones withhold VERIFIED |
| A push made while no hook fired | **Not detected** |
| A check that always passes | Withholds VERIFIED until a human accepts it. Heuristic: a hollow check it does not recognise can still pass |
| Same-user rewrite of both log and witness | Not detected locally. Caught by `agentontrack anchor` against a remote that refuses both force-pushes and ref deletions, such as `receive.denyNonFastForwards` with `receive.denyDeletes`, or a protection ruleset. Without that, it can be rewritten too |
| A same-user program driving your terminal | Can approve, unless you enrol a passphrase with `agentontrack approver enroll` |

## When the hook program is missing

| Host | What the real host does |
|---|---|
| Claude Code | Blocks the action (`onFailure: block`, observed) |
| Codex | **Runs the action anyway (observed).** The gate is not a hard boundary on Codex. `agentontrack run codex` refuses to start unless the hook answers |
| Hermes | Blocks the action with `fail_closed: true`, which `agentontrack install hermes` prints (observed). Its default fails open |

## The public website

The site is static. It reaches only the companion on your own machine, and only if you start `agentontrack dashboard --allow-public-site`. A browser must pair with a code from your terminal. After that, any change or check needs another code, shown only in your terminal and tied to that exact request and project. Five wrong codes end the session. So a compromised page can read your record, and save a local feedback note, but cannot approve anything. A project with an approver passphrase refuses human actions from the site, since a page could read what is typed into it. The allowed origin is the whole of `pandeysatyam.com`, so everything on that domain shares this trust. The local address needs no outside origin at all.

## Supply chain

Release archives list a SHA-256 in `SHA256SUMS`, and the installers refuse a mismatch. Note that a checksum fetched from the same place as the file only catches corruption. Where GitHub build attestations are available, verify with `gh attestation verify <file> -R satyamamarpandey/agentontrack`. Binaries are not code-signed, so Windows and macOS may warn.
