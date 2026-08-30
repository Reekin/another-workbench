# Engine Boundary Todo

## Goal

把 engine turn 工件从 shared protocol / generic store / generic transcript 主路径中收回到 engine-specific extension 边界内。

保留 host/workspace 文件能力：

- 搜索工作区文件
- 预览文件
- `open`
- `reveal`

把下面这些能力改为 Codex extension：

- turn changed files summary
- turn diff payload
- undo turn changes

## Todo

### task_01_protocol_boundary

status: completed

scope:

- `packages/shared/src/domain.ts`
- `packages/shared/src/events.ts`
- `packages/shared/src/ipc.ts`
- `packages/core/src/domain-projector.ts`
- `apps/desktop/src/store/reducer.ts`

work:

- 删除 shared `Turn.unifiedDiff`
- 删除全局事件 `turn.diff.updated`
- 删除通用 reducer / projector 对 `turn.diff.updated` 与 `unifiedDiff` 的依赖
- 把 turn change 数据从 shared turn/event 主链中移出

tdd:

- 需要
- 先补 shared / projector / reducer 的回归测试，证明 generic 主链不再携带 turn diff

test_design:

- 单元测试：shared schema 解析、projector、renderer reducer
- 集成测试：desktop transcript 基于通用 snapshot 仍可正常渲染
- 用户视角验收：普通聊天 turn 在 UI 中不受影响

done_when:

- shared turn/event schema 中不再出现 `unifiedDiff` 与 `turn.diff.updated`
- projector / reducer 不再要求理解 Codex diff 事件
- 相关测试通过

verify:

- `pnpm --filter @another-workbench/shared test`
- `pnpm --filter @another-workbench/core test`
- `pnpm --filter @another-workbench/desktop test -- transcript`

### task_02_codex_turn_changes_extension

status: completed

scope:

- `apps/desktop-server/src/codex-app-server-runtime-port.ts`
- `apps/desktop-server/src/session-discovery.ts`
- `apps/desktop-server/src/workbench-shell-service.ts`
- `apps/desktop-server/src/remote-protocol.ts`
- `apps/desktop-server/src/engine-control/*`
- new `apps/desktop-server/src/engine-extensions/codex/*`

work:

- 新建 Codex turn changes extension 数据模型与查询接口
- Codex runtime / discovery 只向 extension 数据源写 diff
- `undo turn changes` 改成 Codex extension action，不再作为顶层通用 RPC
- 在 engine surface 中声明该 extension

tdd:

- 需要
- 先补 Codex extension service 的单测，再接 runtime / shell / remote

test_design:

- 单元测试：Codex diff 归一化、extension service 查询、undo action 路由
- 集成测试：remote/local 都只能通过 Codex extension 入口获取 turn changes
- 用户视角验收：Codex session 可看到 changed files，并能执行 undo

done_when:

- Codex diff 数据只存在于 extension 数据源
- `turn.undoChanges` 不再是顶层通用 RPC
- `engine.getSurface("codex")` 能声明 changed-files extension

verify:

- `pnpm --filter @another-workbench/desktop-server test -- codex-app-server-runtime-port`
- `pnpm --filter @another-workbench/desktop-server test -- session-discovery`
- `pnpm --filter @another-workbench/desktop-server test -- remote-protocol`

### task_03_host_file_actions_vs_engine_extensions

status: completed

scope:

- `apps/desktop-server/src/file-action-service.ts`
- `apps/desktop/src/transport/desktop-transport.ts`
- `apps/desktop/src/ui/chat-shell/MessageMarkdownView.tsx`

work:

- host 只保留通用 open / reveal 文件动作
- 工作区文件搜索、预览和 Files panel 不进入 shell 主路径
- 消息 Markdown 不提供本地文件链接激活入口
- turn changed files / undo 由 engine extension 独立承载

tdd:

- 需要
- 先补通用文件动作与 extension 分离后的 transport 测试

test_design:

- 单元测试：desktop transport 文件动作
- 集成测试：open / reveal 仍正常，搜索与预览 RPC 不再存在
- 用户视角验收：详情栏只展示 Graph，消息不暴露本地文件入口

done_when:

- host file action API 与 Codex turn changes API 分离
- shell 不包含 Files tab、文件搜索或内联预览
- 相关 transport 测试通过

verify:

- `pnpm --filter @another-workbench/desktop test -- desktop-transport`

### task_04_ui_extension_slot_and_remote_alignment

status: completed

scope:

- `apps/desktop/src/ui/chat-shell/ChatShellApp.tsx`
- `apps/desktop/src/ui/chat-shell/transcript-view-model.ts`
- `apps/desktop/src/ui/chat-shell/MessageMarkdownView.tsx`
- new `apps/desktop/src/features/engine-extensions/codex/*`
- `apps/desktop-server/src/remote-bootstrap-service.ts`
- `packages/shared/src/remote-control.ts`

work:

- transcript 主路径只保留通用消息/工具/审批/终端渲染
- 新建 turn extension slot，并把 Codex changed files strip 挂到 Codex extension renderer
- `MessageMarkdownView` 不承载本地文件动作
- remote bootstrap 不再维护平行 `features[]` 真相，改为 host info + engine surface / engine list 同源表达

tdd:

- 需要
- 先补 transcript view-model、message markdown、remote bootstrap 的回归测试

test_design:

- 单元测试：view-model、markdown 资源意图、remote bootstrap schema
- 集成测试：Codex extension renderer 只在 Codex surface 可用时挂载
- 用户视角验收：Codex session 能看到 changed files extension；非 Codex 或无 extension 时 transcript 保持干净

done_when:

- generic transcript path 不再直接渲染 changed files strip
- markdown 组件不包含宿主本地文件动作
- remote bootstrap 不再硬编码 engine feature 名单

verify:

- `pnpm --filter @another-workbench/desktop test -- transcript-view-model`
- `pnpm --filter @another-workbench/desktop test -- message-markdown-view`
- `pnpm --filter @another-workbench/desktop-server test -- remote-control-services`

## Order

1. `task_01_protocol_boundary`
2. `task_02_codex_turn_changes_extension`
3. `task_03_host_files_vs_engine_extensions`
4. `task_04_ui_extension_slot_and_remote_alignment`
