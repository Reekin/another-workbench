SmartTakeover enables takeover mode for this session.

Actions:

* Call action="help" first to read this help.
* Call action="start" once, and only once, near the beginning of a complex or long-running task.
* The start call must include a presetId and a stable task requirement context.
* Do not call action="start" again to update progress, phase state, review findings, or implementation details.

After the current assistant response finishes, Another Workbench starts a takeover agent in the same workspace. The takeover agent acts as the user's delegated reviewer or progress manager and reports back through SubmitTakeoverVerdict.

Editable resources:

* Tool description: {{systemRoot}}\description.md
* Complete help: {{systemRoot}}\help.md

Help changes apply to the next help call. Tool description changes apply when a new provider thread is created.

Context purpose:
The context is a stable baseline for the entire task lifecycle. It should help the takeover agent understand the long-term task scope, source-of-truth documents, project layout, and durable technical references. The context must remain valid even after phases are completed, roadmap state changes, implementation details change, or the current review target changes.

Context must include only lifecycle-stable information about current session task, such as:

* Overall project objective
* Project root and important stable directories
* Original/reference package locations
* Source-of-truth documents of current session task, such as ROADMAP.md
* Stable technical references or documentation locations
* Stable smoke-test or validation entry points, if they are generally applicable across the project

Context must not include transient, progress-dependent, or reviewer-directive information, such as:

* Current phase, current task, active milestone, current priority, or current review target
* Latest implementation summary
* Latest verification results
* Recently changed files
* Current blockers, TODOs, or open questions
* Stage-specific generated evidence files unless they are stable project-level references
* Claims that a task, phase, or stage is completed, accepted, blocked, or pending
* Acceptance rules, acceptance principles, or completion criteria phrased as instructions to the reviewer
* Any instruction to approve, reject, mark complete, advance, keep active, or otherwise change roadmap state
* Any checklist telling the takeover agent what to inspect in the current review
* Any step-by-step plan, partial progress note, or tactical instruction

Do not teach or command the reviewer inside the context.
The context may identify where acceptance requirements are defined, but it must not restate those requirements as reviewer instructions. Avoid phrases such as:

* "Review mode:"
* "Please check..."
* "Decide whether..."
* "If accepted, mark..."
* "Otherwise return blockers..."
* "Current focus..."
* "Current priority..."
* "Active phase..."
* "Latest implementation..."
* "Verification already run..."
* "Should not be accepted..."
* "Must not be considered complete..."

Good context style:
Use stable nouns and project facts. Prefer broad project-level references over copied current roadmap content. For example, say "ROADMAP.md defines task order, task scope, dependencies, acceptance requirements, and completion state" instead of listing the current roadmap phase order, current phase status, or acceptance rules.

Bad context example:

```text
Project: D:\Dev\Projects\Experiment\AGame

Current priority order:
1. Source evidence and real entry discipline
2. Juno static figure assembly from real data
3. Full static room-03 map assembly
4. Juno animation and movement on the full map

Phase 1 evidence and tooling entry points:
Docs\OriginalEvidence\Phase1Review.md
Docs\OriginalEvidence\generated\phase1_logic\phase1_logic_manifest.json
Tools\OriginalEvidence\validate_phase1_evidence.py

Key acceptance intent for Phase 1:
Freeze a complete original-source evidence contract before runtime Unity translation work.

Review mode:
Use the roadmap and generated evidence to decide whether Phase 1 can be marked completed. If accepted, mark the roadmap Phase 1 as completed; otherwise return blockers and keep Phase 1 active.

Acceptance discipline:
Stages should not be treated as complete unless they satisfy implementation, review, test, and smoke acceptance. Placeholder implementations or runtime behavior without source evidence should not be accepted as complete.
```

This is bad because it includes current priority, current phase-specific acceptance intent, phase-specific evidence, reviewer instructions, roadmap state-change instructions, and acceptance guidance phrased as commands to the reviewer.

Good context example:

```text
Project:
I:\GameDev\Projects\Experiment\AGame

Original package:
E:\common\AGame

Objective:
Replicate AGame in the Unity project by translating original package data and original runtime behavior into Unity according to ROADMAP.md.

Source of truth:
ROADMAP.md defines task order, task scope, dependencies, acceptance requirements, and completion state.

Original implementation reference:
When behavior needs to match the original game, the original package is located at:
E:\common\AGame

Bundled runtime reference:
E:\common\AGame\terra\dist\bundle.js

Stable evidence and validation areas:
- Docs\OriginalEvidence
- Tools\OriginalEvidence
- Tools\UnityValidation

Unity project areas:
- Assets\AGame\Runtime
- Assets\AGame\Editor
- Assets\AGame\Tests
- Docs
- Tools

Smoke and validation:
Tools\adn-smoke.sh is the project smoke wrapper for package-root based checks.
```

This is good because it states stable project facts, the long-term objective, source-of-truth documents, key directories, and stable technical references. It does not include the current phase, latest progress, latest verification, current review target, completion claims, or instructions telling the takeover agent what to approve, reject, inspect, or change.

Preset prompts are read from {{presetRoot}}. Each preset can be a directory containing prompt.md or another .md file, or a direct .md file.

Available presets:
{{presetList}}

For review loops, use presetId="review". If the verdict is incomplete, do the requested work from response; takeover mode will review again after the next completed response while it remains enabled.

For roadmap/progress loops, use presetId="progress". Put scenario-specific review standards in the preset prompt.

The takeover agent must call SubmitTakeoverVerdict once. verdict="complete" accepts the current state and ends takeover. verdict="incomplete" sends response back as the user's next reply so the agent continues. The managed agent may call SmartTakeover with action="stop" to disable takeover when further review loops are no longer useful.
