# AgentOnTrack interface design

Status of this document: describes what is built in `apps/dashboard` and `apps/web` as of 2026-11-11, after the owner's own redesign (made in Claude Design from a staged copy of these sources, then merged back by a three-way merge; the owner's notes are summarised in `CHANGELOG.md`). Test status is in docs/PRODUCT_READINESS.md, and every row there comes from a real run.

## Brief and direction

The product is a control layer for people who run AI coding agents for hours at a time. The interface is a working tool, so the design choices serve long sessions: low glare, dense but legible type, one accent, and no decoration that does not carry information. The owner's reference is Linear: quiet neutral surfaces, 1px borders instead of shadows, keyboard-first, short easing. Usability patterns only, nothing copied: no layouts, artwork or branding.

| Source | What was taken |
|---|---|
| Linear | A quiet left rail with grouped navigation and a soft active state; a command palette (Ctrl/Cmd K) and "G then a letter" jumps; status as small text badges; neutral charcoal surfaces with a single accent |
| Vercel | Project cards that lead with state (status, waiting approvals, last activity); activity as a log |
| Cursor | The agent as a tab beside the files, with the prompt composer under a live feed |
| VS Code | Explorer, tabbed editor, resizable and collapsible side and bottom panels, status bar |
| GitHub | Before/after diffs per file, review before merge, conflicts named by file |
| shadcn/ui | Accessible primitives and token naming. The components are plain React and CSS (dialog with focus trap, tabs, listbox palette); Tailwind and Radix were not added |

## Tokens

One palette, defined as CSS custom properties in a block marked `/* tokens:start */ … /* tokens:end */` in `apps/dashboard/src/styles.css` and `apps/web/app/globals.css`. The two blocks are byte-identical; `apps/web/test/design-system.test.ts` fails if they drift.

| Role | Dark | Light |
|---|---|---|
| Background / second background (`--bg`, `--bg-2`) | `#0b0b0c` / `#0f0f10` | `#f7f7f8` / `#f0f0f1` |
| Panel / raised (`--raised`, `--raised-2`) | `#131314` / `#1b1b1d` | `#ffffff` / `#f1f1f2` |
| Sunken, editor and code (`--sunken`) | `#070708` | `#ececed` |
| Border / strong (`--border`, `--border-strong`) | `#242426` / `#37373a` | `#dfdfe1` / `#bcbcc0` |
| Input edges, 3:1 against their ground (`--field`) | `#6a6a70` | `#85858b` |
| Text / muted | `#ededee` / `#9c9ca1` | `#131314` / `#59595e` |
| Accent (focus, selection, primary action) / large accent text / accent ink | `#86acd6` / `#a6c5e8` / `#08121d` | `#355c86` / `#27496c` / `#ffffff` |
| Accent tint / link text (`--accent-soft`, `--link`) | `#152231` / `#9dc0e6` | `#e2eaf3` / `#2d5580` |
| Good / warn / bad | `#5fd693` / `#ecba4a` / `#ff8b8b` | `#14633a` / `#7a4a00` / `#a61b1b` |
| Chart series `--s1` … `--s4` | `#86acd6` `#d3dde8` `#66788c` `#44709f` | `#3f6893` `#7393b3` `#5c6a79` `#1e3f61` |
| Registration marks and the rail (`--mark`) | `#4d6784` | `#8da6c1` |

Small accent-coloured text (eyebrows, step numbers, badges, terminal commands) uses `--link`, which meets 4.5:1 on panels in both themes; `--accent-2` is for large text and marks only. The owner computed every text colour against every surface it sits on; the lowest pair is muted text on the accent tint (5.9:1 dark, 5.7:1 light), and the chart series are at least 3.2:1 against the chart ground. axe confirms the serious and critical levels in both themes in the browser suites.

Typography: Inter (variable, Latin subset) for the interface, JetBrains Mono for code, both bundled from the apps' own files under the SIL Open Font License (`apps/web/app/fonts/LICENSES.txt`), with a metric-matched Arial fallback so text does not jump while Inter loads. On the site, Inter is declared by Next's font loader (`next/font/local` in `app/layout.tsx`: preloaded, the fallback's metrics matched automatically, exposed as `--font-inter`); the dashboard declares the same file in CSS. Both feed `--font-ui`. Nothing is fetched from a third party. Base 14px in the application, 16px on the website; headings on the site are Inter at 600 with tight tracking. Numbers are tabular.

Shape: square. Controls and badges have a 2px radius (`--r-1`, `--r-2`); panels, cards and dialogs have none (`--r-3` to `--r-5` are 0). Hairlines instead of shadows, with shadows only on floating layers; frames carry small `+` registration marks at their corners. Motion: 120, 200, 320 and 620 ms (`--dur-1` to `--dur-4`), `cubic-bezier(0.2, 0.8, 0.2, 1)` and an `--ease-out`; dialogs and toasts scale in, the live dot pulses, progress bars ease; the headline block, the terminal lines, page content on arrival and chart bars enter once without being asked; fades animate a mask through a registered custom property (`--fade`) rather than opacity, so text keeps its computed contrast while it arrives. Scroll-linked rules sit inside `@supports (animation-timeline: view())`, nested in the motion query; browsers without scroll-linked CSS get the section reveal from an observer in `apps/web/app/ui/effects.tsx`. Every `transition` and `animation` sits inside `@media (prefers-reduced-motion: no-preference)` (the same test checks). Forced-colors mode gets real borders. Colour is never the only carrier of state: every badge has text, and every figure carries its provenance (Measured, Estimated, User-provided, Benchmark-derived, Unavailable).

## Shell

Left rail (220px, the page's second background) with six sections and icons, an accent bar on the active section's left edge, jump-key hints (`G P` … `G S`, with `aria-keyshortcuts`) that appear when the rail is hovered or focused, and the live status at the bottom. The project timeline and the phase plan use the same motif: a hairline rail with a square station per event or phase, coloured by state. A top bar with the path (Local or Demo, project, screen), the palette trigger and the theme switch. Keyboard: Ctrl/Cmd K opens the palette; G then P/W/A/V/U/S jumps to Projects, Workspace, Agents, Approvals, Usage, Settings, never while typing or inside a dialog. On narrow screens the rail collapses behind a Menu button.

## Workspace

```
+---------+-------------------------------+-----------+
| Files   | Plan | Agent | Sessions       | Agents    |
| Tasks   |-------------------------------| Team      |
|         |  plan / feed / editor / diff  | Approvals |
|         |-------------------------------| Handoffs  |
|         | Activity | Git | Verification |           |
+---------+-------------------------------+-----------+
```

* Left: file tree from `GET /api/files`, filter, tasks and goal.
* Centre: Plan (phases with checks and limits), Agent (composer and live runs from `/api/runs`), Sessions, files (editor with line numbers, hash-checked save, conflict handling, Markdown preview built as elements) and diffs.
* Right: every agent AgentOnTrack can govern, role assignment, approvals, handoffs.
* Bottom: activity, git worktrees with merge preview, verification and receipts.
* Panels resize by pointer or arrow keys, collapse with Ctrl B, Ctrl Shift B and Ctrl J; the layout is saved in this browser. Under 800px the workspace shows one pane at a time from a bottom tab bar.

Only Claude Code and Codex can be started from the interface; the agent selector lists the others as "runs in its own terminal". No control is shown that has no real route behind it: the inert Diagnostics checkbox and the disabled Fork button are gone (the sentence that explained Fork stays).

## Website

Same tokens, sans only. The header is one row from 1181px up, drops its links to a second row between 901 and 1180px, and folds them behind the Menu button at 900px and below; it draws its hairline once the page has scrolled and shows reading progress along its foot. The home page: the headline on the left with the four facts as a ruled list beside it; under it one framed object, the product tour (a still, then a short recording of the dashboard in demo mode made by `scripts/capture-media.mjs`, labelled "Demo data"; never fetched until played, never auto-played for someone who prefers reduced motion) with the example terminal session docked on its right, its lines printing in order once; then the sections on a rail down the left, each with a numbered station and a path-like label (`01 ~/early-access`): early access, goal to evidence, agents, projects, closer look (three screenshots as full rows, frame beside caption, alternating sides, magnified under the pointer), the five steps drawn on a track that fills as you scroll, benchmarks (counters plus the prevented, detected and missed counts as one bar to scale), the comparison table with the AgentOnTrack column tinted, what it will not do, and apply or install. Tour and screenshot frames have a title bar over a 16:10 slot, the shape of the 1440×900 captures, so screenshots are shown whole. The early-access application is a three-step dialog (`apps/web/app/early-access/form.tsx`) behind the permanent Early access button, opened by itself about five seconds after arriving on the home page, once per session and never for someone signed in or who already applied. Sign-in, invitation, account, admin review and gated install pages share the `.auth` and `.gate` layouts.

## Accessibility

* One `Modal` per app for every dialog: focus moves in, Tab and Shift Tab stay inside, Escape closes, focus returns to the opener (Safari included: the opener is focused before opening), the page behind is inert and does not scroll.
* Tabs, the file tree, splitters and the palette follow the WAI-ARIA authoring patterns; the palette is a combobox with a listbox; the application form announces each field error with `role="alert"` and focuses the first invalid field.
* Visible focus rings (2px accent), targets at least 28px with most at 30px or more (44px on the phone layout), skip link, landmarks, `aria-live` on the agent feed and the toast stack.
* axe (wcag2a, wcag2aa, wcag21aa, wcag22aa; serious and critical) runs against every site page in both themes, every dashboard screen, every Workspace panel and dialog, the Sessions pane, the phone shell, and the open early-access dialog at each step.

## Media

`apps/web/public/shots/` holds the screenshots and the recording the home page uses; `.local/shots/` holds more for reports. All come from `scripts/capture-media.mjs` against the built site, in demo mode. `scripts/measure-web.mjs` records loading marks, layout shift, main-thread blocking, transfer sizes and the dialog's frame rate with a 4x CPU slow-down; `--runs 3` reports the median of three runs, since main-thread numbers swing by a third from run to run on a shared machine.

## Not done, said plainly

* The editor is a plain text area with line numbers, not a syntax-highlighting editor.
* The Antigravity and Cursor surfaces are not part of this.
* Screenshots are of the demo and of test projects, never of customer data.
* Screen readers: not tested with a real screen reader; the semantics are checked by axe and by the keyboard tests only.
