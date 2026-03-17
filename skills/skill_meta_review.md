# PageOne Meta-Skill Review Protocol

## When This Runs
This protocol executes when the user invokes `/review-skills` in a Claude Code session.

---

## Review Steps

### Step 1 — Read the observation log
Read `data/skill_observations/log.md`. Collect all entries with **Status: OPEN**.

If there are no OPEN observations, report: "No open observations — skill files are up to date." Stop here.

### Step 2 — Read relevant skill files
For each OPEN observation, read the skill file it references from `skills/`.

### Step 3 — Group by skill file
Organize observations by the skill file they target. A single skill may have multiple observations; handle them together.

### Step 4 — Generate proposed edits
For each affected skill file, produce a concrete proposed edit:
- Show the **exact text to replace** (old) and the **replacement text** (new)
- Cite which observation(s) the edit addresses
- State the rationale in one sentence

If observations for a skill conflict, flag the conflict and ask the user to decide before proposing an edit.

### Step 5 — Present for approval (one skill at a time)
For each proposed edit, present it clearly and ask:

> "Apply this change to `skills/[filename]`? → **yes** / **no** / **modify**"

- **yes**: Write the change to the skill file immediately. Mark the addressed observations ACTIONED in the log.
- **no**: Mark the observations DECLINED in the log. Move to the next skill.
- **modify**: Incorporate the user's revision, show the updated diff, confirm before writing.

Do not batch changes. One skill at a time, one approval at a time.

### Step 6 — Update observation statuses
After each approval or rejection, update the observation's `**Status:**` field in `data/skill_observations/log.md`:
- Approved → `ACTIONED — Applied to [skill filename], [brief description of change]`
- Rejected → `DECLINED — [reason if user gave one]`

### Step 7 — Present summary
After all skills are reviewed, output:

```
## /review-skills Complete — [date]

- Observations reviewed: N
- Changes applied: N (to: [list of skill files])
- Declined: N
- Skipped (ambiguous): N

[If any were skipped, explain why and what the user should do.]
```

---

## Constraints
- **Never modify a skill file without explicit user approval for that specific change.**
- Never create new skill files autonomously. If an observation suggests a new skill is needed, flag it in the summary for the user to decide.
- If an observation is too vague to produce a concrete edit, skip it and note it in the summary.
- If the proposed change would conflict with another rule in the same skill file, flag the conflict before applying.
- This protocol does not run automatically. It only runs when the user explicitly invokes `/review-skills`.
