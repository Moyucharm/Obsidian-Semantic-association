# 开发问题记录
记录开发过程中遇到的实际问题、根因分析和解决方式。
---

## #001 Obsidian 中索引失败
**日期**：2026-03-08

**现象**：在 Obsidian 中实际使用插件时，执行索引后提示“索引失败，请查看控制台”。
**根因分析**：
经代码审查定位到两个核心问题。
### 问题 A：indexAll 无单文件容错
`ReindexService.indexAll()` 中逐文件调用 `indexFile()`，但没有 try-catch 包裹。任意一个文件索引失败（如 API 调用异常）都会导致整个 `indexAll()` 抛异常，中断后续文件索引。
```ts
// 修复前：一个文件失败，全量中断
for (let i = 0; i < files.length; i++) {
    await this.indexFile(files[i]); // 这里抛异常就全完
}
```

### 问题 B：Store 没有持久化
`NoteStore`、`ChunkStore`、`VectorStore` 都有 `load()`/`serialize()` 方法，但 `main.ts` 从未调用它们。每次 Obsidian 启动：
1. 三个 Store 都是空的 `new` 实例。
2. `onLayoutReady()` 中 `noteStore.size === 0` 必然为 true。
3. 每次启动都触发全量 `rebuildIndex()`。
4. 如果 embedding API 有任何问题，全量索引必然失败。

**解决方式**：
1. `indexAll()` 增加单文件 try-catch，失败记录到 ErrorLogger，继续下一个文件。
2. `indexAll()` 返回 `IndexSummary { total, failed }` 供 UI 展示部分失败。
3. 新增 `ErrorLogger` 服务，持久化错误到 `error-log.json`。
4. 引入索引快照加载/保存，避免每次启动全量重建。

**涉及文件**：
- `src/indexing/reindex-service.ts` — 单文件容错 + ErrorLogger 注入
- `src/utils/error-logger.ts` — 新建
- `src/types.ts` — 新增 `IndexErrorEntry`、`IndexSummary`
- `src/main.ts` — 初始化 ErrorLogger，更新 rebuildIndex 和索引快照逻辑

**状态**：已修复。
---

## #002 错误日志清理策略选择
**日期**：2026-03-08

**现象**：最初采用纯“30 天定期删除”方案，但存在缺陷。
**问题分析**：
- 如果 Embedding 配置异常导致 1000 个文件全都失败，30 天内日志会暴增到几千条。
- 如果用户长期没有错误，每次启动的清理检查都是浪费。

**解决方式**：改为“容量上限 + 时间过期”双重控制。
| 机制 | 参数 | 作用 |
|------|------|------|
| 容量上限 | MAX_ENTRIES = 500 | 每次 `log()` 时检查，超出则截断最旧条目。实时保护，防暴增。 |
| 时间过期 | 30 天 | 启动时懒清理，删除过期条目。周期性清理旧数据。 |

**涉及文件**：
- `src/utils/error-logger.ts` — `log()` 中增加容量截断逻辑

**状态**：已修复。
---

## #010 本地模型测试报错 + 缓存隔离与清理命令
**日期**：2026-03-08

**现象**：测试本地模型时报错 “Cannot read properties of undefined (reading 'create')”。
**根因分析**：
- Transformers.js 在 Electron/Node 环境下会优先选择 `onnxruntime-node`。
- Obsidian 插件环境缺少该原生模块，导致创建 ONNX session 时对象为空。

**解决方式**：
1. 在导入 `@huggingface/transformers` 前，清理 ORT symbol 并伪装 `process.release.name`，强制 Transformers.js 走 onnxruntime-web/WASM 后端。
2. 版本化本地模型缓存目录，避免 Transformers.js 升级后新旧模型文件混用：`models/cache-v{LOCAL_MODEL_CACHE_VERSION}-tf{TRANSFORMERS_JS_VERSION}`。
3. 新增命令“清理旧本地模型缓存”，清除 `models/` 下除当前缓存外的旧目录文件。

**涉及文件**：
- `src/embeddings/local-provider.ts` — 环境强制 Web/WASM
- `src/embeddings/embedding-service.ts` — 版本化缓存路径
- `src/main.ts` — 新增清理缓存命令

**验证步骤**：
1. 设置中选择本地模型，点击“测试本地模型”，应能正常加载/推理。
2. 首次重建索引会下载模型文件，后续应从缓存加载。
3. 执行命令“清理旧本地模型缓存”，确认仅保留当前版本缓存目录。
---

## #011 本地模型报错 Unsupported device: 'cpu'
**日期**：2026-03-08

**现象**：点击“测试本地模型”时报错：`Unsupported device: 'cpu'. Should be one of: ...`。
**根因分析**：
- 先前通过 ORT symbol 注入 onnxruntime-web，触发 Transformers.js 的 ORT 分支，但该分支不会填充 `supportedDevices`。
- 默认 `device=cpu` 时校验失败，抛出 Unsupported device 异常。

**解决方式**：
1. 导入 Transformers.js 前清理 ORT symbol，并临时伪装 `process.release.name` 让其识别为 Web 环境，从而走 onnxruntime-web + wasm 后端。
2. pipeline 显式设置 `device: "wasm"`，避免默认落到 cpu。

**涉及文件**：
- `src/embeddings/local-provider.ts` — `importTransformersWebBackend()` + `device: "wasm"`
---

## #012 新对话快速定位信息
**日期**：2026-03-08

**现象**：用户希望在新对话中快速让助手定位问题。
**建议**：优先提供以下文件，能最快建立上下文并定位问题。
1. `docs/TROUBLESHOOTING.md`
2. `src/embeddings/local-provider.ts`
3. `src/embeddings/embedding-service.ts`
4. `src/main.ts`
5. `src/settings.ts`
6. `src/views/connections-view.ts`
7. `esbuild.config.mjs`
8. `package.json`

**涉及文件**：
- `docs/TROUBLESHOOTING.md` — 本条记录新增
---

## #013 本地模型报错 `[wasm] Failed to resolve module specifier 'worker_threads'`
**日期**：2026-03-08

**现象**：设置页点击“测试本地模型”或执行本地索引时，报错：
`no available backend found. ERR: [wasm] TypeError: Failed to resolve module specifier 'worker_threads'`

**根因分析**：
1. `onnxruntime-web` 在模块初始化阶段误判当前环境为 Node。
2. 误走到依赖 `worker_threads` 的路径。
3. Obsidian/Electron 渲染上下文中该路径不可用，导致本地模型初始化失败。

**解决方式**：
1. 导入 `@huggingface/transformers` 前，临时隐藏 `globalThis.process`，强制 ORT 按 Web/WASM 路径初始化。
2. 初始化后恢复原始 `process`，避免影响其他逻辑。
3. 设置页新增本地模型下载状态区，直观显示下载进度、成功或失败状态。
4. 设置页新增“清理缓存并重下”按钮，便于当前缓存损坏时一键恢复。

**涉及文件**：
- `src/embeddings/local-provider.ts` — 强制 Web/WASM 导入路径
- `src/embeddings/embedding-service.ts` — 暴露当前 provider 释放能力
- `src/settings.ts` — 下载状态 UI + “清理缓存并重下”按钮
- `styles.css` — 下载状态样式

**状态**：已修复。
---

## #014 本地模型缓存升级后的清理策略
**日期**：2026-03-08

**现象**：代码多次更新后，旧版本模型缓存不会自动删除；仅依赖手动清理命令不够稳妥。

**根因分析**：
1. 缓存目录虽然已经版本化，但旧目录不会自动清理。
2. 早期清理逻辑删除范围偏大，存在误删 `models/` 根目录其他文件的风险。

**解决方式**：
1. 缓存目录统一使用 `cache-v{LOCAL_MODEL_CACHE_VERSION}-tf{TRANSFORMERS_JS_VERSION}`。
2. 插件启动时静默清理 `models/` 下所有非当前版本的 `cache-v*` 目录。
3. 手动命令“清理旧本地模型缓存”保留，但删除范围收紧为仅处理旧版缓存目录。
4. 额外增加“清理当前模型缓存并重新下载”的设置页按钮，处理当前版本缓存损坏场景。

**涉及文件**：
- `src/embeddings/embedding-service.ts` — 版本化缓存目录
- `src/main.ts` — 启动时静默清理 + 手动清理旧缓存 + 清理当前缓存
- `src/settings.ts` — 当前缓存清理并重下入口

**状态**：已修复。
---

## #015 运行时一致性与数据校验问题
**日期**：2026-03-08

**现象**：代码审查发现多处“不会立刻崩，但会悄悄产生错误结果”的问题。

**问题分析**：

### 问题 A：重命名任务会被后续修改覆盖
`ReindexQueue` 原先只按 `task.path` 去重。若发生 `a.md -> b.md`，随后又收到 `modify(b.md)`，则旧的 `rename` 任务会被覆盖，`oldPath = a.md` 的迁移信息丢失，可能留下旧索引残留。

### 问题 B：视图异步结果会串台
- `ConnectionsView` 在快速切换笔记时，慢请求可能覆盖新笔记结果。
- `LookupView` 在连续输入搜索词时，早发起的慢请求可能覆盖后发起的新请求结果。

### 问题 C：向量维度缺少严格校验
`VectorStore` 原先只记录首个向量维度，但后续写入和快照恢复时不严格校验。维度不一致时会静默返回错误相似度。

### 问题 D：快照加载失败后可能留下脏状态
索引快照恢复异常时，若部分 store 已加载成功、部分失败，可能残留不一致数据。

**解决方式**：
1. `ReindexQueue` 改为：普通任务按 `path` 去重，`rename` 使用独立任务键保留迁移信息。
2. 两个视图都增加请求序号校验，过期异步结果直接丢弃。
3. `VectorStore` 在加载、写入、查询前都进行向量维度和数值合法性校验。
4. 快照恢复失败时同步清空 `noteStore`、`chunkStore`、`vectorStore`，避免脏状态。

**涉及文件**：
- `src/indexing/reindex-queue.ts`
- `src/views/connections-view.ts`
- `src/views/lookup-view.ts`
- `src/storage/vector-store.ts`
- `src/main.ts`

**状态**：已修复。
---

## #016 本地模型点击加载仍然失败时的剩余可能原因
**日期**：2026-03-09

**现象**：在 `worker_threads` / `cpu device` / 旧缓存清理等问题已修复后，点击“下载”“清理缓存并重下”或“测试本地模型”仍然失败。

**排查结论**：此时通常不是同一类根因重复出现，而是落在以下剩余故障面：

### 问题 A：Obsidian 仍在运行旧构建产物
如果控制台里仍出现旧错误文本，例如：
- `Failed to resolve module specifier 'worker_threads'`
- `Unsupported device: 'cpu'`

优先怀疑插件没有重载到最新 `dist/main.js`，而不是新逻辑本身失效。

### 问题 B：首次模型下载失败
本地模型首次加载依赖从 HuggingFace 拉取模型文件。若网络、代理、证书、DNS 或访问策略有问题，常见报错包括：
- `fetch failed`
- `network`
- `timeout`
- `403 / 404`

### 问题 C：当前缓存损坏或下载中断
如果上次下载没有完整完成，缓存目录中可能残留半截文件。此时通常表现为：
- 反复初始化失败
- 文件缺失
- ONNX / 模型格式异常

应优先尝试设置页的“清理缓存并重下”。

### 问题 D：缓存目录写入失败
模型缓存写入路径位于：
`{vault}/.obsidian/plugins/semantic-connections/models/`

若被杀毒软件、同步盘、权限策略或文件占用影响，常见报错包括：
- `EPERM`
- `EACCES`
- `ENOENT`

### 问题 E：WASM / ONNX Runtime 初始化失败
如果模型文件已经下载完成，但在加载阶段失败，常见原因是 Electron 运行时中的 WASM 初始化异常。典型表现：
- `no available backend found`
- `wasm init failed`
- ORT backend 初始化错误

### 问题 F：模型与量化文件不匹配
并不是所有模型仓库都稳定提供每一种 `q4 / q8 / fp16 / fp32` 变体。若当前量化文件不存在或不兼容，常见表现为：
- 某个 dtype 可用，另一个 dtype 不可用
- 404 / file not found

### 问题 G：内存或磁盘不足
大模型或高精度量化（尤其 `fp16` / `fp32`）更容易触发：
- `out of memory`
- 下载后加载崩溃
- Electron 渲染进程卡死

### 问题 H：模型能加载，但索引状态不兼容
这类问题不一定发生在“下载阶段”，但用户体感会像“模型还是不能用”。典型表现：
- `dimension mismatch`
- 索引快照不兼容
- 需要重建索引

此时应重建索引，而不是继续重复下载模型。

**建议优先收集的信息**：
1. 设置页显示的失败文案
2. Obsidian 开发者控制台完整堆栈
3. `error-log.json` 最新一条记录
4. 当前缓存目录是否存在下载到一半的模型文件

**涉及文件**：
- `README.md` — 增加本地模型失败的高频原因说明
- `docs/TROUBLESHOOTING.md` — 本条记录新增

**状态**：已记录。
---

## #017 本地模型下载按钮进度瞬间完成 + 页面卡顿
**日期**：2026-03-09

**现象**：
- 点击“下载”后，进度条很快跑满或接近跑满
- 用户体感像“实际上并没有下载”
- 点击期间设置页会出现明显卡顿，甚至短时间无响应

**根因分析**：

### 问题 A：下载按钮复用了 `testConnection()`
原先设置页的“下载”按钮并不是单纯执行下载，而是直接调用：
`EmbeddingService.testConnection()`

而 `testConnection()` 内部会进一步调用：
`provider.embed("connection test")`

这意味着按钮一次性做了三件事：
1. 下载缺失模型文件
2. 初始化本地推理会话
3. 额外执行一次真实测试推理

这会把“下载”和“测试推理”两个语义混在一起，也会额外放大设置页阻塞感。

### 问题 B：把单文件 `done` 误当成整体完成
Transformers.js 的进度回调里，`done` 表示“当前文件处理完成”，不是“整套模型已经就绪”。

旧逻辑把这个状态直接映射成“模型下载完成”，于是会出现：
- 进度条过早冲满
- 文案提前显示完成
- 用户误以为后续没有真正下载/加载动作

### 问题 C：首次初始化和预热会拖住页面线程
问题不只在“下载按钮链路错误”。即使把“下载”和“测试推理”拆开，如果本地模型的 WASM 初始化、ONNX Session 创建和首轮预热推理仍放在设置页所在线程执行，页面还是会卡。

**当前修复**：
1. 为本地模型新增 `prepareLocalModel()` / `LocalProvider.prepare()`，把“下载/初始化”和“测试推理”拆开。
2. 设置页“下载”按钮改为只调用 prepare 链路，不再额外执行一次 `embed("connection test")`。
3. 下载状态改为区分：
   - `done`：单个文件完成
   - `ready`：模型文件已加载，开始初始化会话
   - `warmup`：开始预热本地推理
   - `success`：最终就绪
4. 设置页进度条只会在真正进入 `download` / `progress` / `done` 阶段后推进；`initiate`、`ready`、`warmup` 只更新文案，不再把进度条提前推到 90%+。
5. 新增下载链路运行日志：`local-model-download-requested`、`local-model-download-started`、`local-model-download-first-byte`、`local-model-download-ready`、`local-model-download-warmup`，方便区分“按钮已点”“下载已建立”“初始化/预热仍在进行”。
6. 设置页“下载”改为使用独立的临时 `LocalProvider` / 独立 worker，不再复用 `EmbeddingService` 当前共享 provider，也不再在下载前调用 `switchProvider()` 去打断现有运行时。
7. 共享 provider 的下载/加载进度监听改成订阅式，避免设置页下载和重建索引互相覆盖监听器。
8. 初始化失败时重置半初始化状态，避免后续重试落入脏状态。
9. 本地模型运行时迁移到独立的 `worker_threads` / Web Worker 后台线程，主线程只保留 UI 和请求代理。

**worker 方案已如何落地**：
- `src/embeddings/local-provider.ts`：主线程代理，负责启动 worker、转发请求、接收进度和结果
- `src/embeddings/local-runtime.ts`：承载真正的 Transformers.js / ONNX 初始化与推理逻辑
- `src/workers/local-model-worker.ts`：worker 入口，串行处理 `configure` / `prepare` / `embed` / `embedBatch` / `dispose`
- `esbuild.config.mjs`：额外产出 `local-model-worker.js` 并复制到 `dist/`
- `src/main.ts`：在桌面端解析 worker 绝对路径并传给 `EmbeddingService`

**这样做后的直接效果**：
- 设置页不会再因为首轮 ONNX/WASM 初始化而整体假死
- 进度条和按钮状态由 worker 回传，状态更新更稳定
- 下载完成后的预热推理不再阻塞插件页面的交互线程
- 下载按钮不再在“尚未真正进入下载”时把进度条提前推满
- 下载按钮不会再先销毁共享 provider，也不会和正常索引/查询链路抢同一个 progress listener

**仍需排查的剩余失败点**：
- 网络无法访问 HuggingFace
- 当前缓存目录不完整或写入失败
- 所选量化文件不存在
- `local-model-worker.js` 未被正确构建或复制
- WASM 初始化失败或内存不足

**涉及文件**：
- `src/settings.ts` — 下载按钮链路与状态文案
- `src/embeddings/embedding-service.ts` — 新增 prepareLocalModel，并为本地 provider 传入绝对缓存路径与 worker 脚本路径
- `src/embeddings/local-provider.ts` — 改为 worker 代理 provider
- `src/embeddings/local-runtime.ts` — 抽离本地模型真实运行时
- `src/workers/local-model-worker.ts` — 新增本地模型 worker 入口
- `src/main.ts` — 注入 worker 路径并修正 Notice 的下载状态映射
- `esbuild.config.mjs` — 产出 `local-model-worker.js`
- `README.md` — 更新用户侧说明
- `docs/ARCHITECTURE.md` — 更新主线程 / worker 分工说明

**状态**：已修复；本地模型初始化和推理已迁移到 worker，页面卡顿不再是当前架构的既定限制。
---

## #018 运行时错误未及时进入错误日志
**日期**：2026-03-09

**现象**：
- 用户遇到启动失败、查询失败、索引快照恢复失败或设置页模型列表获取失败时，很多信息只出现在控制台。
- `error-log.json` 主要覆盖索引文件失败，排查运行时问题时上下文不足。

**根因分析**：
1. 原先持久化日志入口主要由 `ReindexService` 使用，覆盖面偏向索引流程。
2. 插件入口、查询视图、快照读写、缓存清理和设置页异步请求虽然有 `catch`，但大多只做了 `console.error` / `console.warn`。
3. 未处理异常和未处理 Promise 拒绝没有统一接入持久化日志。
4. 如果 `error-log.json` 自身损坏，之前只能从控制台看到 `ErrorLogger.load()` 失败。

**解决方式**：
1. 在 `main.ts` 增加统一运行时错误入口 `logRuntimeError()`。
2. 为插件相关的 `window.error` 和 `unhandledrejection` 增加兜底捕获，并过滤到与本插件相关的错误。
3. 将以下失败路径接入 `error-log.json` 即时持久化：
   - 插件启动与 `onLayoutReady()`
   - `rebuildIndex()`
   - 索引快照加载 / 保存
   - 旧本地模型缓存清理
   - `ConnectionsView` / `LookupView` 查询
4. `ErrorLogger.load()` 失败时，先写入一条自诊断记录，再从空日志重新开始。
5. 扩展 `errorType` 分类，新增 `query`、`runtime`、`configuration`。

**涉及文件**：
- `src/main.ts` — 统一运行时错误记录入口 + 全局异常兜底
- `src/views/connections-view.ts` — 关联查询失败落盘
- `src/views/lookup-view.ts` — 语义搜索失败落盘
- `src/utils/error-logger.ts` — 错误日志文件自身加载失败时的自诊断
- `src/types.ts` — 扩展 `errorType` 类型
- `README.md` — 更新用户侧错误日志说明
- `docs/ARCHITECTURE.md` — 更新错误日志覆盖范围说明

**验证**：
1. 执行 `npm run build`，确保类型检查与构建通过。
2. 手动触发查询失败、模型列表获取失败或快照异常时，确认 `error-log.json` 有新增记录。

**状态**：已修复。
---

## #019 本地模型 worker 无法创建时应自动降级
**日期**：2026-03-09

**现象**：
- `error-log.json` 中出现本地模型失败记录：
  - `message`: `Failed to construct 'Worker': The V8 platform used by this instance of Node does not support creating Workers`
  - `errorCode`: `ERR_MISSING_PLATFORM_FOR_WORKER`
  - `stage`: `worker-start`
- 触发场景包括设置页“下载本地模型”“清理缓存并重下”“测试本地模型”。

**根因分析**：
1. `LocalProvider` 先前把 `worker_threads` 当成了唯一执行路径。
2. 部分 Obsidian / Electron 桌面环境虽然提供了 Node API，但底层 V8 平台不支持真正创建 worker 线程。
3. 结果是本地模型在 `new Worker(local-model-worker.js)` 这一步直接失败，后续没有降级方案，只能整体报错。

**解决方式**：
1. `LocalProvider` 现在优先尝试 `worker_threads`，仅在检测到 `ERR_MISSING_PLATFORM_FOR_WORKER` 这类环境限制时才降级。
2. 降级后不再把 `@huggingface/transformers` 重复打进 `main.js`，而是直接复用 `local-model-worker.js` 导出的 `createLocalRuntimeController()`。
3. inline 降级路径保留串行请求队列，并把 `local_runtime_mode=inline`、`worker_fallback_code=...` 等上下文并入后续诊断信息。
4. 因此当前环境即使不能创建 Node worker，本地模型仍可继续下载、初始化、测试和参与索引。

**涉及文件**：
- `src/embeddings/local-provider.ts` — 增加 worker -> inline 降级执行路径
- `src/workers/local-model-worker.ts` — 导出可复用的本地运行时控制器
- `README.md` — 更新本地模型运行方式说明
- `docs/ARCHITECTURE.md` — 更新 LocalProvider 的运行模型说明

**验证**：
1. 执行 `npm run build`，确认类型检查与构建通过。
2. 在不支持 `worker_threads` 的环境点击“下载本地模型”或“测试本地模型”，不应再直接因为 `ERR_MISSING_PLATFORM_FOR_WORKER` 失败。
3. 若后续 inline 路径仍失败，`error-log.json` 中应带有 `local_runtime_mode=inline` 和 `worker_fallback_code=ERR_MISSING_PLATFORM_FOR_WORKER`。

**状态**：已修复。
---

## #020 开发阶段缺少成功路径运行日志
**日期**：2026-03-09

**现象**：
- 项目里已经有 `error-log.json`，但开发阶段如果插件其实运行成功，只是想确认“已经跑起来了”“本地模型走的是 worker 还是 inline”，只能看控制台或设置页瞬时提示。
- 成功路径没有持久化记录，重载插件后很难快速回看。

**根因分析**：
1. 现有 `ErrorLogger` 设计目标是失败诊断，不适合混入成功事件。
2. 插件 ready、快照恢复成功、重建完成、本地模型 prepare 成功等信息此前主要散落在 `console.log` 或临时 UI 文案里。
3. 本地模型执行路径选择虽然现在支持 `worker -> inline` 回退，但“最终选中了哪条路径”之前没有独立持久化记录。

**解决方式**：
1. 新增独立的 `RuntimeLogger`，持久化到 `runtime-log.json`。
2. 新增统一入口 `logRuntimeEvent()`，专门记录成功路径和关键运行节点。
3. 接入以下重点事件：
   - `startup-sequence-started` / `plugin-ready`
   - `index-snapshot-loaded`
   - `rebuild-index-started` / `rebuild-index-finished`
   - `local-runtime-mode-selected`
   - `local-model-ready` / `local-model-test-ok`
4. `local-runtime-mode-selected` 会明确记录最终选择了 `worker` 还是 `inline`；若因环境限制回退，还会带上 `worker_fallback_code=...` 等上下文。
5. 运行日志与错误日志分离：前者用于确认成功路径，后者用于定位失败根因。

**涉及文件**：
- `src/utils/runtime-logger.ts` — 新增运行日志持久化
- `src/main.ts` — 新增 `logRuntimeEvent()` 和启动 / 重建 / 快照恢复成功日志
- `src/embeddings/local-model-shared.ts` — 新增本地运行时事件类型
- `src/embeddings/local-provider.ts` — 记录本地模型最终执行路径
- `src/embeddings/embedding-service.ts` — 将本地运行时事件上抛到插件入口
- `src/settings.ts` — 记录本地模型与远程配置的成功事件
- `README.md` — 增加运行日志说明
- `docs/ARCHITECTURE.md` — 增加运行日志机制说明

**验证**：
1. 执行 `npm run build`，确认类型检查与构建通过。
2. 重载插件后，检查 `runtime-log.json` 是否出现 `startup-sequence-started` 和 `plugin-ready`。
3. 点击“下载本地模型”或“测试本地模型”后，检查是否出现 `local-runtime-mode-selected` 和 `local-model-ready` / `local-model-test-ok`。
4. 若当前环境不支持 `worker_threads`，运行日志应明确显示 `mode=inline`。

**状态**：已修复。
---

## #021 本地模型不应在启动时自动下载
**日期**：2026-03-09

**现象**：
- 使用本地模型作为 Embedding provider，且当前索引为空时，插件刚加载完成就自动进入全量重建。
- 在首次启动或缓存缺失场景下，全量重建会隐式触发本地模型下载与初始化。
- 若当前环境只能走 inline 路径，下载与初始化会直接占用主线程，导致 Obsidian 界面明显卡顿，甚至难以继续操作。

**根因分析**：
1. 启动阶段 `onLayoutReady()` 在 `noteStore.size === 0` 时会自动调用 `rebuildIndex()`。
2. `rebuildIndex()` 内部会通过 `EmbeddingService` 直接触发本地模型 prepare / embed 链路。
3. 这让“首次索引”和“首次下载本地模型”在启动阶段被隐式绑定，用户还没进入设置页就已经开始下载。

**解决方式**：
1. 启动阶段检测到“索引为空 + 本地 provider”时，不再自动执行全量重建。
2. 改为弹出提示，让用户先在设置页手动下载本地模型，再手动执行“重建索引”。
3. 同时新增运行日志事件 `startup-auto-rebuild-skipped`，便于确认这次启动是被保护逻辑主动跳过，而不是异常中断。

**涉及文件**：
- `src/main.ts` — 为本地 provider 增加启动阶段的自动重建保护

**验证**：
1. 重载插件，且当前索引为空、本地模型 provider 已选中。
2. 启动后不应立刻出现模型下载进度，也不应自动开始全量索引。
3. `runtime-log.json` 中应新增 `startup-auto-rebuild-skipped`。
4. 进入设置页手动点击“下载本地模型”后，再手动执行“重建索引”，流程应正常进行。

**状态**：已修复。
---

## #022 只有点击“下载”按钮才应触发模型下载
**日期**：2026-03-09

**现象**：
- 期望只有设置页点击“下载本地模型”或“清理缓存并重下”时才开始下载模型。
- 但此前只要本地模型缓存缺失，`testConnection()`、`rebuildIndex()`、语义搜索等任意首次本地推理路径，都可能隐式拉取 HuggingFace 模型文件。

**根因分析**：
1. `LocalModelRuntime` 之前固定将 `env.allowRemoteModels = true`。
2. 这意味着只要任意路径触发 `prepare()` / `embed()` / `embedBatch()`，Transformers.js 都被允许直接联网拉取缺失模型。
3. 因此“下载按钮只是其中一个入口”，而不是唯一入口。

**解决方式**：
1. 为本地运行时配置新增 `allowRemoteModels` 开关。
2. 默认本地 provider 一律使用 `allowRemoteModels = false`，所以测试、本地搜索、重建索引都只能使用本地缓存。
3. 只有设置页“下载本地模型”与“清理缓存并重下”走的 `prepareLocalModel()` 链路会显式切换到 `allowRemoteModels = true`。
4. `rebuildIndex()` 在真正开始前会先执行一次“仅本地缓存”的 ready 检查；若模型未下载，会直接提示先点击“下载本地模型”。

**涉及文件**：
- `src/embeddings/local-model-shared.ts`
- `src/embeddings/local-runtime.ts`
- `src/embeddings/local-provider.ts`
- `src/embeddings/embedding-service.ts`
- `src/workers/local-model-worker.ts`
- `src/main.ts`
- `README.md`

**验证**：
1. 删除当前本地模型缓存后重载插件，不应在启动时自动下载。
2. 直接点击“测试本地模型”或“重建索引”，不应开始下载，而应提示先下载本地模型。
3. 只有点击“下载本地模型”或“清理缓存并重下”后，才应出现下载进度。
4. 下载完成后，再执行“测试本地模型”或“重建索引”，应直接使用本地缓存，不再重复联网下载。

**状态**：已修复。
---

## #023 inline 模式下点击"下载"导致 Obsidian 界面卡死
**日期**：2026-03-09

**现象**：
- 设置页点击"下载"按钮后，进度条有更新但整个 Obsidian 界面进入卡死状态，无法操作。
- `runtime-log.json` 显示 `mode=inline`，`worker_fallback_code=ERR_MISSING_PLATFORM_FOR_WORKER`。

**根因分析**：

### 问题 A：当前降级链缺少 Web Worker 中间层
`LocalProvider` 的降级链为：`worker_threads` → inline。当 Node.js `worker_threads` 不可用时，直接降级到 inline 模式。
但 Electron 渲染进程支持标准 Web Worker API（`globalThis.Worker`），这与 Node.js `worker_threads` 完全独立，当前代码从未尝试过。

### 问题 B：inline 模式阻塞主线程
inline 模式下，以下操作全部在 UI 主线程同步执行：
1. `@huggingface/transformers` 模块加载
2. ONNX Runtime WASM 编译（CPU 密集型）
3. `transformers.pipeline()` 模型下载 + ONNX Session 创建（~100MB 下载 + 初始化）
4. 预热推理

虽然都是 `async` 函数，但内部 WASM 编译和推理是同步计算，持续阻塞事件循环。进度回调能发出（进度条有变化），但 UI 刷新被阻塞，表现为界面卡死。

### 问题 C：`app://obsidian.md` 不能直接访问 `file://` Worker 脚本
即使路径编码正确，Electron 里的页面 origin 仍然是：
`app://obsidian.md`

而浏览器标准 Worker API 直接加载：
`file:///.../local-model-web-worker.js`

会触发跨源访问限制。结果是：
1. `worker_threads` 不可用
2. Web Worker 也因为 `app://` → `file://` 访问被拒而失败
3. 最终再次掉回 `inline`

本次日志已经明确给出了这一点：
`Script at 'file:///.../local-model-web-worker.js' cannot be accessed from origin 'app://obsidian.md'`

**解决方式**：
将降级链改为三级：
```
worker_threads (Node Worker) → globalThis.Worker (Web Worker) → inline (主线程)
```

1. 新建 `src/workers/local-model-web-worker.ts`——Web Worker 入口脚本：
   - 使用 `self.onmessage` / `self.postMessage`（浏览器 Worker API）
   - 直接导入 `@huggingface/transformers`
   - 在导入和 `pipeline()` 初始化期间，对 Electron 暴露出来的 `process` 做最小化伪装，避免 Transformers.js 把 Blob Worker 误判成 Node 环境
   - 复用现有的 `LocalWorkerRequest` / `LocalWorkerResponse` 消息协议
2. `esbuild.config.mjs` 新增 IIFE 格式构建目标 `local-model-web-worker.js`。
3. `local-provider.ts` 在 `worker_threads` 失败后先尝试 Web Worker，再降级 inline。
4. `local-model-shared.ts` 的 `LocalRuntimeMode` 增加 `"web-worker"` 类型。
5. `main.ts` 新增 Web Worker 脚本路径解析。
6. `embedding-service.ts` 将 Web Worker 路径传递给 `LocalProvider`。
7. Web Worker 启动时优先把 `local-model-web-worker.js` 读入内存并转换为 `blob:` URL，再用浏览器 Worker API 加载，绕过 `app://` 对 `file://` Worker 的跨源限制。
8. 只有 Blob Worker 不可用时才会回落到 `file://` URL。
9. 若 Web Worker 仍然失败，`runtime-log.json` 中的 `local-runtime-mode-selected` 会附带 `web_worker_fallback_code` / `web_worker_fallback_message`，不再只有第一层 `worker_threads` 失败信息。
10. 若 `error-log.json` 中出现 `Unsupported device: "wasm". Should be one of: dml, cpu.`，说明 Worker 里的 `process.release.name === "node"` 仍被 Transformers.js 看到了；修复方式是在 Web Worker 内导入模块前临时伪装成浏览器/WASM 环境。

**设计决策**：
- Web Worker 在浏览器里原本不需要环境伪装，但 Obsidian/Electron 的 Blob Worker 仍可能暴露 Node 风格的 `process`；因此这里保留了一层最小化伪装，只覆盖导入和 `pipeline()` 初始化阶段。
- 模型缓存：Web Worker 模式下使用浏览器 Cache API（Transformers.js 在 Web 环境的默认行为），与文件系统缓存分离，可接受（Cache API 也是持久化的）。
- Web Worker 脚本优先通过 Blob URL 启动；这比直接喂 `file://` 更适合 `app://obsidian.md` 这种页面 origin。

**涉及文件**：
- `src/workers/local-model-web-worker.ts` — 新建
- `src/embeddings/local-provider.ts` — 新增 Web Worker 降级层
- `src/embeddings/local-model-shared.ts` — 扩展 LocalRuntimeMode
- `src/embeddings/embedding-service.ts` — 传递 Web Worker 路径
- `src/main.ts` — 解析 Web Worker 脚本路径
- `esbuild.config.mjs` — 新增 IIFE 构建目标
- `README.md` — 更新本地模型运行方式说明
- `docs/ARCHITECTURE.md` — 更新 LocalProvider 降级链说明

**状态**：已修复。构建通过，三个产物正常生成（main.js / local-model-worker.js / local-model-web-worker.js）。
---

## #024 重建索引完成但设置页反馈不清晰 + 调试材料约定
**日期**：2026-03-09

**现象**：
- 用户观察到“重建索引”期间，设置页里的统计只在重新打开或重新查看时才更明显地变化。
- 即使索引已经完成，用户也可能因为缺少明确的完成反馈而误判为“还在跑”。
- 后续排查时，日志文件和快照文件分散放置，不方便快速读取。

**本次核对结果**：
1. 最新一次实际运行中，`runtime-log.json` 明确记录了：
   - `rebuild-index-started`
   - `rebuild-index-finished`
2. 该次全量重建用时约 `14.02` 分钟。
3. `rebuild-index-finished` 的 details 为：
   - `indexed_notes=93`
   - `failed=0`
   - `total=93`
4. `index-store.json` 同步显示：
   - `noteCount = 93`
   - `chunkCount = 984`
   - `vectorCount = 1073`
5. `error-log.json` 为空，说明这次没有持久化错误。

**结论**：
这次不是“索引没完成”，而是“索引已经完成，但 UI 反馈不足以让用户快速确认完成状态”。

**补充约定**：
1. 项目根目录新增 `debug-artifacts/` 目录。
2. 后续如果需要排查 Obsidian 真实运行问题，优先把以下文件复制到该目录：
   - `runtime-log.json`
   - `error-log.json`
   - `index-store.json`
   - `index-vectors.bin`
   - 可选：`console.txt`
3. `README.md` 已同步补充开发者控制台打开方式与调试材料目录说明。

**Obsidian 开发者控制台**：
- Windows / Linux：`Ctrl+Shift+I`
- macOS：`Cmd+Option+I`

**涉及文件**：
- `debug-artifacts/README.md` — 新增调试材料目录说明
- `README.md` — 新增调试材料目录与开发者控制台说明
- `docs/TROUBLESHOOTING.md` — 本条记录新增

**状态**：已记录。
---

## #025 索引成功但右侧没有显示相关笔记
**日期**：2026-03-09

**现象**：
- `runtime-log.json` 和控制台都显示索引成功完成
- 但用户没有在右侧看到相关笔记推荐

**根因分析**：
1. 当前实现里，Connections View 只是被注册，并不会保证已经打开。
2. 只有当 `ConnectionsView` 真正 `onOpen()` 后，它才会开始监听 `active-leaf-change` 并刷新结果。
3. 因此会出现“索引已经成功，但右侧没有任何推荐”的体感落差。

**解决方式**：
1. 新增设置项 `autoOpenConnectionsView`。
2. 默认值设为 `true`。
3. 插件启动进入 `onLayoutReady()` 后，若该设置为开启，则自动打开右侧 Connections View。
4. 自动打开时不强制抢焦点；手动命令仍可继续使用。
5. 设置页增加“启动时打开关联视图”开关，允许用户关闭该行为。

**涉及文件**：
- `src/types.ts` — 新增 `autoOpenConnectionsView` 设置项与默认值
- `src/main.ts` — 启动时自动打开 Connections View
- `src/settings.ts` — 增加“启动时打开关联视图”设置开关
- `CLAUDE.md` — 同步说明默认自动打开行为

**状态**：已修复。
---

## #026 `index-store.json` 体积过大且不便排查
**日期**：2026-03-09

**现象**：
- `index-store.json` 可能达到十几 MB，且旧格式是一行 JSON，不便人工排查。
- 用户在替换新编译产物时，不清楚哪些插件私有数据应保留。
- 用户也不清楚本地模型究竟落在插件目录还是别处。

**根因分析**：
1. 旧版索引快照把 note/chunk 元数据和全部向量数组一起写进单个 JSON 文件，向量越多，文件越大。
2. JSON 单行写法虽然能工作，但对 diff、人工查看和定位损坏位置都不友好。
3. 本地模型缓存位置取决于最终运行模式：`worker` / `inline` 走文件系统缓存，`web-worker` 走浏览器 Cache API。

**解决方式**：
1. `index-store.json` 改为多行 JSON，只保留元数据和向量二进制元信息。
2. 新增 `index-vectors.bin`，把实际向量以 `float32 little-endian` 二进制落盘，显著减少 JSON 体积。
3. 新增命令“显示索引统计”和设置页“查看统计”，直接展示 note/chunk/vector 数量、快照格式、文件体积和占比。
4. 继续兼容旧版单文件快照；只有在下一次保存快照或重建索引后，才会真正生成 `index-vectors.bin`。
5. 更新编译产物时，如需保留现有状态，不要删除整个插件目录，至少保留：
   - `index-store.json`
   - `index-vectors.bin`
   - `runtime-log.json`
   - `error-log.json`
   - `models/`（仅当当前实际模式为 `worker` 或 `inline` 时这里才会有本地模型文件）
6. 本地模型位置说明：
   - `worker` / `inline`：`{vault}/.obsidian/plugins/semantic-connections/models/cache-v{LOCAL_MODEL_CACHE_VERSION}-tf{TRANSFORMERS_JS_VERSION}`
   - `web-worker`：浏览器 Cache API，不保证能在插件目录里看到对应模型文件
   - 可通过 `runtime-log.json` 中的 `local-runtime-mode-selected` 判断当前实际模式

**涉及文件**：
- `src/main.ts` — 索引统计命令 + 快照拆分读写
- `src/settings.ts` — 设置页索引统计摘要
- `src/storage/vector-store.ts` — 向量二进制序列化/反序列化
- `src/types.ts` — 新增索引统计类型
- `docs/ARCHITECTURE.md` — 补充快照与模型缓存落盘说明

**验证**：
1. 执行 `npm run build`，确认构建通过。
2. 重载插件后执行一次“重建索引”或触发一次快照保存。
3. 检查插件目录中是否出现：
   - `index-store.json`
   - `index-vectors.bin`
4. 执行“显示索引统计”或设置页点击“查看统计”，确认能看到数量、体积和占比。

**状态**：已修复。
---

## #027 希望本地模型固定落在插件目录并可手动清理
**日期**：2026-03-09

**现象**：
- 用户希望本地模型统一落在 `plugins/semantic-connections/` 目录下，方便直接查看和删除。
- 但实际运行时若落到 `web-worker`，模型会进浏览器 Cache API，插件目录里看不到。

**根因分析**：
1. `worker` / `inline` 运行模式使用文件系统缓存，路径是插件目录下的 `models/cache-v*`。
2. `web-worker` 运行模式为了避免主线程卡顿，当前使用浏览器 Cache API；这条路径天然不等于插件目录文件。
3. 旧的“清理缓存并重下”只覆盖当前文件系统缓存目录，不足以表达“浏览器缓存也删掉”。

**解决方式**：
1. 新增设置“固定到插件目录”。
2. 开启后，`LocalProvider` 在 `worker_threads` 不可用时会跳过 `web-worker`，直接回退到 `inline`，从而继续使用插件目录缓存。
3. 设置页新增“仅清理缓存”按钮。
4. “仅清理缓存”和“清理缓存并重下”现在都会同时尝试清理：
   - 插件目录下当前模型缓存
   - 浏览器 `transformers-cache`
5. 运行日志会继续记录 `local-runtime-mode-selected`，便于确认当前实际走的是 `worker` / `web-worker` / `inline`。

**涉及文件**：
- `src/types.ts`
- `src/settings.ts`
- `src/embeddings/embedding-service.ts`
- `src/embeddings/local-provider.ts`
- `src/embeddings/local-model-shared.ts`
- `docs/ARCHITECTURE.md`

**验证**：
1. 执行 `npm run build`，确认构建通过。
2. 在设置页开启“固定到插件目录”。
3. 点击“仅清理缓存”后再重新下载本地模型。
4. 检查：
   - `runtime-log.json` 中的 `local-runtime-mode-selected`
   - `{vault}/.obsidian/plugins/semantic-connections/models/`

**状态**：已修复。
---

## 待解决问题

暂无。
