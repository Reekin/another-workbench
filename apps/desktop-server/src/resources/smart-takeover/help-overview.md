SmartTakeover enables takeover mode for this session. Call action="help" first, then call action="start" once at the beginning of a complex or long-running task with a presetId and stable task requirement context. After your current response finishes, Another Workbench starts a takeover agent in the same workspace. The takeover agent acts as the user's delegated reviewer or progress manager and reports back through SubmitTakeoverVerdict.

Context format:
Briefly and concisely state the assigned work, goals to achieve, acceptance points, key directories, technical documentation, and roadmap if any. Only provide information that should stay in focus throughout the entire task cycle; the goal is to let the reviewer understand the scope of acceptance checks. Do not include partial or step-by-step details, and do not tell the reviewer what to do. Do not call start again just to update context; the first task context remains the baseline.

Bad context example:
```
Project: D:\Dev\Projects\Experiment\AGame
Original package root: E:\common\AGame
Takeover preset: progress

Global objective:
Replicate AGame in the current Unity project by translating original package/runtime semantics into Unity. Current active phase is task_05_juno_figure_runtime_animator. Do not approve or advance task_06 unless task_05 is accepted. task_01-task_04 were previously accepted; task_05 and later tasks must remain unchecked until reviewed.

Latest task_05 implementation summary:
- Juno is loaded through the real chain:
  terra\data\players\juno.json -> CHA:main#Juno -> FIG:char.player.juno#default
- Juno actor builds 32 node transforms and 25 original gfx source layers from real figure data.

Latest verification already run by developer:
- ./unity-cli.exe compile --wait --json
  Result: compile_succeeded, error_count=0, warning_count=0

Review focus requested:
Judge whether task_05_juno_figure_runtime_animator can now be accepted. Please specifically check FigureNodeAnimXfm, event timing, parent:null semantics, onMissingFrame=HIDE, docs wording, and ROADMAP.md state.
```
This is bad because it mixes in time-sensitive phase state, latest implementation/verification status, and instructions telling the reviewer what to check.

Good context example:
```
Project: I:\GameDev\Projects\Experiment\AGame

Original package:
E:\common\AGame

Objective:
Replicate AGame in the Unity project by translating original package data and original runtime behavior into Unity according to ROADMAP.md.

Source of truth:
ROADMAP.md in the Unity project defines task order, task scope, dependencies, and completion state.

Original implementation reference:
When behavior needs to match the original game, inspect the original package under:
E:\common\AGame

The bundled runtime implementation is at:
E:\common\AGame\terra\dist\bundle.js

Shell smoke wrapper:
Tools\adn-smoke.sh is the project smoke wrapper for package-root based checks.

Important project files:
- ROADMAP.md
- Assets\AGame\Runtime
- Assets\AGame\Editor
- Assets\AGame\Tests
- Docs
- Tools
```
This is good because it states the task, stable goals, acceptance scope, key directories, technical references, and roadmap source without local progress details or reviewer instructions.
