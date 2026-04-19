# another-workbench

Another Workbench is a multi-agent desktop GUI built around a typed runtime/event model.

The default desktop path now runs through a real Electron host and a real Codex app-server
runtime. The in-browser demo harness is still available, but it is kept separate from the
default product entry.

## Workspace Layout

- `packages/shared`: typed command, event, and IPC schemas
- `packages/core`: runtime event bus and session orchestration primitives
- `packages/adapters`: agent adapters and runtime-backed mapping logic
- `apps/desktop`: Electron renderer, preload bridge, and desktop host wiring
- `apps/desktop-server`: runtime service composition, remote protocol, and headless server

## Commands

- `pnpm install`
- `pnpm typecheck`
- `pnpm build`
- `pnpm --filter @another-workbench/desktop dev`
- `pnpm --filter @another-workbench/desktop start`
- `pnpm --filter @another-workbench/desktop dev:demo`
- `pnpm smoke:codex`
