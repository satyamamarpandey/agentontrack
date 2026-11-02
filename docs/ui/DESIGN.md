# AgentOnTrack interface design

Status of this document: describes what is built in `apps/dashboard` and `apps/web`. Test status is in the table at the end, and every row there comes from a real run.

## Brief and direction

The product is a control layer for people who run AI coding agents for hours at a time. The interface is a working tool, so the design choices serve long sessions: low glare, dense but legible type, one accent, and no decoration that does not carry information.

Patterns studied (usability ideas only, nothing copied: no layouts, artwork or branding):

| Source | What was taken |
|---|---|
| Linear | A quiet left rail with grouped navigation; a keyboard-first command palette; status shown as small text badges, not colour blocks |
| Vercel | Project cards that lead with state (status, waiting approvals, last activity); activity as a log |
| Cursor | The agent as a tab beside the files, with the prompt composer under a live feed |
| VS Code | Explorer, tabbed editor, resizable and collapsible side and bottom panels, status bar, command palette |
| GitHub | Before/after diffs per file, review before merge, conflicts named by file |
| shadcn/ui | Accessible primitives and token naming. The components are written in plain React and CSS here, following the same patterns (dialog with focus trap, tabs, listbox command palette), because adding Tailwind and Radix to a GitHub Pages build was an unnecessary dependency |

The prompt-composer, team and handoff panels exist because the product's job is to let several agents (Claude Code, Codex, Hermes and the other adapters) share one goal, one set of approvals and one evidence record. This is a governance claim, not a routing one: AgentOnTrack does not send one prompt across models.

## Tokens

One palette, defined as CSS custom properties in `apps/dashboard/src/styles.css` and mirrored in `apps/web/app/globals.css`.

| Role | Dark | Light |
|---|---|---|
| Background | `#0a0e17` | `#f3f5f9` |
| Panel | `#0f1624` | `#ffffff` |
| Sunken (editor, code) | `#070a12` | `#e6eaf2` |
| Border | `#1f2b42` | `#d3dae7` |
| Text / muted | `#e6ebf4` / `#9aa8bf` | `#0e1626` / `#46556d` |
| Accent (focus, selection, primary action only) | `#2dd4bf` | `#0f766e` |
| Good / warn / bad | `#52e08a` / `#f3bd3c` / `#ff8585` | `#14633a` / `#7a4a00` / `#a61b1b` |

Typography: the system UI font stack and the system monospace stack. No web fonts are loaded, so the site works offline and on GitHub Pages without third-party requests. Base 14px in the application, 16px on the website. Line length under 80 characters for prose.

Shape: radius follows hierarchy (4px marks, 6px controls, 8px panels, 10px dialogs). No shadows except on floating layers. Motion: dialogs ease in; colour transitions on controls; nothing animates on its own. `prefers-reduced-motion` is respected, and forced-colors mode gets real borders.

Colour is never the only carrier of state: every badge has text, and every figure carries its provenance (Measured, Estimated, User-provided, Benchmark-derived, Unavailable).

## Shell

Left rail with four groups (Work, Insight, Control, Account) and icons. A top bar with the path (Local or Demo, project, screen), a command palette trigger (`Ctrl/Cmd K`) and the theme switch. On narrow screens the rail collapses behind a Menu button.

## Workspace

```
+---------+-------------------------------+-----------+
| Files   | Agent | file.ts | Diff x.ts   | Agents    |
| Tasks   |-------------------------------| Team      |
|         |  live feed / editor / diff    | Approvals |
|         |-------------------------------| Handoffs  |
|         | Activity | Git | Verification |           |
+---------+-------------------------------+-----------+
```

* Left: file tree read from `GET /api/files`, filter, tasks and goal.
* Centre: tabs for the agent (composer and live runs from `/api/runs`), files (editor with line numbers, hash-checked save via `POST /api/file`, conflict handling, Markdown preview built as elements and never as HTML) and diffs (`/api/worktrees/diff`).
* Right: every agent AgentOnTrack can govern (`/api/agents` and `/api/providers`), role assignment with Claude-codes/Codex-reviews and the reverse as presets (`POST /api/team`, confirmed), approvals, handoffs.
* Bottom: activity (`/api/actions`), git worktrees with merge preview, merge and discard, verification and receipts.
* Panels resize by pointer or arrow keys (`role="separator"`), collapse with `Ctrl B`, `Ctrl Shift B` and `Ctrl J`, and the layout is saved in this browser.
* Under 800px the workspace shows one pane at a time (Files, Editor, Agents, Evidence) chosen from a bottom tab bar.

Only Claude Code can be started from the interface today. The agent selector lists the others as "runs in its own terminal"; their hooks still report to the same record. No control is shown that has no real route behind it.

Every consequential change (approve, deny, merge, discard, save the team, save a protected file, create a task, accept a stale handoff) goes through the same confirmation dialog as before.

## Accessibility

* One `Modal` for every dialog: focus moves in, Tab and Shift Tab stay inside, Escape closes, focus returns to the opener, the page behind is inert.
* Tabs, the file tree, splitters and the palette follow the WAI-ARIA authoring patterns; the palette is a combobox with a listbox.
* Visible focus rings (2px accent), targets at least 28px with most at 34px or more, skip link, landmarks, `aria-live` on the agent feed.
* axe runs against every dashboard screen in both themes in the end-to-end suite.

## Not done, said plainly

* The editor is a plain text area with line numbers, not a syntax-highlighting editor. A code editor library was not added.
* The Antigravity and Cursor surfaces are not part of this change.
* Screenshots are of test projects driven through the real engine, not of customer data.

## Test record (run on the committed build)

| Check | Result |
|---|---|
| Workspace end-to-end (file save and conflict, protected file, Markdown preview, team roles both ways, approval, handoff, worktree diff and verification, layout and palette, dialog focus) against the real companion | PASS in Chromium, Firefox and WebKit |
| Mobile workspace (one view at a time, tab bar) | PASS on the Pixel 7 profile |
| Existing dashboard, projects, site and pairing suites after the restyle | PASS: Chromium 77 passed, Firefox and WebKit (workspace, dashboard, projects) passed, mobile project 56 passed |
| axe, no serious or critical violations, every dashboard screen in both themes, plus the project pages | PASS |
| Unit suite (375) and lint | PASS |
| Before and after screenshots, 13 dashboard screens and 16 site pages at desktop, tablet and mobile, with overflow check | Captured: `docs/ui/before` and `docs/ui/after`; no horizontal overflow on any public page |
| Real agents driven through the workspace composer | NOT_TESTED in this change (the live Claude path was tested through the VS Code client). The composer posts to the same `/api/runs` route |
| Full axe pass on the Workspace screen itself | NOT_TESTED: the existing axe test covers the screens in its list, not Workspace |
| Windows Edge, and a screen reader | NOT_TESTED |
