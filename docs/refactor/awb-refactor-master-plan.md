# Another Workbench 架构重构总施工计划

> 基线：当前 `another-workbench` 工作树（包含尚未提交的 `06-24-awb-architecture-invariants` 修复）。
>
> 代码量口径：稳定口径由 `scripts/count-production-loc.mjs` 定义。计划中的 LOC 预测默认使用 `productCodeTsTsxGo` 口径：`apps/` 与 `packages/` 下的 TS/TSX/CTS/MTS/Go 手写生产代码，排除 tests、fixtures、生成的 Codex 类型、声明文件和构建产物。2026-06-25 Phase 0 closure 基线为 **52,638 行**；脚本同时输出包含 CSS/JS 的更宽口径，便于审查口径差异。

## 0. 最终结论

这次重构不应做成一次大重写，也不应只做“大文件拆分”。推荐路线是：

1. 先闭合 runtime 进程生命周期。
2. 再消除 session/domain 双真源。
3. 让 renderer 直接复用 host 的 `DomainStore + DomainProjector`。
4. 将 engine 的四套注册信息收敛为一个静态 `EnginePlugin`。
5. 用单一 RPC contract registry 替代手写 request/response/switch 矩阵。
6. 建立 command transaction、幂等和可重试副作用队列。
7. 最后按业务 feature 拆 host facade 和 React 顶层组件。
8. 删除兼容层并安装结构性依赖规则。

稳定态预计为 **47,700–50,200 行生产代码**，即从当前减少约 **5%–10%**。若兼容层长期保留，最终更接近 50,000 行；若迁移结束后彻底删除 V1 兼容和旧 facade，可接近 48,000 行。迁移中间态会因为新旧路径并存，短暂升至约 **55,000–57,500 行**。

测试代码不计入上述数字；预计测试会增加约 8,000–15,000 行，这是必要增长。

---

# 1. 目标架构

```text
Electron Renderer
  ├─ feature controllers / views
  ├─ RendererStore
  │    ├─ shared DomainReplica
  │    └─ renderer-only sync/UI state
  └─ typed RPC client + event subscription
          │
Electron Main / Headless Host
  ├─ RPC handler registry
  ├─ WorkbenchHost facade
  ├─ CommandCoordinator
  ├─ shared DomainReplica
  ├─ ProjectionQueue
  ├─ EnginePluginRegistry
  │    ├─ CodexPlugin
  │    └─ AcpPlugin
  ├─ Runtime lifecycle infrastructure
  │    ├─ LifecycleGate
  │    ├─ ChildProcessSupervisor
  │    └─ JsonRpcLineClient
  └─ file-backed catalog/settings persistence

Optional remote relay
  └─ only forwards versioned RPC/event envelopes
```

## 权威所有者

| 概念 | 重构后的唯一 owner |
|---|---|
| Session/Turn/Message/Tool 等领域事实 | `DomainReplica` |
| Runtime 启停、崩溃和在途请求 | runtime supervisor / runtime client |
| Engine 定义、adapter、capability、discovery | `EnginePluginRegistry` |
| Provider-native identity | engine plugin 的 identity codec / resolver |
| RPC 方法、参数、结果 schema | RPC contract registry |
| Cursor 格式和比较语义 | shared event-stream contract |
| Session index、unread、workspace selection 等副作用 | `ProjectionQueue` 中的独立 projection |
| React 本地交互状态 | 对应 feature controller |

---

# 2. 为什么不是继续沿用现有方式

## 2.1 Runtime 生命周期

当前：

- `RuntimeBackedAdapter` 自己持有 lifecycle state。
- `RuntimeOrchestrator` 又有 `readyEngineIds`。
- Codex port 和 ACP port 各自管理 child process。
- Codex JSON-RPC pending request 没有 timeout/abort，`stop()` 直接 clear pending map。
- ACP 与 Codex 的并发 start 语义不同。

这使“是否还能执行命令”没有唯一 owner。

目标不是再补几个 `if (starting)`，而是把 single-flight start、stop、crash、timeout、abort、reject-all pending 和 kill escalation 放进专门基础设施。

## 2.2 Domain 状态

当前 `DomainService` 同时持有 `SessionManager`、`DomainStore`、`DomainProjector`，并通过 `syncProjectedSessionState()` 手工同步。生产代码中 `SessionManager` 的 runtime binding 只有写入，没有任何读取方，属于无效状态。

目标是删除 `SessionManager`，只让 `DomainReplica` 持有 session 领域事实。

## 2.3 Server/Renderer 双投影

当前 `packages/core/src/domain-projector.ts` 与 `apps/desktop/src/store/reducer.ts` 分别实现一遍 RuntimeEvent 语义。conformance test 能发现漂移，但不能消除漂移。

目标是 renderer 与 server 使用同一个 `DomainReplica`；renderer 只保留 cursor、hydration barrier、event dedupe、active selection、refresh signal 等同步/UI 状态。

## 2.4 Engine 注册

当前同一个 engine 的定义散落在：

- `EngineRegistryService`
- `EngineCapabilitySurfaceService`
- `WorkbenchAgentBinding`
- `CapabilityRegistry`
- `prod-service.ts`

`RuntimeOrchestrator.registerAgentBinding()` 目前还会丢掉 `integrationTier`、`transportKind`、`sharedCapabilities`、`extensions` 字段。

目标是每个 engine 只导出一个 `EnginePlugin` 对象。

## 2.5 RPC

当前一个 RPC 方法需要出现在 method list、request schema、request union、response schema、response union、remote switch、transport wrapper 等多个位置。

目标是一个 contract registry 派生 parser、类型、client 和 server dispatch。不是引入大型代码生成平台；普通 TypeScript generic registry 足够。

## 2.6 Persistence

本次主重构不建议直接引入 SQLite/event sourcing。当前 transcript 的耐久真相主要仍在 provider，AWB 能通过 discovery/hydration 重建；立即再保存一份完整 transcript 会制造新的双真源和迁移成本。

本计划只做：

- 原子文件写入；
- command transaction；
- event batch commit；
- 可重试 projection queue；
- epoch cursor；
- snapshot fallback。

当产品明确要求“无 provider 也能完整离线读取历史”或“跨 host restart 精确 replay”时，再单独立项 SQLite。

---

# 3. 阶段与 PR 计划

## Phase 0：冻结当前基线并修明确错误

### 阶段目标

将当前未提交的 architecture-invariants 工作独立收口，建立后续重构可依赖的真实基线。

### 用户可感知结果

没有新功能；reload/replay/provider identity 等刚修复的行为不会在后续重构中再次回退。

### 通过标准

- 当前 architecture-invariants 阶段的验收项全部真实通过。
- 该任务单独提交，不与 runtime supervisor 等结构性改动混在一起。
- `registerAgentBinding()` 字段丢失被立即修复。
- 记录当前生产代码量、关键文件大小和真实 smoke 结果。

### 伪完成风险

- 文档写着 Gate accepted，但没有在当前工作树重新跑命令。
- 把现有 1,800 行 diff 与下一阶段混成一个不可 review 的提交。

### task_0_1：收口当前 architecture-invariants 工作

- tag: infra
- executor: subagent
- subagent_context: inherit
- tdd: not_needed
- 主要位置：
  - 当前所有 modified/untracked 文件
- 做法：
  - 对照本节“通过标准”逐项验收。
  - 重新执行 shared/core/desktop-server/desktop tests、typecheck、lint、architecture guard、Codex smoke。
  - 验收通过后形成独立提交。
- done_when：
  - 工作树中现有架构修复形成一个可独立 revert 的 commit。
- 预期生产 LOC：以当前工作树为基线，**0**。

### task_0_2：修复 binding 字段丢失

- tag: prod
- executor: subagent
- subagent_context: no_inherit
- tdd: required
- 当前位置：
  - `apps/desktop-server/src/runtime-orchestrator.ts:90-126`
  - `apps/desktop-server/src/runtime-types.ts:53-63`
- 做法：
  - `registerEngine()` 与 `registerAgentBinding()` 暂时完整保留所有 binding 字段。
  - 添加测试断言 `getEngineCapabilities()` 返回 `sharedCapabilities`，并验证 extension/tier/transport 不丢失。
  - 后续 Phase 4 会删除这套 binding，但当前 bug 不能等待。
- 为什么不是等 EnginePlugin：
  - 后续阶段可能持续数个 PR，当前 production 行为不应保持错误。
- 预期生产 LOC：**+10–25**。

### Phase 0 依赖

```makefile
task_0_1:
task_0_2: task_0_1
```

---

## Phase 1：统一 Runtime 生命周期

### 阶段目标

所有 engine 都遵循同一个生命周期、超时、取消和崩溃恢复契约。

### 用户可感知结果

- executable 缺失时立即返回明确错误，不挂死。
- runtime 崩溃后不会继续显示“ready”。
- 退出应用时没有永久 pending Promise 或孤儿进程。
- 下一次用户命令可安全触发重新启动，但不会自动重发可能产生副作用的旧命令。

### 通过标准

- 并发首请求只启动一个进程。
- start 失败后状态回到 failed/stopped，可重试。
- stop/crash 会 reject 所有 pending request。
- 每个 request 都支持 timeout 和 AbortSignal。
- Codex/ACP 真实 smoke 都通过。
- 人工杀掉 runtime 进程后 UI 获得明确错误，随后新命令能恢复。

### 目标接口

```ts
export type RuntimeLifecycleState =
  | "stopped"
  | "starting"
  | "ready"
  | "stopping"
  | "failed";

export interface AdapterRuntimePort<Request, Response, Event> {
  getState(): RuntimeLifecycleState;
  start(options?: { signal?: AbortSignal }): Promise<void>;
  stop(options?: { reason?: string; timeoutMs?: number }): Promise<void>;
  request(
    payload: Request,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<Response>;
  subscribe(listener: (event: Event) => void): () => void;
  subscribeState(listener: (state: RuntimeLifecycleState) => void): () => void;
}
```

### task_1_1：定义 runtime lifecycle 与错误契约

- tag: infra
- executor: subagent
- subagent_context: inherit
- tdd: required
- 新增/修改：
  - `packages/adapters` runtime port contract
  - `apps/desktop-server/src/runtime/runtime-lifecycle.ts`
  - shared runtime error typing where needed
- 做法：
  - 固定 `RuntimeLifecycleState`、request timeout、AbortSignal、process-exited、aborted、timeout 等错误分类。
  - 明确 crash 后不自动重发旧 provider command，只允许新 command 触发 restart。
  - 所有 runtime port、adapter、orchestrator 后续任务都只消费此契约，不再各自发明状态。
- 预期生产 LOC：**+40–80**。

### task_1_2：实现 LifecycleGate

- tag: infra
- executor: subagent
- subagent_context: no_inherit
- tdd: required
- 新文件：
  - `apps/desktop-server/src/runtime/lifecycle-gate.ts`
- 做法：
  - 缓存 `startPromise` 和 `stopPromise`。
  - start 并发调用共享同一个 Promise。
  - start 失败后清理 promise，允许重试。
  - stop 等待 start settle，再进入 stopping。
- 预期生产 LOC：**+90–130**。

### task_1_3：实现 ChildProcessSupervisor

- tag: infra
- executor: subagent
- subagent_context: no_inherit
- tdd: required
- 新文件：
  - `apps/desktop-server/src/runtime/child-process-supervisor.ts`
  - `apps/desktop-server/src/runtime/runtime-process-error.ts`
- 做法：
  - 等待 `spawn`，监听 `error` 与 `exit`。
  - 维护唯一 process generation，忽略旧 generation 的 late events。
  - stop 先正常 kill，超时后升级强制终止。
  - 提供 `onExit`、stderr event 和 process health。
- 预期生产 LOC：**+240–330**。

### task_1_4：实现 JsonRpcLineClient

- tag: infra
- executor: subagent
- subagent_context: no_inherit
- tdd: required
- 新文件：
  - `apps/desktop-server/src/runtime/json-rpc-line-client.ts`
- 做法：
  - 统一 request id、pending map、timeout、AbortSignal。
  - write 失败立即删除 pending 并 reject。
  - process exit/stop 执行 `rejectAll()`.
  - 处理 stdin backpressure。
  - 区分 protocol error、timeout、aborted、process-exited。
- 预期生产 LOC：**+220–300**。

### task_1_5：迁移 Codex runtime

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 当前位置：
  - `apps/desktop-server/src/codex-app-server-runtime-port.ts:816-949`
  - `apps/desktop-server/src/codex-app-server-runtime-port.ts:3095-3114`
- 做法：
  - 删除 port 内直接 `spawn`、`pendingRpcById`、裸 `write()`。
  - 使用 ChildProcessSupervisor + JsonRpcLineClient。
  - initialize 任一步失败都 stop 当前 generation。
  - crash 后 adapter state 改为 failed。
  - 不自动重发 command；下一条新命令可以触发 restart。
- 预期该区域：**-250–400**，新基础设施已在前两项计入。

### task_1_6：迁移 ACP runtime

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 当前位置：
  - `apps/desktop-server/src/pi-acp-runtime-port.ts:304-419`
- 做法：
  - 用 LifecycleGate/ChildProcessSupervisor 消除并发双启动。
  - initialize 失败后关闭 child 和 connection。
  - connection closed 与 child exit 合并为同一 generation 的 terminal state。
  - pending approval 在 stop/crash 时正式 resolve/cancel。
- 预期该区域：**-80–150**。

### task_1_7：删除上层重复 ready 状态

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 当前位置：
  - `packages/adapters/src/runtime-backed-adapter.ts:121-181`
  - `apps/desktop-server/src/runtime-orchestrator.ts:48-67, 544-566`
- 做法：
  - adapter 的 lifecycle 直接反映 runtime port。
  - 删除 `RuntimeOrchestrator.readyEngineIds`。
  - `ensureAdapterReady()` 只调用 adapter single-flight initialize。
  - dispose 顺序：停止接收新命令 → 取消在途命令 → unsubscribe → stop runtime。
- 预期生产 LOC：**-50–100**。

### Phase 1 净 LOC

**+220–430**。这是 lifecycle/error contract 与可靠性基础设施的净增加，属于值得增加的代码。这是可靠性基础设施的净增加，属于值得增加的代码。

### Phase 1 依赖

```makefile
task_1_1:
task_1_2: task_1_1
task_1_3: task_1_1
task_1_4: task_1_3
task_1_5: task_1_1 task_1_2 task_1_3 task_1_4
task_1_6: task_1_1 task_1_2 task_1_3
task_1_7: task_1_5 task_1_6
```

---

## Phase 2：收敛 Domain 状态所有权

### 阶段目标

删除 SessionManager 双状态；DomainStore 的 snapshot 与关系索引变成原子、一致的唯一事实。

### 用户可感知结果

创建、恢复、归档、dispose、cold hydration 后得到完全一致的 session/participant/relation 状态。

### 通过标准

- production 中只剩一个 session entity store。
- `replaceSnapshot()` 失败不改变旧状态。
- 公共 DomainStore API 无法生成实体和索引互相矛盾的 snapshot。
- EventBus 某个 listener 抛错不会阻断其他 listener。
- dispose、archive、hydrate 均通过真实 host 流程。

### task_2_1：删除 SessionManager

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 删除：
  - `packages/core/src/session-manager.ts`
- 修改：
  - `apps/desktop-server/src/domain-service.ts`
  - `apps/desktop-server/src/runtime-orchestrator.ts`
  - `packages/core/src/index.ts`
- 具体做法：
  - `DomainService.list/get/requireSession()` 直接读 DomainStore。
  - session id factory 移到 DomainService/application command 层。
  - 删除 `syncProjectedSessionState()`。
  - 删除 `bindRuntime()` 及 RuntimeOrchestrator 中所有只写不读的 binding 调用。
  - 若未来确实需要 runtime route，放进 EnginePlugin/runtime 层的 `RuntimeSessionBindingRegistry`，而不是重新放回 domain。进入本任务前先用 `rg "getRuntimeBinding|resolveRuntimeRoute|getRunningSessionIds|bindRuntime" apps packages -g "*.ts"` 复核生产读取方。
- 为什么这样做：
  - 当前 runtime binding 在生产代码只有写入，没有读取。
  - 保留它只会继续制造“以后可能有用”的假状态。
- 预期生产 LOC：**-260–360**。

### task_2_2：DomainStore 原子 snapshot replace

- tag: prod
- executor: subagent
- subagent_context: no_inherit
- tdd: required
- 当前位置：
  - `packages/core/src/domain-store.ts:275-313`
- 做法：
  - `DomainStore.fromSnapshot()` 在临时 maps/indexes 中完整 parse、build、validate。
  - 所有 relation 验证完成后一次性 swap。
  - 不允许先 clear 当前 store。
  - 添加 `mergeSnapshot(scope)`，供 session-window hydration 使用。
- 预期生产 LOC：**+70–130**。

### task_2_3：让索引成为派生集合的唯一内部真相

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 当前重复字段：
  - `Conversation.sessionIds`
  - `Conversation.participantEngineIds`
  - `Turn.messageIds/toolCallIds/terminalIds/approvalRequestIds/interactionRequestIds`
  - `AgentParticipant.activeSessionIds`
  - DomainStore 内对应 indexes
- 做法：
  - wire DTO 保持兼容，不立即改变 RPC。
  - DomainStore 内部存储类型去掉上述派生数组。
  - V1 snapshot load 时以 DTO 数组初始化有序索引。
  - getters/getSnapshot 时从索引 materialize DTO。
  - 每种关系只允许一个 mutation helper 修改。
- 为什么不直接改 shared schema：
  - 先消除内部双真源，又不同时制造协议迁移风险。
  - 后续确认无旧客户端后再考虑 Snapshot V2。
- 预期生产 LOC：**-80–180**。

### task_2_4：EventBus listener 隔离

- tag: prod
- executor: subagent
- subagent_context: no_inherit
- tdd: required
- 当前位置：
  - `packages/core/src/event-bus.ts:197-220`
- 做法：
  - append envelope 后，对每个 listener 独立 try/catch。
  - 增加 `onListenerError` 诊断回调。
  - 一个 renderer/remote listener 失败不能阻止其他 listener。
  - 增加 `publishBatch()`，为 Phase 6 的原子 event batch 做准备。
- 预期生产 LOC：**+35–70**。

### Phase 2 净 LOC

**-220–380**。

### Phase 2 依赖

```makefile
task_2_1:
task_2_2:
task_2_3: task_2_2
task_2_4:
```

---

## Phase 3：共享 DomainReplica，删除 renderer 双投影

### 阶段目标

Server 与 renderer 使用同一套 DomainStore/DomainProjector；renderer 不再实现第二份领域状态机。

### 用户可感知结果

live、reload、replay、cold open、load older 的 transcript 与 session graph 不再依赖两套实现碰巧一致。

### 通过标准

- `apps/desktop/src/store/reducer.ts` 不再包含完整 RuntimeEvent switch。
- renderer 不再维护一份独立 `entities + indexes` 实现。
- DomainStore/DomainReplica 可在 browser 环境运行，无 Node-only 依赖；这是进入 renderer 迁移前的硬门槛。
- session-window replace/prepend、cursor barrier、dedupe 仍正确。
- 真正 GUI 验收覆盖流式 message、tool、terminal、approval、interaction、runtime error、load older。

### 目标接口

```ts
export class DomainReplica {
  readonly read: DomainReadModel;

  replaceSnapshot(snapshot: DomainSnapshot): void;
  mergeSnapshot(snapshot: DomainSnapshot, scope?: SnapshotScope): void;
  apply(event: RuntimeEvent, occurredAt?: string): void;
  applyEnvelope(envelope: EventEnvelope): void;
  disposeSession(sessionId: string): void;
  getSnapshot(): DomainSnapshot;
}
```

Renderer store：

```ts
type RendererSyncState = {
  domainRevision: number;
  eventStream: EventStreamState;
  refreshSignals: RendererRefreshSignals;
  activeConversationId?: string;
  activeSessionId?: string;
  lastError?: RuntimeErrorSummary;
};
```

`DomainReplica` 本身保存在 RendererStore 私有字段中；React 订阅看到的是 revision 和 UI/sync state，不把 class instance塞进 React state。

### task_3_1：封装 DomainReplica

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 新增：
  - `packages/core/src/domain-replica.ts`
  - `packages/core/src/domain-read-model.ts`
- 修改：
  - `DomainService` 使用 replica，而不是分别管理 store/projector。
- phase-entry hard gate：
  - 在 renderer 接入前运行 browser-entry build/test，确认 `packages/core` 的 replica 路径没有 Node-only import。
- 预期生产 LOC：**+120–220**，同时 DomainService 可减少约 **80–140**。

### task_3_2：RendererStore 接入 shared replica

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 修改：
  - `apps/desktop/src/store/store.ts`
  - `apps/desktop/src/store/types.ts`
  - `apps/desktop/src/store/selectors.ts`
  - `apps/desktop/src/ui/chat-shell/use-renderer-store-state.ts`
- 做法：
  - RendererStore 私有持有 DomainReplica。
  - `ingestEnvelope()` 调用 shared projector。
  - selectors 改为通过 DomainReadModel 查询。
  - 暂时提供 compatibility snapshot，允许 UI 分批迁移。
- 预期生产 LOC：**+180–300**。

### task_3_3：迁移 hydration/window/barrier

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 当前位置：
  - `apps/desktop/src/store/reducer.ts:350-803`
  - `apps/desktop/src/store/reducer.ts:1526-1825`
- 做法：
  - 保留 renderer-only：
    - event id dedupe
    - cursor/watermark barrier
    - session-window coverage
    - active selection
    - refresh signals
  - snapshot entity merge、dispose cascade 改调用 DomainReplica。
- 预期该文件减少：**-650–900**。

### task_3_4：删除 renderer RuntimeEvent projector

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 当前位置：
  - `apps/desktop/src/store/reducer.ts:804-1524`
  - `apps/desktop/src/store/state.ts`
- 做法：
  - 删除 renderer event switch、upsert entity/index helpers。
  - 删除大部分 `state.ts`。
  - conformance tests 收敛为 shared projector tests + renderer sync tests。
- 预期生产 LOC：**-900–1,250**。

### task_3_5：迁移 legacy normalization 到边界

- tag: prod
- executor: subagent
- subagent_context: no_inherit
- tdd: required
- 当前位置：
  - `apps/desktop/src/store/reducer.ts:462-529`
- 做法：
  - 老 snapshot 的双 markdown block 合并放到 shared snapshot parser/migrator。
  - renderer reducer 不再认识历史格式。
- 预期生产 LOC：**-40–90**。

### Phase 3 净 LOC

**-1,200–1,800**。

### Phase 3 依赖

```makefile
task_3_1: task_2_1 task_2_2 task_2_3
task_3_2: task_3_1
task_3_3: task_3_2
task_3_4: task_3_3
task_3_5: task_3_2
```

---

## Phase 4：收敛为 EnginePlugin

### 阶段目标

每个 engine 只在一个 plugin 对象中声明 definition、surface、adapter、identity、discovery、capabilities 和 extensions。

### 用户可感知结果

不同 engine 的 capability 展示和动作稳定一致；新增 engine 不再要求修改通用 transcript/store。

### 通过标准

- Codex 与 ACP 各只有一个注册入口。
- `EngineRegistryService`、`EngineCapabilitySurfaceService`、`WorkbenchAgentBinding` 不再分别保存同一信息。
- CapabilityRegistry 不再持有完整 service locator context。
- 新增一个 fake engine 的 contract test，只新增 plugin 文件即可跑通基础 chat 注册。

### 目标接口

```ts
export interface EnginePlugin {
  definition: EngineDefinitionRpc;
  surface: EngineSurfaceRpc;
  adapter: AgentAdapter;
  identity?: ProviderIdentityResolver;
  discovery?: SessionDiscoveryProvider;
  capabilities: AgentWorkbenchCapabilities;
  extensions: EngineExtensionRegistration[];
}
```

### task_4_1：建立 EnginePluginRegistry

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 新增：
  - `apps/desktop-server/src/engines/engine-plugin.ts`
  - `apps/desktop-server/src/engines/engine-plugin-registry.ts`
- 做法：
  - 注册时验证 engineId 唯一、surface/definition 一致。
  - registry 提供 adapter、capability、identity、discovery 查询。
- 预期生产 LOC：**+180–280**。

### task_4_2：CodexPlugin

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 新目录：
  - `apps/desktop-server/src/engines/codex/`
- 移入：
  - runtime construction
  - identity codec
  - session discovery
  - chat tree/checkpoint/worktree/diagnostics/session actions providers
  - changed-files/hook-activity extension registration
- `prod-service.ts` 不再逐项拼装 Codex。
- 预期生产 LOC：移动为主；去重后 **-150–300**。

### task_4_3：AcpPlugin

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 新目录：
  - `apps/desktop-server/src/engines/acp/`
- 做法：
  - 明确基础能力和 absence。
  - 不用空 provider 假装支持高级能力。
  - future ACP extension 只能从 plugin 加入。
- 预期生产 LOC：**+40–100**。

### task_4_4：删除四套 registry 重复

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 修改/删除：
  - `engine-control/engine-registry.ts`
  - `engine-control/capability-surface.ts`
  - `runtime-types.ts` 中 `WorkbenchAgentBinding`
  - 大幅缩小 `capability-registry.ts`
  - 大幅缩小 `prod-service.ts`
- Capability provider 获得最小 context：
  - domain read model
  - provider handle
  - workspace info
  - runtime access for its own engine
- 不再把 RuntimeService、SessionIndexStore、IdentityRegistry 全部作为 service locator 传入。
- 预期生产 LOC：**-500–800**。


- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 当前位置：
  - `apps/desktop-server/src/prod-service.ts:257-265`
- 做法：
  - 在 `ConversationGraphCapability` 增加最小的 current-branch query，或新增内部 `BranchContextCapability`。
- 预期生产 LOC：**-20–60**。

### task_4_6：拆分 provider-heavy 大文件，但不做纯搬运

- tag: polish
- executor: subagent
- subagent_context: no_inherit
- tdd: suggested
- `codex-app-server-runtime-port.ts` 目标：
  - `codex-runtime.ts`：生命周期与命令入口
  - `codex-event-mapper.ts`：notification/item → runtime event
  - `codex-approval-bridge.ts`
  - `codex-interaction-bridge.ts`
  - `codex-thread-registry.ts`
- `session-discovery.ts` 目标：
  - generic reconciler
  - Codex scan
  - Codex hydrate mapper
  - timestamp/relation helpers
- 要求：
  - 每个模块有明确输入输出；禁止只按行号切文件后互相 import 私有状态。
- 区域净 LOC：**-150–350**。

### Phase 4 净 LOC

**-350–700**。

### Phase 4 依赖

```makefile
task_4_1: task_1_7 task_3_1
task_4_2: task_4_1
task_4_3: task_4_1
task_4_4: task_4_2 task_4_3
task_4_5: task_4_2 task_4_4
task_4_6: task_4_2 task_1_5
```

---

## Phase 5：单一 RPC contract registry

### 阶段目标

一个 RPC 方法只定义一次；本地 IPC、remote relay、typed client 和 handler 使用同一 contract。

### 用户可感知结果

本地和 remote 行为不再因路由实现不同而漂移，协议错误能返回方法级校验信息。

### 通过标准

- `packages/shared/src/ipc.ts` 不再是 1,800 行单文件矩阵。
- `remote-protocol.ts` 不再有 50+ case switch。
- generic client 自动取得 params/result 类型。
- request params 和 result 都按 method schema 校验。
- Electron local、remote relay 和 headless 调用均通过。
- 协议 envelope 带 `protocolVersion`。

### 目标 contract

```ts
export const rpcContract = defineRpcContract({
  "engine.list": rpc({
    params: z.object({}),
    result: z.object({ engines: z.array(zEngineDefinitionRpcSchema) })
  }),
  "domain.snapshot": rpc({
    params: z.object({}),
    result: zSnapshotResult
  })
});
```

统一 response envelope：

```ts
type RpcResponseEnvelope =
  | { id: string; method: string; ok: true; result: unknown }
  | { id: string; method: string; ok: false; error: RpcError };
```

方法具体 result 由 contract 在 client/server 两端校验，不再为每个方法手写完整 response object schema。

### task_5_1：实现 defineRpcContract

- tag: infra
- executor: subagent
- subagent_context: no_inherit
- tdd: required
- 新增：
  - `packages/shared/src/rpc/contract.ts`
  - `packages/shared/src/rpc/envelope.ts`
- 预期生产 LOC：**+180–260**。

### task_5_2：按领域拆 contract

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 新目录：
  - `packages/shared/src/rpc/contracts/engine.ts`
  - `settings.ts`
  - `sessions.ts`
  - `chat.ts`
  - `files.ts`
  - `events.ts`
- `ipc.ts` 变成小型 barrel/compat export。
- 预期生产 LOC：当前 1,797 行收敛为区域总计 **650–850 行**，净 **-950–1,150**。

### task_5_3：建立 host handler registry

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 新增：
  - `apps/desktop-server/src/rpc/rpc-server.ts`
  - `apps/desktop-server/src/rpc/create-workbench-handlers.ts`
- 做法：
  - handler map 的 key 必须覆盖 contract。
  - generic server 完成 parse、invoke、result validate、error normalization。
  - events subscribe/unsubscribe 作为 transport session adapter，不混入业务 handler。
- 预期生产 LOC：**+220–320**。

### task_5_4：替换 remote giant switch

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 当前位置：
  - `apps/desktop-server/src/remote-protocol.ts:44-837`
- 做法：
  - remote protocol 只负责 auth/session/subscription/envelope forwarding。
  - 业务调用交给 rpc server。
- 预期生产 LOC：**-500–650**。

### task_5_5：简化 desktop transport

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 当前已有：
  - `apps/desktop/src/transport/transport-rpc-helper.ts`
- 做法：
  - 让 helper 直接消费 contract 类型。
  - 删除 desktop-transport 中重复的 input/result type 和 method response narrowing。
  - feature API wrapper 可以保留，但只是一行 typed call。
- 预期生产 LOC：**-300–500**。

### task_5_6：Engine extension contract 隔离

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 新包建议：
  - `packages/engine-codex-contracts`
- 做法：
  - changed-files/hook-activity 的 schema 不再写进 core RPC 文件。
  - core 提供 `engineExtension.call` transport primitive。
  - Codex renderer extension 与 Codex host plugin共同导入自己的 contract。
- 为什么不直接使用 `unknown`：
  - generic transport 可以 unknown，但 extension 边界必须立即用自己的 Zod schema验证。
- 必补 contract 语义：
  - extension discovery/visibility；
  - local 与 remote 的调用授权；
  - unsupported/version mismatch 的统一错误分类；
  - extension result schema validation 失败时的 recoverability。
- 预期生产 LOC：**+100–180**，同时 core contract 继续减少。

### Phase 5 净 LOC

**-900–1,400**。

### Phase 5 依赖

```makefile
task_5_1:
task_5_2: task_5_1
task_5_3: task_5_1 task_5_2
task_5_4: task_5_3
task_5_5: task_5_2
task_5_6: task_4_2 task_5_1 task_5_3 task_5_5
```

---

## Phase 6：Command transaction、幂等、副作用与 Cursor

### 阶段目标

消除“领域状态已经变了，但 provider/发布/持久化失败”的 partial commit；让重连和副作用失败可恢复。

### 用户可感知结果

- 重复点击/remote retry 不会重复发送同一消息。
- provider 初始化或提交失败时，本地消息有明确 failed 状态，不会假装成功。
- index/unread 写盘失败会重试并可诊断。
- host restart 后旧 cursor 必定触发 snapshot，不会与新进程同号 cursor 混淆。

### 通过标准

- commandId 有 bounded idempotency receipt cache。
- 一组领域事件先在 staged replica 应用成功，再一次性 commit/publish。
- send/steer 的 pending/accepted/failed 状态明确。
- ProjectionQueue 支持 dedupe、retry、drain、shutdown。
- `saveJsonFile()` 使用 temp + rename。
- cursor 带 epoch，renderer 不再自行猜 opaque cursor 的数字尾部。
- remote reconnect、runtime crash、write failure、app shutdown 全部有集成测试。

### task_6_1：CommandCoordinator 与 receipt 模型

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 新增：
  - `apps/desktop-server/src/application/command-coordinator.ts`
  - `apps/desktop-server/src/application/command-receipt-store.ts`
- receipt：
  - `accepted`
  - `rejected`
  - `failed`
  - error code/retryable
- 相同 commandId 重试返回同一 receipt。
- 预期生产 LOC：**+220–330**。

### task_6_2：原子 domain event batch

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 修改：
  - `DomainReplica.commit(events)`
  - `DomainService.commitRuntimeEvents(events)`
  - `RuntimeEventBus.publishBatch()`
- 做法：
  - 在 staged replica 完整 apply。
  - 失败不改变 live replica。
  - 成功后 swap，再发布 envelopes。
- 预期生产 LOC：**+100–170**。

### task_6_3：正式建模本地消息提交状态

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 方案：
  - 给本地 user message 增加兼容可选 `submissionStatus: pending|accepted|failed`，历史/provider消息默认 accepted。
  - runtime ready 验证通过后再 commit pending local echo。
  - provider result 决定 accepted/failed。
  - rejected 不删除用户文本。
- 替代当前：
  - 先完整 commit local user turn，再调用 adapter，异常时只尝试回 session idle。
- 预期生产 LOC：**+120–220**。

### task_6_4：ProjectionQueue

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 新增：
  - `apps/desktop-server/src/application/projection-queue.ts`
- 接管：
  - session index sync
  - relation sync
  - unread
  - 可选 workspace recent selection
- 功能：
  - eventId/dedupe key
  - retry/backoff
  - 最后错误诊断
  - shutdown drain
- 持久化语义：
  - ProjectionQueue v1 只承诺进程生命周期内 retry/drain；
  - app restart 后依靠 discovery/reconciliation 修复派生状态；
  - 若要跨重启继续 retry，必须显式依赖 task_6_5 的持久队列存储，不在本任务中暗中承诺。
- 删除 RuntimeOrchestrator 中：
  - `pendingSessionIndexSyncIds`
  - `pendingRelationSyncs`
  - `indexSyncPump`
  - ad-hoc drain loop
- 预期净 LOC：**+20–100**。

### task_6_5：原子 JSON persistence

- tag: prod
- executor: subagent
- subagent_context: no_inherit
- tdd: required
- 当前位置：
  - `apps/desktop-server/src/persistence-store.ts`
  - `WorkspaceRegistryService`
  - `SessionIndexStore`
- 做法：
  - write temp file
  - fsync/close（平台允许时）
  - rename replace
  - 保留 last-known-good backup 或 corruption quarantine
- 预期生产 LOC：**+50–100**。

### task_6_6：Epoch cursor

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 新增：
  - `packages/shared/src/event-cursor.ts`
- 格式：
  - `{epoch}:{sequence}`
- 规则：
  - 不同 epoch 不可比较，replay 返回 gap。
  - 同 epoch 用 sequence 比较。
  - 所有比较集中在 shared helper。
  - 删除 renderer `splitComparableCursor()` 私有猜测。
- 预期生产 LOC：**+30–80**，renderer 可删除约 **30–50**。

### Phase 6 净 LOC

**+180–450**。

### Phase 6 依赖

```makefile
task_6_1: task_1_7 task_3_1
task_6_2: task_2_4 task_3_1
task_6_3: task_6_1 task_6_2
task_6_4: task_6_2
task_6_5:
task_6_6: task_5_2 task_6_2
```

---

## Phase 7：按业务 feature 拆 Host 与 Renderer

### 阶段目标

把巨型 facade/component 中的 workflow 放回所属业务 feature；不改变产品功能。

### 用户可感知结果


### 通过标准

- `ChatShellApp.tsx` 只负责布局和 feature 组合，目标 350–500 行。
- `WorkbenchShellService` 只作为 facade/composition，目标 200–300 行。
- 每个 feature controller 自己处理 request generation、cancel/stale response。
- 不引入 Redux/React Query 作为“重构本身”；现有 custom event-store 足够。
- GUI 人工验收覆盖所有高频路径。

### task_7_1：拆 WorkbenchHost handler modules

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: suggested
- 当前：
  - `apps/desktop-server/src/workbench-shell-service.ts` 约 1,279 行
- 目标模块：
  - `features/workspaces/handlers.ts`
  - `features/sessions/handlers.ts`
  - `features/chat/handlers.ts`
  - `features/files/handlers.ts`
  - `features/diagnostics/handlers.ts`
- 不是简单搬方法：
  - 每个 handler 只注入需要的 service。
  - hydration guard 作为 session command middleware。
- 区域净 LOC：**-100–+50**。


- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 当前：
- 目标：
- 状态迁移、pending resolver 和 cleanup 由 state machine/coordinator 闭环。
- 区域净 LOC：**-100–+50**。

### task_7_3：拆 ChatShellApp

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: suggested
- 当前：
  - `ChatShellApp.tsx` 约 3,409 行
- 目标：
  - `app/ChatWorkbench.tsx`
  - `features/session-browser/`
  - `features/transcript/`
  - `features/engine-settings/`
- 每个 feature 暴露 controller model + view。
- 目标不是追求更小文件，而是顶层不再拥有各 feature 的异步 workflow。
- 区域净 LOC：**-100–+200**。

### task_7_4：拆 composer controller

- tag: prod
- executor: subagent
- subagent_context: inherit
- tdd: required
- 当前：
  - `use-composer-controller.ts` 约 1,232 行
- 目标：
  - `composer-intent.ts`
  - `use-composer-draft.ts`
  - `use-composer-submit.ts`
  - `use-composer-suggestions.ts`
  - `use-composer-queue.ts`
  - 小型 aggregate controller
- 纯 intent/reducer 逻辑必须 TDD。
- 区域净 LOC：**-80–+120**。

### task_7_5：统一 async request generation

- tag: infra
- executor: subagent
- subagent_context: no_inherit
- tdd: required
- 新增 renderer helper：
  - `createLatestRequestGate()` 或 `useLatestRequest()`
- 预期生产 LOC：**-30–100**。

### Phase 7 净 LOC

**-50–+250**。

### Phase 7 依赖

```makefile
task_7_1: task_5_3
task_7_2: task_4_5 task_6_1
task_7_3: task_3_4 task_5_5
task_7_4: task_6_3 task_7_3
task_7_5: task_7_3
```

---

## Phase 8：删除兼容层与安装结构性约束

### 阶段目标

完成新路线收口，防止旧模式重新出现。

### 通过标准

- 删除旧 SessionManager、旧 renderer projector、旧 RPC unions/switch、旧 binding registries。
- 删除 replay array compatibility adapter。
- metadata identity fallback 只保留在显式 migration。
- architecture checks 基于依赖/AST，不再只靠字符串正则。
- build/release/tsbuildinfo 不作为源代码跟踪。
- 根仓库只保留一个 pnpm lockfile。
- 最终 full tests、Codex/ACP smoke、remote relay smoke 和 GUI user acceptance 全部通过。

### task_8_1：删除 legacy adapters

- tag: polish
- executor: subagent
- subagent_context: inherit
- tdd: suggested
- 删除：
  - replay 返回数组的兼容形态
  - renderer legacy projector
  - old engine registries
  - old RPC exports
  - 已无调用的 provider metadata fallback
- 预期生产 LOC：**-250–500**。

### task_8_2：结构性依赖规则

- tag: infra
- executor: subagent
- subagent_context: no_inherit
- tdd: suggested
- 规则：
  - renderer UI 不 import desktop-server。
  - core/shared 不 import apps。
  - generic engine host 不 import Codex implementation。
  - capability providers 不绕过 identity/plugin registry。
  - contract registry 与 handler registry method parity。
  - 检测 package cycles。
- 可使用 ESLint boundaries/dependency-cruiser，或 TypeScript AST 脚本；不继续扩大正则 allowlist。
- 生产 LOC：约 **0**，infra script 不计。

### task_8_3：仓库卫生

- tag: infra
- executor: subagent
- subagent_context: no_inherit
- tdd: not_needed
- 处理：
  - `dist-web`
  - `dist-electron`
  - `release`
  - `*.tsbuildinfo`
  - 子包 `pnpm-lock.yaml`
- 若 release artifact 确需留存，迁移到 release pipeline，不放源仓库。
- 生产 LOC：**0**，但仓库体积明显下降。

### Phase 8 净 LOC

**-200–550**。

---

# 4. 关键文件重构后的代码量预估

这里的“目标”是该业务区域全部文件之和；拆成多个文件不代表总量自动减少。

| 当前区域 | 当前 LOC | 稳定态目标 | 净变化 | 说明 |
|---|---:|---:|---:|---|
| `codex-app-server-runtime-port.ts` 区域 | 3,135 | 2,400–2,750 | -385–735 | 通用 process/RPC 生命周期移出，事件映射仍然是实质复杂度 |
| `pi-acp-runtime-port.ts` 区域 | 1,028 | 850–950 | -78–178 | 复用 supervisor，ACP SDK mapping 保留 |
| `runtime-orchestrator.ts` | 756 | 400–500 | -256–356 | 删除 ready set、index pump、plugin 拼装 |
| `domain-service.ts` | 600 | 300–380 | -220–300 | 删除 SessionManager 和同步逻辑 |
| `session-manager.ts` | 227 | 0 | -227 | 当前生产 binding 只有写无读 |
| `domain-store.ts` | 1,165 | 900–1,050 | -115–265 | 增加 staged replace，但去掉内部双真源 |
| `domain-projector.ts` | 984 | 850–1,000 | -134–+16 | 投影规则本身是真实复杂度，不强求缩短 |
| renderer `reducer.ts + state.ts` | 2,217 | 550–800 | -1,417–1,667 | 复用 DomainReplica 后只留同步/UI 状态 |
| `packages/shared/src/ipc.ts` 区域 | 1,797 | 650–850 | -947–1,147 | contract registry + 分域文件 |
| `remote-protocol.ts` | 838 | 200–300 | -538–638 | 删除业务 switch |
| `desktop-transport.ts` | 1,288 | 750–900 | -388–538 | 复用 contract-derived client |
| `capability-registry.ts` | 666 | 200–300 | -366–466 | EnginePlugin 成为配置真相 |
| `prod-service.ts` | 390 | 140–200 | -190–250 | 只做 composition |
| `workbench-shell-service.ts` 区域 | 1,279 | 1,100–1,300 | -179–+21 | 主要收益是依赖边界，不是 LOC |
| `session-discovery.ts` 区域 | 1,602 | 1,450–1,600 | -152–0 | provider mapping 是真实复杂度 |
| `ChatShellApp.tsx` 区域 | 3,409 | 3,300–3,600 | -109–+191 | 顶层文件会大减，区域总量基本持平 |
| `use-composer-controller.ts` 区域 | 1,232 | 1,150–1,350 | -82–+118 | 拆为可测试 controller |

---

# 5. 总 LOC 预测

| 阶段 | 净生产 LOC |
|---|---:|
| Phase 0 | +10–40 |
| Phase 1 Runtime lifecycle | +220–430 |
| Phase 2 Domain owner | -220–380 |
| Phase 3 Shared DomainReplica | -1,200–1,800 |
| Phase 4 EnginePlugin | -350–700 |
| Phase 5 RPC registry | -900–1,400 |
| Phase 6 Transaction/persistence/cursor | +180–450 |
| Phase 7 Feature modules | -50–+250 |
| Phase 8 Cleanup | -200–550 |
| **总计** | **-2,550–5,040** |

从当前约 52,783 行出发：

- 保守稳定态：约 **50,200 行**
- 期望稳定态：约 **48,800–49,500 行**
- 激进清理态：约 **47,700 行**
- 迁移峰值：约 **55,000–57,500 行**

因此这不是“靠重构把代码砍半”的项目。真正收益是：

- 修改路径从 6–10 个文件缩到 1–3 个 feature/plugin 文件；
- runtime 状态、session 状态、engine 配置、RPC schema 各有唯一 owner；
- server/renderer 不再维护两份领域状态机；
- 失败、重试、重连和退出行为可被明确推理。

---

# 6. 不应在同一个 PR 中混合的事项

1. Runtime supervisor 与 shared projector 不要同 PR。
2. DomainStore owner 收敛与 RPC schema 重写不要同 PR。
3. EnginePlugin 迁移完成前，不删除旧 capability facade。
4. RPC registry 的 contract 与 server handler先双跑，再迁 desktop client。
5. ChatShell 拆分必须等 renderer store 和 transport 稳定。
6. 不在本轮顺手引入 SQLite、Redux、React Query、动态 plugin marketplace。
7. 不以“大文件变小”作为完成标准，必须验证依赖方向与 owner 是否改变。

---

# 6.5 Phase-entry audit

每个 Phase 开始前，先做一次轻量审计，避免计划与当前代码漂移：

1. 运行 `node scripts/count-production-loc.mjs`，记录当前 LOC 口径。
2. 复核本 Phase 直接涉及的 owner 和调用方，优先用 `rg` 查生产代码读取/写入路径。
3. 对照本计划中的主要文件位置，若行号或所有权已变化，先更新该 Phase 的实施说明再动代码。
4. 记录审计结果到对应阶段日志；该记录只描述当前事实，不替代真实验收。

---

# 7. 真实验收矩阵

每个 Phase gate 至少覆盖相应路径，最终全部覆盖：

| 验收路径 | 必须覆盖 |
|---|---|
| Codex create/send/stream/final | message、tool、terminal、approval、interaction |
| ACP create/send/cancel | runtime start/stop、permission、crash |
| Runtime executable 不存在 | 立即失败、无孤儿 pending |
| Runtime 中途 crash | pending reject、状态 failed、新命令可恢复 |
| Cold session open | discovery、identity、full hydration |
| Load older | prepend/replace、cursor barrier、不重复实体 |
| Snapshot/replay gap | 强制 snapshot fallback |
| Archive/fork/dispose | domain、index、relations 一致 |
| Remote relay | 同一 contract、错误码、subscription |

---

# 8. 风险与回滚

## Runtime supervisor

风险：双启动或旧 generation late exit 清掉新进程状态。  
措施：generation token；每个事件检查 generation。  
回滚：保留旧 port lifecycle adapter 一个 PR 周期。

## DomainReplica

风险：session-window merge 误删未覆盖实体。  
措施：明确 `SnapshotScope`，只删除 scope 声明覆盖的对象。  
回滚：renderer compatibility materialization 保留到 GUI gate 通过。

## EnginePlugin

风险：迁移时 capability 丢失。  
措施：对现有 Codex/ACP surface 做完整 snapshot contract test。  
回滚：registry adapter 从旧配置生成 plugin，短期双读但不双写。

## RPC registry

风险：local 与 remote 在迁移期间协议版本错配。  
措施：envelope `protocolVersion`，server 显式拒绝不支持版本。  
回滚：保留 V1 parser/client adapter 一个发布周期。

## Command transaction

风险：改变 local echo 时序。  
措施：先引入 pending submission 状态，保持消息立即可见；真实 GUI 验收。  
回滚：command policy 可对单一 command 回到旧 optimistic 策略，不回滚整个 domain。

---

# 9. 推荐执行节奏

建议每个 PR 控制在约 300–800 行生产 diff；provider mapping 搬迁例外，但必须机械移动和语义修改分开。

推荐顺序：

```text
0.1 当前 invariants 收口
0.2 binding bug
1.1 lifecycle/error contract
1.2 lifecycle gate
1.3 process supervisor
1.4 JSON-RPC client
1.5 Codex migration
1.6 ACP migration
1.7 orchestrator lifecycle cleanup
2.1 delete SessionManager
2.2 atomic DomainStore
2.3 derived collection ownership
2.4 listener isolation
3.1 DomainReplica
3.2 renderer compatibility adapter
3.3 hydration/window migration
3.4 delete renderer projector
4.1 EnginePlugin registry
4.2 CodexPlugin
4.3 AcpPlugin
4.4 collapse registries
5.1 RPC contract primitive
5.2 contract migration
5.3 handler registry
5.4 remote migration
5.5 desktop client migration
5.6 extension contracts
6.1 command coordinator
6.2 event batch transaction
6.3 submission status
6.4 projection queue
6.5 atomic persistence
6.6 epoch cursor
7.1 host feature handlers
7.3 ChatShell features
7.4 composer controllers
8.1 legacy deletion
8.2 dependency guards
8.3 repo hygiene
```

整个计划不要求所有后续阶段一开始就写死内部实现细节，但每一项已经明确了：

- 当前 owner 和问题；
- 目标 owner；
- 主要改动文件；
- 具体迁移方法；
- 为什么不继续旧路线；
- TDD 与验收方式；
- 预期生产 LOC 增减；
- 依赖与回滚边界。
