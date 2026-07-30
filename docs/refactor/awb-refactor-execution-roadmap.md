# Another Workbench 重构可执行 Roadmap

> 配套文档：[awb-refactor-master-plan.md](./awb-refactor-master-plan.md)
>
> 仓库稳定副本：`docs/refactor/awb-refactor-execution-roadmap.md` 与 `docs/refactor/awb-refactor-master-plan.md`。Downloads 中的同名文件仅作为同步副本。
>
> 本 roadmap 以当前工作树为基线，所有 task 默认由独立 subagent 完成；每个阶段完成开发与自验后必须停下，由 reviewer/takeover 验收通过后才能进入下一阶段。

# Phase 0：冻结基线

## 阶段目标

将当前 architecture-invariants 修复独立收口，修复已确认的 engine binding 字段丢失，并建立可重复的基线验收记录。

## 用户可感知结果

无新功能；现有 reload、replay、provider identity、scheduler engine 语义不回退。

## 通过标准

- 当前未提交修复形成独立 commit。
- LOC 基线由 `node scripts/count-production-loc.mjs` 重新记录，禁止继续手填不可复跑数字。
- shared/core/desktop-server/desktop tests、typecheck、lint、architecture checks 通过。
- Codex 真实 smoke 通过。
- `registerAgentBinding()` 不丢失任何字段。

## 验收手段

执行真实 host/CLI 验收；检查 git diff 和 task PRD，不只依赖文档中的旧验证记录。

## 伪完成风险

- 仅相信现有 Verification Log，没有在当前工作树复跑。
- 把后续 runtime 重构混入同一个 commit。

[x] task_0_1: 收口 architecture-invariants 当前工作
- tag: infra
- goal: 建立后续所有重构共同依赖的稳定基线
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要继承当前审查结论、未提交工作树范围和既有任务验收口径
- tdd: not_needed
- test_design:
  - unit: 不新增；本任务是对既有修复做完整回归
  - integration: 运行四个 TS package 全量测试、typecheck、architecture checks
  - user_acceptance: 运行真实 Codex smoke，确认 host 默认入口而非 demo
- done_when:
  - architecture-invariants 阶段验收项与实际命令结果一致
  - 当前修复形成单独 commit，工作树不混入下一阶段代码
- verify:
  - `pnpm --filter @another-workbench/shared test`
  - `pnpm --filter @another-workbench/core test`
  - `pnpm --filter @another-workbench/desktop-server test`
  - `pnpm --filter @another-workbench/desktop test`
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm check:native-engine-boundaries`
  - `node scripts/count-production-loc.mjs`
  - `pnpm smoke:codex`
  - `git diff --check`

[x] task_0_2: 修复 WorkbenchAgentBinding 字段丢失
- tag: prod
- goal: 在 EnginePlugin 替换旧 binding 前，保证现有 capability 数据真实可用
- executor: subagent
- subagent_context: no_inherit
- subagent_context_reason: 问题局限在 runtime-types/orchestrator，读取当前代码和测试即可独立完成
- tdd: required
- test_design:
  - unit: 注册 binding 后断言 integrationTier、transportKind、sharedCapabilities、extensions 均保留
  - integration: production composition 下 Codex capability 列表包含 goal、attachments、conversationGraph 等声明项
  - user_acceptance: 不需要独立 GUI 验收；纳入 Phase 0 host 查询
- done_when:
  - `registerEngine()` 与 `registerAgentBinding()` 不再丢字段
  - `getEngineCapabilities()` 使用完整 shared capability surface
  - LOC 基线记录为 `productCodeTsTsxGo = 52,638`
- verify:
  - `pnpm --filter @another-workbench/desktop-server test -- runtime-orchestrator prod-service`
  - `pnpm typecheck`

# Phase 1：Runtime 生命周期

> 阶段状态：已验收通过（2026-06-25）。

## 阶段目标

建立 single-flight start/stop、进程 generation、request timeout/abort、crash reject-all 和可恢复状态。

## 用户可感知结果

runtime 缺失、崩溃、退出或卡住时，用户获得明确错误；应用不挂死、不留孤儿进程，并可通过下一条新命令恢复。

## 本阶段不做

- 不改变 domain model。
- 不重写 RPC。
- 不自动重发已发送过的 provider command。

## 通过标准

- 并发初始化只 spawn 一次。
- start 失败可重试。
- stop/crash reject 所有 pending。
- 每个 request 支持 timeout 和 AbortSignal。
- Codex/ACP 真实 smoke 均通过。
- 人工 kill runtime 后状态变 failed，下一条新命令可重启。

## 验收手段

fake runtime 集成测试、真实 Codex/ACP smoke、真实进程 kill 行为验收。

## 伪完成风险

- 只在 adapter 加一个 Promise，但 port 仍可并发 spawn。
- stop 清空 map 却不 settle Promise。
- 单测使用 fake object，没有真实 child process。

[x] task_1_1: 定义 runtime lifecycle 与错误契约
- tag: infra
- goal: 为所有 runtime 建立相同的状态与错误语义
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要沿用主计划明确的恢复策略——崩溃后不自动重发旧 command，只允许新 command 触发 restart
- tdd: required
- test_design:
  - unit: lifecycle state transition、非法转换、错误分类
  - integration: AdapterRuntimePort 类型由 Codex/ACP fake implementation 共同实现
  - user_acceptance: 不需要；契约任务由本阶段整体真实进程验收
- done_when:
  - `RuntimeLifecycleState`、timeout/aborted/process-exited 错误成为正式类型
  - RuntimePort request 支持 signal/timeout options
- verify:
  - package typecheck
  - contract tests

[x] task_1_2: 实现 LifecycleGate
- tag: infra
- goal: 消除 adapter/port 并发 start 与 stop 竞态
- executor: subagent
- subagent_context: no_inherit
- subagent_context_reason: 可在隔离上下文中按正式状态机契约实现
- tdd: required
- test_design:
  - unit: 10 个并发 start 只调用一次底层 start；失败后重试；start 中 stop；重复 stop
  - integration: fake child process adapter 接入 gate
  - user_acceptance: 不需要，内部并发原语
- done_when:
  - startPromise/stopPromise 的所有 settle 路径均清理
  - 无 stuck `starting`/`stopping`
- verify:
  - targeted Vitest
  - fake timer/real timer 两组测试

[x] task_1_3: 实现 ChildProcessSupervisor
- tag: infra
- goal: 统一 child spawn/error/exit/kill generation 所有权
- executor: subagent
- subagent_context: no_inherit
- subagent_context_reason: 进程 supervisor 可通过独立 fixture 程序完整实现与验证
- tdd: required
- test_design:
  - unit: generation token、kill escalation、旧进程 late exit
  - integration: executable 不存在、正常启动退出、强制 kill、stderr
  - user_acceptance: CLI 启动 fixture 并实际观察退出码/进程清理
- done_when:
  - `spawn` 成功前不会暴露 ready process
  - error/exit 只影响对应 generation
  - stop 超时能升级终止
- verify:
  - child-process fixture integration tests
  - Windows 真实进程检查

[x] task_1_4: 实现 JsonRpcLineClient
- tag: infra
- goal: 闭合 JSON-RPC pending request 生命周期
- executor: subagent
- subagent_context: no_inherit
- subagent_context_reason: 可针对 line protocol fixture 独立实现
- tdd: required
- test_design:
  - unit: response/error/timeout/abort/rejectAll/write failure/id collision
  - integration: fake Codex app-server 进程，覆盖无响应和中途退出
  - user_acceptance: CLI 请求无响应 fixture，确认在 deadline 内退出
- done_when:
  - pending map 不存在无法 settle 的路径
  - stop/crash/write error 均删除并 reject pending
  - stdin backpressure 正确处理
- verify:
  - targeted tests
  - process-level timeout smoke

[x] task_1_5: Codex runtime 迁移到 supervisor/client
- tag: prod
- goal: 让默认 native runtime 使用正式生命周期
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要继承 Codex 当前 approval/interaction/tool mapping 兼容边界，禁止顺手改协议语义
- tdd: required
- test_design:
  - unit: initialization failure cleanup、crash state、pending reject
  - integration: 现有 fake-codex-app-server 全量测试
  - user_acceptance: 真实 Codex send/tool/approval；运行中杀进程；随后新命令恢复
- done_when:
  - port 内不再直接拥有 generic pending RPC 和裸 spawn 生命周期
  - crash 后 adapter 不保持 ready
- verify:
  - `pnpm --filter @another-workbench/desktop-server test -- codex-app-server-runtime-port`
  - `pnpm smoke:codex`
  - `pnpm smoke:codex:restart`
  - 人工 crash/restart smoke

[x] task_1_6: ACP runtime 迁移到 supervisor
- tag: prod
- goal: 让 fallback runtime 与 Codex 遵循相同生命周期
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要保留 ACP SDK connection、permission request 和 cancel 现有语义
- tdd: required
- test_design:
  - unit: concurrent start、initialize failure、connection close、pending approval cancel
  - integration: fake-pi-acp fixture
  - user_acceptance: 真实 Pi/ACP smoke，执行 cancel 和进程退出
- done_when:
  - 并发首请求不会生成两个进程
  - initialize failure 后没有残留 child
- verify:
  - ACP port tests
  - `pnpm smoke:pi`
  - `pnpm smoke:pi:restart`

[x] task_1_7: 删除 Orchestrator/Adapter 重复 ready 状态
- tag: prod
- goal: runtime 可执行性只由 runtime lifecycle owner 决定
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 依赖前面两个真实 runtime 的迁移结果
- tdd: required
- test_design:
  - unit: adapter initialize single-flight；failed 后重新 initialize
  - integration: orchestrator 多 engine 初始化/切换/dispose
  - user_acceptance: 切换 Codex/Pi 后分别发送真实消息
- done_when:
  - 删除 `readyEngineIds`
  - dispose 顺序明确且在途请求全部 settle
- verify:
  - adapter tests
  - runtime-orchestrator tests
  - Codex/Pi smoke

# Phase 2：Domain 唯一 owner

> 阶段状态：已验收通过（2026-06-25）。

## 阶段目标

删除 SessionManager 双状态，DomainStore snapshot/关系/index 更新原子化。

## 用户可感知结果

create/resume/archive/dispose/hydrate 后 session、participant、relation 和 transcript 状态一致。

## 通过标准

- production 只有一个 ChatSession store。
- snapshot replace 失败不破坏旧状态。
- 派生集合内部只有一个权威索引。
- EventBus listener failure 不阻断其他消费者。

## 验收手段

domain property tests、host integration、cold hydration 和真实 archive/fork/dispose。

## 伪完成风险

- 删除类名但又在 DomainService 新建另一份 session map。
- snapshot tests 只覆盖合法输入，没有验证半途失败保持旧状态。

[x] task_2_1: 删除 SessionManager 和无效 runtime binding
- tag: prod
- goal: 消除 session 双真源
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要沿用审查确认的事实：生产 binding 只有写入，没有读取，不能保留“未来可能用”
- tdd: required
- test_design:
  - unit: DomainService create/get/list/archive/resume/dispose
  - integration: orchestrator create/fork/hydrate 不再依赖 SessionManager
  - user_acceptance: 真实 create→resume→archive→dispose
- done_when:
  - 删除 `packages/core/src/session-manager.ts`
  - 删除 `syncProjectedSessionState()` 和 `bindRuntime()` 调用
  - 若复核发现仍有生产 runtimeId→sessionId 路由读取方，先迁入 EnginePlugin/runtime 层的 `RuntimeSessionBindingRegistry`，禁止重新放回 domain
  - DomainStore 是唯一 session owner
- verify:
  - core/desktop-server tests
  - Codex create/resume/archive smoke

[x] task_2_2: 原子 replaceSnapshot/mergeSnapshot
- tag: prod
- goal: snapshot 失败时保持 live state
- executor: subagent
- subagent_context: no_inherit
- subagent_context_reason: DomainStore staged build 可独立实现
- tdd: required
- test_design:
  - unit: invalid relation/cycle/late parse failure；旧 snapshot 完全不变
  - integration: cold hydration 和 session-window merge
  - user_acceptance: 打开真实历史 session、load older
- done_when:
  - 所有数据先在 staged maps/indexes 完整验证，再 swap
  - 提供 scope-aware merge
- verify:
  - DomainStore tests
  - session-discovery/session-window tests

[x] task_2_3: 索引成为派生集合唯一内部真相
- tag: prod
- goal: 消除实体数组与 store index 双写
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要保持现有 wire DTO 兼容，同时改变内部存储
- tdd: required
- test_design:
  - unit: V1 snapshot load materialize；增删改后 getter/snapshot 数组正确
  - integration: server snapshot 与历史客户端 schema 兼容
  - user_acceptance: 无独立 UI；由 transcript/session graph 整体验收
- done_when:
  - internally stored entity 不保存可从 index 派生的集合
  - public DTO 由 indexes materialize
- verify:
  - core tests
  - shared schema tests
  - desktop-server snapshot tests

[x] task_2_4: EventBus listener 隔离与 publishBatch
- tag: prod
- goal: 一个订阅者失败不产生 partial delivery
- executor: subagent
- subagent_context: no_inherit
- subagent_context_reason: EventBus 行为可独立定义测试
- tdd: required
- test_design:
  - unit: listener A 抛错，B/C 仍收到；onListenerError；batch 顺序
  - integration: renderer subscription + failing diagnostics subscriber
  - user_acceptance: 不需要独立 GUI
- done_when:
  - publish 不因 listener exception 向上抛导致 domain 已改但调用失败
  - batch envelope 顺序稳定
- verify:
  - core event-bus tests
  - runtime-service integration

# Phase 3：共享 DomainReplica

## 阶段目标

Server/renderer 共用 DomainStore/Projector，删除 renderer 第二套领域状态机。

## 用户可感知结果

live/reload/replay/cold-open/load-older 使用同一领域语义。

## 通过标准

- renderer 没有完整 RuntimeEvent switch。
- renderer 没有独立 entities/indexes mutation implementation。
- cursor/hydration/UI 状态仍然与领域状态分离。
- GUI 真实流式和历史加载均通过。

## 验收手段

shared projector tests、renderer sync tests、真实 GUI 连续观察流式输出和 session 切换。

## 伪完成风险

- 只把 renderer switch 移到另一个 desktop 文件。
- RendererStore 直接把 mutable class 塞进 React state，造成更新不可观测。

[x] task_3_1: 建立 DomainReadModel/DomainReplica
- tag: prod
- goal: 提供 browser-safe 的共享领域副本
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要继承 Phase 2 owner 和派生索引决策
- tdd: required
- test_design:
  - unit: apply/applyEnvelope/replace/merge/dispose/read selectors
  - integration: DomainService 改用 replica 后 snapshot 不变
  - user_acceptance: 本任务纳入阶段整体 GUI
- done_when:
  - replica 无 Node-only dependency
  - renderer 接入前通过 browser-entry build/test，确认 shared replica 路径可在浏览器环境打包
  - DomainService 不再分别持有 store/projector
- verify:
  - core tests
  - browser-entry build test
  - desktop-server tests

[x] task_3_2: RendererStore 私有持有 DomainReplica
- tag: prod
- goal: 让 renderer 开始消费 shared replica
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要保持现有 RendererStore API 和 UI 渐进迁移
- tdd: required
- test_design:
  - unit: store revision、subscription、ingest envelope
  - integration: compatibility selectors 与旧结果一致
  - user_acceptance: 打开 demo/真实 host，确认 transcript 初始渲染
- done_when:
  - RendererStore 对外暴露 DomainReadModel
  - React 订阅依赖 revision，不依赖 class identity
- verify:
  - desktop store tests
  - renderer typecheck
  - GUI snapshot/open smoke

[x] task_3_3: 迁移 hydration/window/barrier
- tag: prod
- goal: 保留 renderer-only 同步语义，删除领域 merge 逻辑
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 强依赖现有 lockscreen/backlog/session-window 修复语义
- tdd: required
- test_design:
  - unit: replace/prepend、covered scope delete、cursor barrier、stale envelope
  - integration: remote replay gap→snapshot→subscribe
  - user_acceptance: load older 后滚动位置和消息不重复
- done_when:
  - snapshot entity merge 由 replica 完成
  - reducer 只维护 sync/UI state
- verify:
  - store/replay/session-open tests
  - GUI load older 与 reconnect

[ ] task_3_4: 删除 renderer event projector 与 entity upsert state
- tag: prod
- goal: 彻底消除双投影
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 依赖 compatibility selectors 和 hydration 已迁移
- tdd: required
- test_design:
  - unit: 删除前后所有 event fixture 输出一致
  - integration: message/tool/terminal/approval/interaction lifecycle
  - user_acceptance: 真实 Codex 流式输出逐项观察
- done_when:
  - `renderer/reducer.ts` 不含领域 event switch
  - `state.ts` 大部分删除
- verify:
  - shared/core/desktop tests
  - `pnpm smoke:codex`
  - GUI 流式验收

[ ] task_3_5: legacy snapshot normalization 移到 shared boundary
- tag: prod
- goal: renderer 只接收 canonical snapshot
- executor: subagent
- subagent_context: no_inherit
- subagent_context_reason: 可围绕 snapshot parser/fixtures 独立完成
- tdd: required
- test_design:
  - unit: 双 markdown block 等旧格式迁移
  - integration: old fixture 经 RPC 到 renderer
  - user_acceptance: 打开一条真实旧 rollout/session
- done_when:
  - renderer 无 legacy snapshot format 判断
  - shared parser 输出 canonical snapshot
- verify:
  - shared migration tests
  - cold-session GUI smoke

# Phase 4：EnginePlugin

## 阶段目标

definition、surface、adapter、identity、discovery、capabilities、extensions 由一个 plugin 注册。

## 用户可感知结果

engine capability/action 更稳定；unsupported 明确降级。

## 通过标准

- 每个 engine 只有一个注册入口。
- fake engine 只新增 plugin 即可注册基础路径。
- SmartTakeover 不直连 Codex port。
- capability provider context 不再是 service locator。

## 验收手段

plugin contract suite、Codex/ACP smoke、GUI capability 展示与 unsupported 降级。

## 伪完成风险

- 新增 EnginePlugin，但旧 registries 仍为实际 owner。
- plugin 只是把原来的四个对象再包一层。

[ ] task_4_1: EnginePlugin/Registry 契约
- tag: prod
- goal: 建立单一 engine 注册真相
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需遵守“静态 plugin，不做 marketplace/control plane”的范围
- tdd: required
- test_design:
  - unit: duplicate id、definition/surface mismatch、lookup
  - integration: fake plugin 注册到 orchestrator/shell
  - user_acceptance: CLI 查询 fake/real engine surface
- done_when:
  - registry 可提供 adapter/identity/discovery/capability/extension
- verify:
  - registry tests
  - engine RPC tests

[ ] task_4_2: CodexPlugin 迁移
- tag: prod
- goal: Codex 所有特化能力只有一个 composition 入口
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要保持现有 Codex capability 和 provider identity 全集
- tdd: required
- test_design:
  - unit: plugin surface snapshot
  - integration: discovery/actions/tree/checkpoint/worktree/diagnostics/extensions
  - user_acceptance: GUI 逐项读取 Codex capabilities
- done_when:
  - prod-service 不再逐项注册 Codex provider
  - Codex surface 与迁移前相同
- verify:
  - capability/provider tests
  - Codex smoke
  - GUI capability check

[ ] task_4_3: AcpPlugin 迁移
- tag: prod
- goal: ACP 正式声明支持项和 absence
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需保持 fallback integration tier 和 ACP baseline
- tdd: required
- test_design:
  - unit: surface/absence
  - integration: basic chat/tool/approval
  - user_acceptance: Pi GUI 不显示不支持的 tree/checkpoint 操作
- done_when:
  - ACP 不以空 provider 假装支持
  - 未来 extension 入口清晰
- verify:
  - ACP tests/smoke
  - GUI unsupported check

[ ] task_4_4: 删除重复 registries 并缩小 CapabilityRegistry
- tag: prod
- goal: EnginePlugin 成为唯一 owner
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 依赖两个真实 plugin 已完成
- tdd: required
- test_design:
  - unit: plugin registry 与旧 surface 对比
  - integration: shell/orchestrator/session reconciliation 全部改用 plugin registry
  - user_acceptance: engine 切换和 capability UI
- done_when:
  - 旧 EngineRegistry/Surface/WorkbenchAgentBinding 不再保存独立真相
  - provider context 只注入最小依赖
- verify:
  - desktop-server full tests
  - architecture dependency check
  - Codex/Pi smoke

[ ] task_4_5: SmartTakeover 改用 branch capability
- tag: prod
- goal: 通用 feature 不直连 Codex runtime
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要继承当前 branch-scoped takeover 语义
- tdd: required
- test_design:
  - unit: capability present/absent/current branch
  - integration: Codex plugin 提供 branch context
  - user_acceptance: 当前分支 takeover 不读取其他 branch 输出
- done_when:
  - prod-service 不向 takeover 注入 codexRuntimePort
- verify:
  - smart-takeover tests
  - real branch/takeover smoke

[ ] task_4_6: 拆 Codex runtime/discovery 内部模块
- tag: polish
- goal: 限制 provider protocol 修改影响面
- executor: subagent
- subagent_context: no_inherit
- subagent_context_reason: 可按已稳定的 plugin/runtime 接口机械迁移后独立 review
- tdd: suggested
- test_design:
  - unit: 各 mapper/bridge 现有 fixture
  - integration: Codex port 全量测试
  - user_acceptance: 不需要新增行为；运行 Codex smoke
- done_when:
  - main runtime 文件只负责 command/runtime coordination
  - mapper/approval/interaction/thread registry 不共享可变私有字段
- verify:
  - Codex full tests
  - smoke
  - import cycle check

# Phase 5：RPC contract registry

## 阶段目标

方法 schema 只定义一次，本地和 remote 使用同一 server dispatch。

## 用户可感知结果

local/remote 的错误、校验和结果一致。

## 通过标准

- IPC contract 分域。
- remote 无业务 giant switch。
- typed client 从 contract 派生。
- protocolVersion 正式存在。
- Codex extension contract 不污染 core contract。

## 验收手段

contract parity tests、Electron IPC、remote relay、headless/scheduler smoke。

## 伪完成风险

- 只把 schema 拆文件，仍手写五份 method list。
- generic envelope 使用 unknown 后不做 method-level result validation。

[ ] task_5_1: defineRpcContract 与 envelope
- tag: infra
- goal: 建立单一 contract primitive
- executor: subagent
- subagent_context: no_inherit
- subagent_context_reason: 可用独立示例 contract TDD
- tdd: required
- test_design:
  - unit: params/result parse、method inference、error envelope、version
  - integration: minimal server/client round trip
  - user_acceptance: 不需要
- done_when:
  - method key 自动派生 union
  - client/server 均验证对应 schema
- verify:
  - shared tests
  - type-level compile tests

[ ] task_5_2: 迁移并分域现有 RPC contract
- tag: prod
- goal: 删除 1,800 行手写矩阵
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要保持所有现有 method shape 与兼容策略
- tdd: required
- test_design:
  - unit: 每个 method old fixture parse
  - integration: V1 compatibility parser 到新 contract
  - user_acceptance: 纳入 local/remote 阶段验收
- done_when:
  - `ipc.ts` 成为 barrel/compat layer
  - registry 是唯一 method source
- verify:
  - shared IPC tests
  - architecture parity check

[ ] task_5_3: Host RPC handler registry
- tag: prod
- goal: 删除业务 routing switch
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需接入 WorkbenchHost 和各 feature handler
- tdd: required
- test_design:
  - unit: missing handler、invalid result、error normalization
  - integration: 所有 method handler parity
  - user_acceptance: CLI 调用关键 API
- done_when:
  - handler keys 编译期覆盖 contract
  - server generic invoke/result validation
- verify:
  - desktop-server RPC tests
  - typecheck

[ ] task_5_4: Remote protocol 迁移
- tag: prod
- goal: remote 只负责 transport/session/subscription
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需保持 remote auth、event push、error 行为
- tdd: required
- test_design:
  - unit: version mismatch、transport error、subscription
  - integration: relay server + host client full round trip
  - user_acceptance: remote CLI list/open/send/replay
- done_when:
  - remote-protocol 无业务 method switch
- verify:
  - remote-protocol/remote-server/relay tests
  - remote smoke scripts

[ ] task_5_5: Desktop typed client 迁移
- tag: prod
- goal: transport wrapper 不再复制 params/result 类型
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要保持 event batching/backpressure diagnostics
- tdd: required
- test_design:
  - unit: typed request、method mismatch、error timing
  - integration: Electron preload/router
  - user_acceptance: GUI 全部主要 API
- done_when:
  - feature wrappers 只调用 contract-derived client
  - event batching 仍独立于 RPC request
- verify:
  - desktop transport tests
  - Electron IPC tests
  - GUI smoke

[ ] task_5_6: Codex extension contracts 独立
- tag: prod
- goal: provider-specific schema 不进入 core RPC
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 依赖 CodexPlugin 与 generic RPC primitive
- tdd: required
- test_design:
  - unit: extension params/result validation
  - integration: changed-files/hook-activity/undo
  - user_acceptance: GUI extension panels
- done_when:
  - core contract 只有 extension transport primitive
  - Codex host/renderer 共同使用自己的 contract
  - extension discovery/visibility、local/remote 授权、unsupported/version mismatch 和 result validation error 均有正式错误语义
- verify:
  - extension tests
  - GUI changed-files/hook activity

# Phase 6：Command transaction、ProjectionQueue、Cursor

## 阶段目标

命令幂等、domain batch 原子提交、副作用可重试、cursor 跨重启安全。

## 用户可感知结果

重复请求不重复发送；提交失败明确可见；重连不丢事件；写盘失败可恢复。

## 通过标准

- command receipt cache。
- staged domain event batch。
- user message submission pending/accepted/failed。
- projection queue retry/dedupe/drain。
- atomic JSON write。
- epoch cursor。
- real crash/reconnect/shutdown 验收。

## 伪完成风险

- 只把 `console.warn` 换成日志，没有重试。
- 幂等只在 renderer，remote retry 仍重复。
- cursor 字符串换格式但 renderer 仍私下 regex 比较。

[ ] task_6_1: CommandCoordinator 与幂等 receipt
- tag: prod
- goal: 统一 command 执行策略和重复请求语义
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需继承“不自动重发旧 provider command”和现有 optimistic UX 决策
- tdd: required
- test_design:
  - unit: duplicate commandId、accepted/rejected/failed、cache eviction
  - integration: local IPC 与 remote retry
  - user_acceptance: 双击发送/模拟 retry 只出现一条消息
- done_when:
  - 所有 command 通过 coordinator
  - boolean receipt 替换为正式状态/错误
- verify:
  - command tests
  - remote retry smoke
  - GUI duplicate-send check

[ ] task_6_2: Domain event batch transaction
- tag: prod
- goal: domain mutation 与 envelope publish 的边界明确
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 依赖 DomainReplica 和 EventBus publishBatch
- tdd: required
- test_design:
  - unit: batch 中间 event 失败不改变 live state
  - integration: create session 多 event batch、send submission batch
  - user_acceptance: 由真实命令整体验收
- done_when:
  - staged apply 成功才 swap/publish
- verify:
  - core/domain-service tests
  - injected-failure integration

[ ] task_6_3: 本地消息 submission 状态
- tag: prod
- goal: provider 失败时 local echo 不伪装成功
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要保持现有 transcript 用户体验和 message phase 规范
- tdd: required
- test_design:
  - unit: pending→accepted、pending→failed
  - integration: runtime start failure、provider reject、timeout
  - user_acceptance: 发送失败后文本仍在且显示失败，可再次发送
- done_when:
  - runtime ready 校验后才建立 pending submission
  - failure 有正式 domain 状态
- verify:
  - projector/transcript tests
  - GUI failure flow

[ ] task_6_4: ProjectionQueue
- tag: prod
- goal: index/unread/relation 副作用可重试
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需替换 orchestrator 当前 index pump 且保持现有 unread 语义
- tdd: required
- test_design:
  - unit: dedupe、retry/backoff、drain、permanent failure
  - integration: SessionIndexStore 注入写失败后恢复
  - user_acceptance: 完成 turn 后 unread/status dot 最终正确
- done_when:
  - 删除 orchestrator pending sets/indexSyncPump
  - 可查询最后 projection error
  - v1 只承诺进程生命周期内 retry/drain；跨重启修复依赖 discovery/reconciliation，若要 durable retry 必须显式依赖原子持久化任务
- verify:
  - projection tests
  - injected IO failure
  - GUI status dot

[ ] task_6_5: 原子 JSON persistence
- tag: prod
- goal: 防止 crash 产生半写 JSON
- executor: subagent
- subagent_context: no_inherit
- subagent_context_reason: 文件 persistence helper 可独立实现
- tdd: required
- test_design:
  - unit: temp/rename、旧文件保留、corruption quarantine
  - integration: workspace/session index concurrent writes
  - user_acceptance: 杀进程后重启读取 registry/index
- done_when:
  - `saveJsonFile` 不直接覆盖目标
- verify:
  - persistence tests
  - process-kill smoke

[ ] task_6_6: Epoch cursor
- tag: prod
- goal: 消除 process restart cursor 冲突
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需同步 core、RPC、renderer、remote 的 cursor contract
- tdd: required
- test_design:
  - unit: same epoch compare、different epoch gap、malformed
  - integration: restart 后 old cursor→gap→snapshot
  - user_acceptance: 模拟 host restart 后 GUI 自动恢复完整状态
- done_when:
  - cursor 格式由 shared helper拥有
  - renderer 无私有尾数 regex
- verify:
  - event-bus/store-bridge/remote tests
  - restart reconnect smoke

# Phase 7：Host/Renderer feature 模块

## 阶段目标

按业务 ownership 拆 WorkbenchShell、SmartTakeover、ChatShell、Composer。

## 用户可感知结果

主要行为不变；交互无 stale response，后续 feature 修改路径明显缩短。

## 通过标准

- WorkbenchShell facade 200–300 行。
- ChatShell root 350–500 行。
- feature controller 拥有自己的 async lifecycle。
- SmartTakeover 状态迁移与 cleanup 同 owner。
- GUI 人工验收所有高频路径。

## 验收手段

组件/控制器测试之外，必须由 agent 实际启动 Electron，操作 session、takeover、scheduler、settings、composer。

## 伪完成风险

- 只把 JSX 搬到子文件，state/effects 仍全在 root。
- 只依赖 snapshot tests，没有实际操作 GUI。

[ ] task_7_1: WorkbenchHost feature handlers
- tag: prod
- goal: host facade 不再拥有全部业务 workflow
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 依赖 RPC handler registry 和既有 hydration guard 语义
- tdd: suggested
- test_design:
  - unit: 各 handler 最小依赖与 guards
  - integration: RPC handler 全链
  - user_acceptance: CLI/GUI 主要 API
- done_when:
  - workspace/session/chat/files/scheduler/takeover/diagnostics 分模块
  - facade 只组合
- verify:
  - shell/RPC tests
  - smoke

[ ] task_7_2: SmartTakeover 状态机与 coordinator
- tag: prod
- goal: 状态、迁移、pending resolver、cleanup 由同一 owner 闭环
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需保持当前 branch scope、goal conflict、manual preset 语义
- tdd: required
- test_design:
  - unit: 全状态迁移、timeout、cancel、verdict race
  - integration: parent/takeover sessions 与 command coordinator
  - user_acceptance: GUI enable/disable/verdict/interrupt
- done_when:
  - prompt/output selection 与状态机分离
  - run cleanup 不再散落多个 maps
- verify:
  - takeover tests
  - real GUI takeover flow

[ ] task_7_3: ChatShell feature slices
- tag: prod
- goal: 顶层只做布局和组合
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要继承现有 active session、backlog、takeover、settings 交互语义
- tdd: suggested
- test_design:
  - unit: feature controller model
  - integration: store/transport/controller
  - user_acceptance: Electron 实际操作全部 feature
- done_when:
  - session-browser/transcript/takeover/scheduler/engine-settings 各自拥有 state/effects
  - root 不直接调用这些 feature 的 RPC
- verify:
  - component/controller tests
  - Electron GUI checklist

[ ] task_7_4: Composer controller 分解
- tag: prod
- goal: draft/intent/submit/suggestions/queue 可独立修改测试
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要遵守现有 in-flight send/queue/steer 用户语义
- tdd: required
- test_design:
  - unit: intent reducer、draft、queue flush、suggestions
  - integration: command coordinator + active session switch
  - user_acceptance: send/steer/queue/stop、切 session draft
- done_when:
  - aggregate hook 只组合子控制器
- verify:
  - composer tests
  - Electron composer flow

[ ] task_7_5: 统一 latest-request/cancel helper
- tag: infra
- goal: 消除各 feature 手写 request counter/ref
- executor: subagent
- subagent_context: no_inherit
- subagent_context_reason: 可独立实现通用 async gate
- tdd: required
- test_design:
  - unit: stale resolve/reject、unmount cancel、newest wins
  - integration: takeover preset/session open
  - user_acceptance: 快速切 session 不闪回旧数据
- done_when:
  - 主要 feature 不再各自手写 generation counter
- verify:
  - helper tests
  - rapid session switching GUI test

# Phase 8：清理与结构约束

## 阶段目标

删除新旧双路径，安装依赖规则，清理仓库生成物。

## 用户可感知结果

无功能变化；正式版本体积和开发体验改善。

## 通过标准

- 无旧 projector/registries/RPC switch/replay array adapter。
- metadata identity fallback 只在 migration。
- architecture rules 基于 AST/import graph。
- dist/release/tsbuildinfo/sub-lockfiles 不作为源码追踪。
- 最终所有真实验收通过。

[ ] task_8_1: 删除 legacy compatibility
- tag: polish
- goal: 达到稳定态 LOC 和唯一 owner
- executor: subagent
- subagent_context: inherit
- subagent_context_reason: 需要确认所有新路径与兼容期限已完成
- tdd: suggested
- test_design:
  - unit: 当前 canonical contract
  - integration: 无旧路径 import/call
  - user_acceptance: 完整最终 smoke
- done_when:
  - legacy code 搜索为零或仅显式 migration
- verify:
  - rg/static guard
  - full tests/smokes

[ ] task_8_2: 结构性 dependency rules
- tag: infra
- goal: 防止架构回退
- executor: subagent
- subagent_context: no_inherit
- subagent_context_reason: 可依据目标 dependency graph 独立配置
- tdd: suggested
- test_design:
  - unit: 违规 fixture 触发检查
  - integration: root lint/CI
  - user_acceptance: 不需要
- done_when:
  - renderer UI 不 import server
  - generic host 不 import Codex implementation
  - package cycles 被检测
- verify:
  - lint/dependency check
  - intentional violation fixture

[ ] task_8_3: 仓库卫生
- tag: infra
- goal: 移除构建产物和多 lockfile 噪声
- executor: subagent
- subagent_context: no_inherit
- subagent_context_reason: 文件追踪策略可独立处理
- tdd: not_needed
- test_design:
  - unit: 不需要
  - integration: clean checkout 可 build/package
  - user_acceptance: 安装、构建、启动正式包
- done_when:
  - 生成物由 CI/release pipeline 产出
  - root 单一 pnpm lockfile
- verify:
  - clean clone install/build/package smoke
  - `git status` clean

# 总依赖关系

```makefile
task_0_1:
task_0_2: task_0_1

task_1_1: task_0_2
task_1_2: task_1_1
task_1_3: task_1_2
task_1_4: task_1_1 task_1_2 task_1_3
task_1_5: task_1_1 task_1_2
task_1_6: task_1_4 task_1_5

task_2_1: task_1_6
task_2_2: task_0_1
task_2_3: task_2_2
task_2_4: task_0_1

task_3_1: task_2_1 task_2_2 task_2_3
task_3_2: task_3_1
task_3_3: task_3_2
task_3_4: task_3_3
task_3_5: task_3_2

task_4_1: task_1_6 task_3_1
task_4_2: task_4_1
task_4_3: task_4_1
task_4_4: task_4_2 task_4_3
task_4_5: task_4_2 task_4_4
task_4_6: task_4_2 task_1_4

task_5_1: task_0_1
task_5_2: task_5_1
task_5_3: task_5_2 task_4_4
task_5_4: task_5_3
task_5_5: task_5_2 task_3_4
task_5_6: task_4_2 task_5_1 task_5_3 task_5_5

task_6_1: task_1_6 task_3_1
task_6_2: task_2_4 task_3_1
task_6_3: task_6_1 task_6_2
task_6_4: task_6_2
task_6_5: task_0_1
task_6_6: task_5_2 task_6_2

task_7_1: task_5_3
task_7_2: task_4_5 task_6_1
task_7_3: task_3_4 task_5_5
task_7_4: task_6_3 task_7_3
task_7_5: task_7_3

task_8_1: task_4_4 task_5_6 task_6_6 task_7_4
task_8_2: task_8_1
task_8_3: task_8_1
```

# 最终验收矩阵

- Runtime lifecycle：task_1_1–task_1_7
- Domain 单一 owner：task_2_1–task_2_4
- Server/renderer 单投影：task_3_1–task_3_5
- Engine 单一注册：task_4_1–task_4_6
- RPC 单一 contract：task_5_1–task_5_6
- Command 原子/幂等/恢复：task_6_1–task_6_6
- Host/GUI 可维护性：task_7_1–task_7_5
- 稳定态清理：task_8_1–task_8_3

# 强制阶段 Gate

每个 Phase 结束后：

0. phase-entry audit：复跑 LOC 脚本，复核本阶段涉及的 owner、调用方和文件位置，必要时先更新阶段说明。
1. review：由独立 reviewer 检查是否真正改变 owner/依赖方向，而非只拆文件。
2. test：运行阶段 unit/integration/full regression。
3. user acceptance：涉及 runtime/GUI 的阶段必须真实运行，不接受 mock-only。
4. failure：发现问题必须回到修复，再重新执行 Gate。
5. complete：只有 reviewer 输出 complete，才进入下一阶段。
