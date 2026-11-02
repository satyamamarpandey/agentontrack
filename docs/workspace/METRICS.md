# What the numbers mean

Every figure in the dashboard, the CLI and the VS Code sidebar comes from the same record and carries a provenance label. A figure with no source is shown as **Unavailable**, with the reason. Nothing is estimated silently, and no saving is shown without a baseline you entered.

| Figure | Source | Label |
|---|---|---|
| Input and output tokens | Reported by the provider's own result for runs started here, or read from Claude Code's session records | Actual: provider-reported, or Transcript (read from a local file, not confirmed by the provider) |
| Cache read and write tokens | Same. Kept apart from input and output because they are priced differently | Same |
| List-price cost | The cost the provider reported, or a list-price calculation. It is **not** your bill on a subscription | Actual, with the basis shown |
| Time | Wall clock and API time for runs started from the dashboard, approval wait from the record, verification time from timed checks | Record. Unavailable for work done outside AgentOnTrack |
| Tasks verified, criteria passing | Your own acceptance checks, run by AgentOnTrack on the current code, with a receipt per run | Record |
| Task success | The share of tasks whose checks currently pass. A weak check withholds VERIFIED until a person accepts it | Record |
| Safety counts (prevented, held, detected afterwards, reversed) | The decision log. "Missed" is always Unavailable: a miss leaves no record | Record |
| Tokens or time **saved** | Only against a baseline you type in for a similar task you did without AgentOnTrack | User-provided baseline. Not a controlled experiment |
| Energy and water | Only your own factors (Wh per 1k tokens, litres per kWh) multiplied by recorded tokens. Vendors publish no per-request figure, so there is no default | Estimated, using your factor. Unavailable until you enter one |
| Benchmark results | The recorded benchmark runs on the Comparisons and Evaluations screens | Benchmark-derived, self-run, not independently reproduced |

## What has and has not been shown

* AgentOnTrack's own matched benchmarks found it used **more** tokens and time than the agent alone. Those averages are never used to claim a saving, and no new evidence changes that. The product is a control layer, and its value is the evidence and approvals, not speed or cost.
* No environmental saving has been measured. The page says so.
* All results are self-run. No independent evaluator has reproduced them.
