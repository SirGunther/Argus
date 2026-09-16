# Argus Playwright Surface And Logged Items Layout Work Breakdown

**Status:** Ready for implementation

**Execution model:** One low-reasoning implementation agent, one isolated branch

**Suggested branch:** `agent/playwright-logged-items-layout`

**Merge authority:** The coordinating agent reviews and merges; the implementation agent never
merges `main`

**Evidence authority:** This artifact, not the agent chat, is the durable implementation and review
record

## Why this work exists

The source Electron application is usable, but the populated **Logged Items** pane feels cramped.
The current row uses separate columns for selection, logged time, source context, item text, and the
copy action inside roughly half of the default 1180x800 window. The header and column-label strip use
the same constrained horizontal space for the pane title, item count, Scribe status, Select all, and
Copy selected controls.

The user specifically wants a quick surface pass before expanding functionality. The preferred
direction is to stack the **Logged** timestamp and **Source context** control within one metadata
column so the actual Logged Item text becomes the dominant flexible column. This is a focused layout
correction, not a visual redesign or a new workflow.

## Accepted boundaries

- Preserve Argus's current colors, typography, clean visual character, and two-pane desktop layout.
- Preserve the existing 1180x800 default window and 760x600 minimum window.
- Preserve all behavior: selection, Shift-click range selection, Select all/Deselect all, editing,
  copying, source navigation/highlighting, counts, Scribe status, Jump to live, and responsive pane
  stacking.
- Do not change transcript, Scribe, AI provider, audio, contracts, persistence, runtime wiring, or
  installer behavior.
- Do not add drawers, menus, packages, or architectural abstractions merely to rearrange this pane.
- Playwright must inspect the rendered surface. CSS assertions alone are not visual evidence.

## Agent operating rules

- [ ] Fetch `origin` and create an isolated worktree from current `origin/main`.
- [ ] Create exactly `agent/playwright-logged-items-layout`; never work in `C:\Argus` directly.
- [ ] Record the starting `origin/main` SHA and confirm the worktree is clean.
- [ ] Display this ticket's checklist in chat before editing and update only checklist status there,
  following `C:\dustin-thomason\agents\skills\checklist-in-chat\SKILL.md`.
- [ ] Put all WHY/HOW/WHAT analysis, observed measurements, screenshots references, changed-file
  evidence, and review evidence in this artifact rather than duplicating it in chat.
- [ ] If the necessary correction leaves the authorized files below, stop and record the blocker.
  Do not expand scope silently.
- [ ] Commit and push only the ticket branch. Do not merge `main` or rebuild the installer.
- [ ] Invoke
  `C:\dustin-thomason\scripts\notify-agent-complete.ps1 -Status "Completed" -Message "<5-9 word summary containing the agent name>"`
  after completion or when blocked waiting for user direction.

## UI-01 — Playwright surface audit and Logged Items layout correction

### Authorized production files

- `index.html`
- `styles.css`
- `app.js` only if rendered row structure must change; do not change message handling or commands

### Authorized focused tests

- `tests/ui-responsive-layout.test.mjs`
- `tests/select-all.test.mjs`
- one narrowly named new UI-layout test only if the existing tests cannot express the regression

### Stage 1 — Observe the real rendered problem

- [ ] Use Playwright to inspect a populated Argus renderer, not only source text. Prefer the existing
  deterministic `npm.cmd run demo:ui` surface for stable populated transcript and Logged Item rows.
- [ ] Also open the source Electron application with `npm.cmd start` and confirm the real shell uses
  the same DOM/CSS at its default size. No physical microphone or model call is required.
- [ ] Do not add Playwright to `package.json` or change the lockfile merely for this inspection. Use
  the available transient Playwright/installed browser. If Playwright cannot run, stop and report
  that blocker rather than substituting a nonvisual test.
- [ ] Populate enough data to show at least five transcript rows, five Logged Items, a multi-line
  Logged Item, source-range controls, and enabled batch controls.
- [ ] Capture before-change evidence at 1180x800 and 760x600. Also inspect 1024x768 if the defect
  changes materially between the default and minimum widths.
- [ ] Record the actual rendered bounding boxes and overflow state for the Logged Items header,
  column labels, metadata, item text, and row action. Identify the exact collision, truncation,
  wrapping, or wasted-width mechanism; do not infer it only from the CSS grid declaration.
- [ ] Confirm whether any horizontal scrolling, clipped controls, overlapping text, or misaligned
  column headings occurs.

### Stage 2 — Apply the smallest layout correction

- [ ] Combine Logged timestamp and Source context into one vertically stacked metadata column in
  each Logged Item row.
- [ ] Update the Logged Items column-label strip so its label and grid align with the new row layout.
  Do not leave separate headings over content that is now stacked.
- [ ] Make the Logged Item text the dominant flexible column at the default desktop size.
- [ ] Keep the checkbox and row copy control compact and aligned without shrinking their click or
  keyboard-focus targets.
- [ ] Keep the pane header readable: title, count, and Scribe status must not collide with Select
  all/Deselect all and Copy selected. Wrap or stack only at a real measured breakpoint.
- [ ] Preserve the current single-column pane stacking below 840px and ensure the minimum 760x600
  Electron window has no horizontal page or pane scrolling.
- [ ] Preserve transcript-pane geometry unless a shared selector requires a narrowly justified
  correction. Do not redesign the transcript rows.

### Stage 3 — Playwright acceptance

- [ ] Repeat the populated Playwright inspection at 1180x800, 1024x768, and 760x600.
- [ ] Record before/after measurements proving the item-text column gained usable width and no
  header, label, metadata, text, checkbox, or row-action bounding boxes overlap.
- [ ] Confirm `document.documentElement.scrollWidth <= document.documentElement.clientWidth` and
  each pane's scroll container does not gain horizontal overflow.
- [ ] Click a Logged Item source range and confirm the corresponding transcript rows are visibly
  highlighted.
- [ ] Select an ordinary checkbox, Shift-click a range in both directions, and confirm the rendered
  checkboxes remain filled and browser text is not accidentally selected.
- [ ] Enter and exit Logged Item editing, use Select all/Deselect all, and invoke Copy selected.
  Confirm the layout change did not alter these behaviors.
- [ ] Confirm the browser/Electron console contains no new page errors caused by the change.
- [ ] Run the focused UI tests, JavaScript syntax checks for changed JavaScript, and
  `git diff --check`. Run the full repository suite only if production JavaScript changed.
- [ ] Review the final diff and confirm every changed file is necessary for this visual defect.
- [ ] Update the evidence ledger below, commit, push, notify, and stop for coordinating review.

### Exit gate

- [ ] The Logged Items pane is visibly less cramped at the default 1180x800 window.
- [ ] Logged time and Source context share one clear stacked metadata column.
- [ ] Logged Item text owns the dominant flexible width and remains readable when wrapping.
- [ ] Headers and column labels align with row content at every inspected viewport.
- [ ] No horizontal overflow, overlap, clipped control, or regression in selection, editing, copy,
  source navigation, or responsive stacking is present.
- [ ] No unrelated runtime, contract, Scribe, audio, provider, or installer file changed.

## Evidence ledger

### Implementation record

- **Status:** Pending
- **Starting SHA:** Pending
- **Branch:** `agent/playwright-logged-items-layout`
- **Full commit SHA:** Pending
- **WHY — rendered failure:** Pending
- **HOW — narrow owning seam:** Pending
- **WHAT — corrected behavior and preserved behavior:** Pending
- **Before viewports and measurements:** Pending
- **After viewports and measurements:** Pending
- **Playwright surface used:** Pending
- **Screenshot references:** Pending; do not commit large binary screenshots unless requested

| Changed file | Evidence that this file owned the defect | Exact reason it changed | Resulting behavior |
| --- | --- | --- | --- |
| Pending | Pending | Pending | Pending |

| Verification | Command or action | Result |
| --- | --- | --- |
| Populated Playwright surface | Pending | Pending |
| Real Electron shell | Pending | Pending |
| Focused UI tests | Pending | Pending |
| Full suite, if required | Pending | Pending |
| Syntax/diff checks | Pending | Pending |

### Review record

- **Review status:** Pending
- **Reviewed full SHA:** Pending
- **Scope verdict:** Pending
- **Correctness verdict:** Pending
- **Real-rendered-failure coverage verdict:** Pending

| Finding | File and line/symbol evidence | Required disposition | Resolution |
| --- | --- | --- | --- |
| Pending | Pending | Pending | Pending |

- **Merge verdict:** Pending
- **Merged SHA:** Pending

## Definition of done

This work is complete only when Playwright demonstrates the populated Logged Items pane is clearer
at default and minimum Electron sizes, all existing Logged Item interactions still work, the branch
has a recorded review verdict, and the reviewed change is merged by the coordinating agent.
