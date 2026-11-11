# AgentOnTrack interface design

Status of this document: describes what is built in `apps/dashboard` and `apps/web` as of 2026-11-10. Test status is in docs/PRODUCT_READINESS.md, and every row there comes from a real run.

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
| Background / second background | `#0b0c0f` / `#0e1014` | `#f9f9fb` / `#f2f3f6` |
| Panel / raised | `#121418` / `#191c22` | `#ffffff` / `#f3f4f7` |
| Sunken (editor, code) | `#08090b` | `#eef0f3` |
| Border / strong | `#22252c` / `#31353e` | `#e3e5ea` / `#c6cad3` |
| Text / muted | `#ededf0` / `#8f95a3` | `#121418` / `#5a6070` |
| Accent (focus, selection, primary action) / link text | `#2dd4bf` / `#5eead4` | `#0f766e` / `#0f766e` |
| Good / warn / bad | `#4fd98a` / `#f0bb3b` / `#ff8080` | `#14633a` / `#7a4a00` / `#a61b1b` |

Small accent-coloured text (eyebrows, step numbers, badges, terminal commands) uses `--link`, which meets 4.5:1 on panels in both themes; `--accent-2` is for large text and marks only.

Typography: Inter (variable, Latin subset) for the interface, JetBrains Mono for code, both bundled from the apps' own files under the SIL Open Font License (`apps/web/app/fonts/LICENSES.txt`), with a metric-matched Arial fallback so text does not jump while Inter loads. On the site, Inter is declared by Next's font loader (`next/font/local` in `app/layout.tsx`: preloaded, the fallback's metrics matched automatically, exposed as `--font-inter`); the dashboard declares the same file in CSS. Both feed `--font-ui`. Nothing is fetched from a third party. Base 14px in the application, 16px on the website; headings on the site are Inter at 600 with tight tracking. Numbers are tabular.

Shape: radius follows hierarchy (4px marks, 6px controls, 8px panels, 12px dialogs, 16px large frames). No shadows except on floating layers. Motion: 120–280 ms, `cubic-bezier(0.2, 0.8, 0.2, 1)`; dialogs and toasts scale in, the live dot pulses, progress bars ease; every `transition` and `animation` sits inside `@media (prefers-reduced-motion: no-preference)` (the same test checks). Forced-colors mode gets real borders. Colour is never the only carrier of state: every badge has text, and every figure carries its provenance (Measured, Estimated, User-provided, Benchmark-derived, Unavailable).

## Shell

Left rail (220px, the page's second background) with six sections and icons, a soft filled active state, and the live status at the bottom. A top bar with the path (Local or Demo, project, screen), the palette trigger and the theme switch. Keyboard: Ctrl/Cmd K opens the palette; G then P/W/A/V/U/S jumps to Projects, Workspace, Agents, Approvals, Usage, Settings, never while typing or inside a dialog. On narrow screens the rail collapses behind a Menu button.

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

Same tokens, sans only. The home page: a hero with the early-access action, a product tour frame that plays a short recording of the dashboard in demo mode (made by `scripts/capture-media.mjs`, labelled "Demo data"; it is never fetched until played, and never auto-plays for someone who prefers reduced motion), real screenshots in a "closer look" strip, the five steps, the measured results with counters, the comparison table, and what it will not do. The early-access application is a three-step dialog (`apps/web/app/early-access/form.tsx`) behind the permanent Early access button, opened by itself about five seconds after arriving on the home page, once per session and never for someone signed in or who already applied. Sign-in, invitation, account, admin review and gated install pages share the `.auth` and `.gate` layouts.

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
