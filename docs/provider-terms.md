# Provider terms and how AgentOnTrack uses Claude Code and Codex

Read on 2026-11-08 and 2026-11-09 from the providers' own public pages. This is the project's reading, not legal advice, not approval from either provider, and not a claim of compliance. Where a page could not be read, it says so.

## What AgentOnTrack does

It starts the user's own, unmodified `claude` and `codex` programs on the user's computer, after the user clicks Start, with the sign-in the user created in that program. It never reads, stores, copies or relays a sign-in or token, removes API-key environment variables from the programs it starts (so a subscription is used unless the user turns on paid API mode), does not modify either program, and runs no hosted service. Phone control, which would send a prompt from a phone to the user's computer, is switched off in the releases.

## Execution paths and their status

| Path | Status in AgentOnTrack | Basis in the providers' pages |
|---|---|---|
| A person starts one Claude Code run | On | Anthropic's legal page: its restrictions do not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". One question for Anthropic remains (below) |
| A person starts one Codex run (app-server) | On | OpenAI's app-server page, as summarized: a local or open-source application using app-server authentication can continue to do so; it has not been permitted for commercial or hosted services. The quote was obtained only as a summary |
| Several runs in a row after one click (continue over phases, retry loops, one-click build then review), and unattended runs | Refused for agents signed in with a subscription. Allowed only with the user's own API key in paid API mode and a time-limited grant created with the terminal confirmation code | No page read permits or prohibits chains. Anthropic's consumer terms bar access "through automated or non-human means, whether through a bot, script, or otherwise" except with an API key "or where we otherwise explicitly permit it". OpenAI's pages point automation to the Codex SDK and API keys |
| A person starts the build, then separately starts a review of it | On (two single runs) | Same as the single-run paths |
| Runs started from a phone | Off; refused unless a separate setting is on | Not addressed in the pages read. Anthropic offers its own Remote Control feature |
| Hosted or commercial use | Not offered | Anthropic requires its Commercial Terms to run Claude Code in a hosted product; OpenAI says app-server authentication has never been permitted for commercial or hosted services |

## Open questions (to be put to the providers; answers will be recorded here)

1. Anthropic: does the sentence that developers building products "should use API key authentication" apply to a local program that launches the user's own Claude Code binary for a run the user starts?
2. Anthropic: may a subscription be used for chained or unattended runs by the user's own scripts, or does that need an API key? Is Anthropic's own documentation of `claude -p` and `claude setup-token` for scripts the "explicit permission" the consumer terms mention?
3. Anthropic: is relaying a prompt from the user's phone to the user's own computer acceptable for a third-party tool?
4. OpenAI: is a free, open-licence local program a "local or open-source application" for app-server authentication, and what changes if it is ever sold or bundled?
5. OpenAI: may a ChatGPT-plan sign-in be used by a local tool for chained or unattended Codex runs, or are API keys required for automation?
6. Both: how may the product names be used in this project's interface and website? The project uses "Claude Code" and "Codex" only to say which programs it works with; it is not endorsed by either company.

## Pages not read

OpenAI's Sign in with ChatGPT terms and its help article on using a ChatGPT plan in other apps, its Terms of Use and its brand guidelines returned access errors to the project's automated reader. Sign in with ChatGPT is a separate integration in which an application registers with OpenAI and supplies the user's plan token to Codex; AgentOnTrack does not do that and holds no token.
