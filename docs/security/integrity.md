# Log integrity and approval authentication: trust model

A process running as the same user can read and write every local file, so no purely local design can make the log immutable. AgentOnTrack's aim is narrower: make a forgery need several coordinated steps, make most of them detectable, and say exactly where detection stops.

## Layers

| Layer | What it adds | What it does not stop |
|---|---|---|
| SQLite triggers | Refuse update and delete through normal SQL | Dropping the trigger |
| Hash chain with an instance ID | Reveals an edit that does not recompute hashes, and a database swapped from another project | Recomputing the chain |
| Witness file, kept apart, one line per event | Reveals rewrite, truncation and rollback of the database alone | Rewriting the witness as well |
| Approver key (optional, recommended): Ed25519, private key sealed with scrypt and AES-256-GCM from a passphrase | Human-only events must carry a valid signature, or state ignores them. A process without the passphrase cannot forge a grant, even with full file access | Replacing the enrolled public key in both log and witness. Capturing the passphrase with a keylogger |
| Signed checkpoints in the witness | Tie human actions to log position | Same as above |
| `agentontrack anchor config --remote <git url>`: appends the log head to a remote at each interval, checked with `anchor verify` | The only layer that catches a fully consistent local rewrite, including a log rebuilt from nothing | A remote that accepts force-pushes or ref deletions from the same credentials. Use `receive.denyNonFastForwards` and `receive.denyDeletes`, or a protection ruleset. Tested against a local bare remote, not a hosted one |

## On failure

The hook path runs a constant-time check of the witness tail against the log. On a mismatch, approval-gated actions are denied, whatever approvals exist, until a human runs `agentontrack audit --recover`. Recovery keeps the valid prefix, sets the damaged log aside in `incidents/`, and records an `integrity.incident` event. Evidence and approvals after the break are dropped from the active log.

Actions needing no approval still run during an integrity failure, with a warning. Blocking all of them would stop reads too, and the record is not what makes those safe.

## Terminal and approver checks

A TTY plus a typed code stops an agent's ordinary tool call, which has no terminal. It does **not** prove a person is present: `packages/cli/test/tty.test.ts` demonstrates a same-user program driving a pty and passing it. Enrolling an approver closes that path, at the cost of a passphrase with no recovery.

## Tested

`packages/core/test/hardening.test.ts` covers rewrite, truncation, rollback, cross-project replay, witness deletion, forged and replayed grants, enrolment removal and recovery. One test documents the limit: rewriting both log and witness is not detected.
