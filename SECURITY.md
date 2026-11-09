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
| Copilot CLI | Blocks on a crash or missing program. **Runs the action on a timeout or malformed output (observed).** Plain `copilot -p` in an untrusted folder skips the hook entirely |
| Gemini CLI | Blocks on a missing program. **Runs the action on a crash, timeout or malformed output (observed)** |
| OpenCode | Blocks on a crash, timeout or missing program (observed). A plugin that fails to load is not tested |
| Cline CLI | **Runs the action on a crash, malformed output or missing program (observed)** |
| Cursor, Devin, Kiro | Not observed. These adapters have never run on the real programs |

An adapter on a host that fails open is a gate only while the hook runs. Start such hosts with `agentontrack run <id>`.

## The public website

The site is static. It reaches only the companion on your own machine, and only if you start `agentontrack dashboard --allow-public-site`. A browser must pair with a code from your terminal. After that, any change or check needs another code, shown only in your terminal and tied to that exact request and project. Five wrong codes end the session. So a compromised page can read your record, and save a local feedback note, but cannot approve anything. A project with an approver passphrase refuses human actions from the site, since a page could read what is typed into it. The allowed origin is the whole of `pandeysatyam.com`, so everything on that domain shares this trust. The local address needs no outside origin at all.

## Optional accounts on the website

Off unless the site's owner sets a Firebase config, and then still optional: nothing needs an account. With no config, the build holds no Firebase code and the site makes no third-party request. With one, Google and Firebase become third parties only for a visitor who signs in or sends feedback, and only from that moment.

Stored in Firestore: a signed-in person's name and email from Google, theme, feedback, and any project summary they chose to save, which holds a label they typed, totals and pass rates. Code, prompts, paths, commands and project records are never sent. `firestore.rules` limits each person to their own documents and validates fields. Feedback can be created by anyone, read by no client, and deleted only by the signed-in person who sent it. A person can export and delete their data on the account page. Feedback sent while signed out is not linked to anyone, so only the maintainer can remove it.

Google's sign-in script runs only on the account page, which the dashboard opens as a separate tab, so it does not run in a page that holds a companion session. Saving a summary does load Firebase's code into the dashboard page, when the person presses Save. That code is served from the site itself, so it has the same trust as the site, and a compromised site can already read a paired session, as above. The companion's own local address never loads any of this. These rules have only been exercised in the Firebase emulator's CI job, which has not yet run.

## Supply chain

Release archives list a SHA-256 in `SHA256SUMS`, and the installers refuse a mismatch. Note that a checksum fetched from the same place as the file only catches corruption. Where GitHub build attestations are available, verify with `gh attestation verify <file> -R satyamamarpandey/agentontrack`. Binaries are not code-signed, so Windows and macOS may warn.

**For 1.0.0-rc.7 specifically:** the binaries were built by GitHub Actions in this public repository from the commit the release tag points to, and GitHub recorded a build attestation for each file (`gh attestation verify <file> -R satyamamarpandey/agentontrack`). There is no code signing, so Windows and macOS may warn, and checksums catch a damaged download, not someone replacing both the file and the list. Nobody has rebuilt the files independently to compare. Earlier releases: rc.5 had no attestation; rc.6 was built in a private repository (an attestation exists there that the public cannot verify).

## Known security-relevant limitations of this release candidate

- **Codex fails open** if its hook program is missing: Codex then runs the action. `agentontrack run codex` refuses to start unless the hook answers a test request; starting `codex` directly skips that check.
- A held or declined action is stopped only where the agent honours its hook. Files changed by opaque scripts are detected afterwards, not prevented.
- **Phone control and sign-in are experimental**: tested against local emulators only, not against a real Firebase project or a physical phone. They are off unless a build carries a Firebase config.
- An attachment or file that tells an agent to ignore its instructions was summarised, not obeyed, in 3 of 3 real Claude Code observations. That is an observation of one model, not a guarantee.
- Real-agent testing covers one Windows machine. Linux and macOS installs are tested; agents running on them are not.
- A failed command is shown in the run and gets one recovery turn, but an agent can still stop after it. A cross-review whose builder changed nothing ends as failed.
