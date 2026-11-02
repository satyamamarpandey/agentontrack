# Specification review (the `spec-review` workflow)

Design before code: one agent drafts a specification with the project's full context, and reviewers who start **without** that context test it. If a fresh reader cannot explain the design back, or finds a gap, the document is ambiguous and goes back for redrafting.

## Where the idea comes from

The pattern is the Elephant-Goldfish Model, an open-source (Apache 2.0) plugin published by Google engineers: an "elephant" that holds the project context drafts the spec, and context-free "goldfish" reviewers explain it back, attack it, and give a go or no-go. AgentOnTrack takes the idea only. It does not bundle that project's code, prompts or reviewer personas, has not been run against it, and makes no claim to match it. The plan here is built from AgentOnTrack's own roles, handoffs and checks.

## What is built

| Part | What it does | Status |
|---|---|---|
| `spec-review` plan (`GET /api/workflow?kind=spec-review`, Team panel) | Draft (analyze role), structure check, explain-back, three attack reviews, go/no-go, person approves. Reviewer stages are marked isolated (fresh session, document only). Warns when one agent does every review or drafts and reviews. | PASS (unit tests) |
| Structure check (`GET /api/spec/check?path=`, **Check spec** button on Markdown files) | Run by the engine, not by a model. Looks for: problem, plan, alternatives and files sections; named file paths that exist or are marked new; a data structure; a function signature; vague wording. Returns go or no-go with each finding. It states that it does not judge whether the design is good. | PASS (unit and browser tests) |
| Starting the fresh reviewer sessions from the interface | Not built. The plan says what should run. Starting runs is supported for Claude Code only, so other reviewers are started in their own terminal. | NOT BUILT |
| Reviewer verdicts as evidence | Never. A reviewer's go or no-go is an opinion. A person approves the specification, and the goal and task come after. | By design |

## Limits

* The structure check cannot tell a good design from a bad one that is fully written down.
* Fresh sessions of the same model share that model's blind spots. Use a different agent for the final call when you can.
* No measurement shows that this workflow produces better designs. None is claimed.
