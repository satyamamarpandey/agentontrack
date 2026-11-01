# Benchmarks and reproduction package

## Benchmark v4 (current)

[Protocol](v4/PROTOCOL.md), `results/matched-v4.json`. 162 of 162 runs, 9 tasks, 6 conditions, 3 repeats, Claude Code 2.1.316 on Haiku, one Windows machine, concurrency 1, $1.81 list price. Product at commit `c6e5435`. Self-run, on fixtures we wrote.

| Condition | Hidden check passed | Mean tokens | Mean time | Unauthorized effects | Block candidates |
|---|---:|---:|---:|---:|---:|
| A: bare agent | 78% | 5,523 | 30.8 s | 12 | Unavailable |
| A-doc: goal in `CLAUDE.md` | 100% | 6,308 | 28.8 s | 5 | Unavailable |
| B: native deny rules | 78% | 5,923 | 32.5 s | 6 | Unavailable |
| C: AgentOnTrack standard | 100% | 5,141 | 36.8 s | 5 | 7 |
| D-strict: AgentOnTrack strict | 100% | 5,922 | 36.4 s | 0 | 13 |
| E: cc-safety-net 2.7.1, defaults | 78% | 5,770 | 31.5 s | 9 | Unavailable |

95% intervals against A: tokens C -2,225 to +888, D-strict -1,546 to +2,078, A-doc -1,012 to +1,965, B -1,692 to +1,817, E -2,199 to +1,698. Seconds C +1.9 to +10.0, D-strict +1.1 to +10.6, A-doc -5.6 to +1.3, B -2.0 to +5.3, E -2.6 to +3.7.

What this does and does not show:

- **No token savings claim.** Every interval spans zero, and one large compaction task dominates the means.
- **Slower.** Both AgentOnTrack conditions took measurably longer than the bare agent. Times are not comparable with v3, which ran at concurrency 2.
- **Task success comes from stating the goal.** A-doc also reached 100%. A, B and E failed all 6 runs of the two restart tasks, which is the whole gap.
- **Standard mode has real gaps.** Its 5 effects are 2 indirect pushes and 3 network calls by project scripts. A-doc also had 5, of different kinds. Only strict reached 0.
- **Strict's 0 costs blocks:** 13 candidates in 27 runs, and with no person there to approve, some work simply stopped at a request.
- **E is a fair tool measured off its purpose.** It targets destructive commands, and these tasks hardly test that. This says little about it in general.
- A block candidate is any block whose target is outside the task's forbidden set, so some are correct, such as agents writing tests outside the goal's scope.
- VERIFIED was wrong in 0 of 54 runs, and withheld in 12 even though the hidden check passed, largely for placeholder tests the new weak-check rule flags. That is a cost as well as a benefit.

An interrupted first attempt of 37 runs was set aside unreported. Commit hashes here refer to private development history, since the public source starts from a single commit.

## Benchmark v3 (earlier)

[Protocol](v3/PROTOCOL.md), `results/matched-v3.json`. 126 runs on smaller tasks, concurrency 2. Against the bare agent, AgentOnTrack standard added 340 to 756 tokens and 6.7 to 11.8 seconds. Three of 21 gate-only runs wrongly reached VERIFIED, which led to weak checks withholding it.

## Other results

- `results/security-campaign.json`: adversarial scenarios run by this project's own tests, classified as prevented, detected afterwards, missed, unsupported or not tested. Rows for the removed hosted accounts and sync were dropped.
- `results/performance.json`: hook timing, measured before the hook was lazy-loaded and not re-measured.
- `results/hosts-*.json`, where present: real agent programs with a scripted model.

Reproduce: see [independent evaluation](../docs/evaluation/INDEPENDENT.md).
