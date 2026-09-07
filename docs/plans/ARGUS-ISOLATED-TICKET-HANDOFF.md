# Argus Isolated Ticket Handoff Framework

Use this framework as one continuous prompt. Append exactly one complete ticket from an approved Argus work-breakdown document after the final divider.

You are implementing one isolated Argus ticket. The complete ticket text will be appended at the bottom of this framework. Treat that ticket as the authoritative description of the requested outcome.

Repository: `C:\Argus`
Baseline: `origin/main`
Branch convention: `agent/<derived-task-slug>`
Worktree convention: `C:\Argus-worktrees\<derived-task-slug>`

Read the ticket first. Derive a short, descriptive task slug from it. Then derive the implementation scope, necessary touch points, expected behavior, and validation checklist by inspecting only the directly relevant production files and focused tests. Do not require the user to provide those details separately.

Before editing, run the equivalent of:

```powershell
$argusRepo = "C:\Argus"
$taskSlug = "<derived-task-slug>"
$branchName = "agent/$taskSlug"
$worktreePath = "C:\Argus-worktrees\$taskSlug"

git -C $argusRepo remote get-url origin
git -C $argusRepo fetch --prune origin
git -C $argusRepo rev-parse origin/main
git -C $argusRepo status --short

git -C $argusRepo worktree add -b $branchName $worktreePath origin/main
Set-Location $worktreePath

$startingCommit = git rev-parse HEAD
Write-Output "Starting commit: $startingCommit"
git status --short
```

Confirm that the worktree is clean and that its starting commit exactly matches the current `origin/main`. Do not edit the main checkout.

If the proposed branch or worktree already exists, do not delete, overwrite, reset, or reuse it blindly. Select a safe unused branch suffix or report the collision.

If the ticket depends on work that has not been merged into `origin/main`, stop and identify the exact prerequisite branch or commit. Do not merge, cherry-pick, or rebase another agent's work unless the ticket explicitly authorizes it. The coordinating agent will perform merges.

Before implementation, create and display a concise checklist derived from the ticket and codebase. The checklist must cover:

- The user-visible defect or requested outcome
- The production execution path responsible for it
- The minimum files or components expected to change
- Applicable architectural boundaries
- Focused validation of the corrected behavior
- Commit, push, and completion reporting

Check off each item as it is completed. Do not claim completion while required items remain unchecked.

Work autonomously from the ticket. Determine the necessary files and behavior through focused inspection. Avoid broad repository reviews, unrelated historical documents, speculative enhancements, dependency upgrades, formatting churn, or opportunistic refactoring.

Preserve these Argus constraints wherever applicable:

- Implement real production behavior. Do not add simulations, fake runtime behavior, or test-only substitutes to the production path.
- Preserve explicit contracts, wires, service isolation, and intentional component boundaries.
- Route state mutations through the authoritative owner.
- Preserve stable identity, idempotency, ordering, provenance, and append-only history.
- Preserve bounded queues, serial AI execution, visible failures, and governed recovery behavior.
- Do not bypass an architectural boundary for convenience.
- Change contracts or schemas only when the ticket genuinely requires it. If changed, update their fixtures, governance records, generated documentation, and affected wiring.
- Keep changes limited to what is necessary to complete the ticket.
- Do not rebuild installers unless the ticket explicitly requests it.
- Do not merge into main.

Use focused validation proportional to the files and behavior changed. Run the complete suite only when the change affects shared runtime behavior, contracts, cross-component wiring, or the ticket explicitly requires it. At minimum:

- Exercise the corrected behavior through the closest applicable focused test or real source path.
- Add regression coverage when the defect could reasonably recur.
- Run relevant syntax, contract, governance, or package checks when those areas changed.
- Run `git diff --check`.
- Review the final diff for scope and unrelated changes.
- Clearly identify any physical-device or user acceptance that remains pending.

After implementation and validation:

```powershell
git status --short
git diff --check
git add -- <exact changed files>
git commit -m "<concise ticket-specific message>"
git push -u origin $branchName

$finalCommit = git rev-parse HEAD
Write-Output "Full commit SHA: $finalCommit"
git status --short
```

The worktree must be clean after the commit and push.

Report:

- Starting `origin/main` commit
- Branch name
- Full commit SHA
- Push confirmation
- Root cause or previous behavior
- Corrected behavior
- Exact affected files
- Completed checklist
- Tests and checks executed
- Remaining user or physical-device acceptance
- Confirmation that main was untouched
- Confirmation that the installer was not rebuilt

Always follow:

`C:\dustin-thomason\agents\rules\agent-completion-notification.md`

After pushing and before reporting completion, send:

```powershell
& "C:\dustin-thomason\scripts\notify-agent-complete.ps1" `
    -Status "Completed" `
    -Message "Codex completed <short ticket result>"
```

The notification message must contain `Codex` and remain approximately 5–9 words.

If blocked and user input is required, send the notification before asking the question so the user knows attention is needed. Explain the blocker precisely and do not claim completion.

TICKET TEXT BEGINS BELOW

==================================================
