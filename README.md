# Semantic Connections

一个 Obsidian 插件，为你的笔记库建立语义索引，自动发现笔记之间的隐藏关联，并精准定位到最相关的段落。

## 功能

### Connections View（右侧关联面板）

打开任意笔记，右侧自动展示：

- 与当前笔记最相关的其他笔记
- 每篇相关笔记中**最契合的一段文字**
- 相似度评分

### Lookup View（语义搜索）

输入自然语言查询：

- 在整个笔记库中进行段落级语义搜索
- 返回最相关的笔记片段，而非仅匹配关键词
- 支持防抖输入，回车即搜

### 增量索引

- 自动监听文件的创建、修改、删除、重命名
- 防抖去重，不影响日常编辑体验
- 内容未变化时自动跳过（基于哈希检测）
- 重命名任务会保留旧路径迁移信息，不会被后续修改事件覆盖

### 本地模型（Transformers.js）

- 支持在插件内下载、预热、测试本地 Embedding 模型
- 设置页显示下载进度、状态和最终是否就绪
- “下载”只负责下载缺失文件并初始化本地模型；“测试本地模型”才会执行真实测试推理
- 支持“清理缓存并重下”，用于缓存损坏后的快速恢复
- 启动时自动清理旧版本本地模型缓存，避免代码升级后混用旧文件

## 安装

1. 将本项目文件夹复制到 vault 的 `.obsidian/plugins/semantic-connections/` 目录下
2. 在 Obsidian 设置 → 第三方插件 中启用 **Semantic Connections**
3. 在插件设置中配置 Embedding 模型

## 配置

在 Obsidian 设置 → Semantic Connections 中：

| 选项 | 说明 | 默认值 |
|------|------|--------|
| 最大关联数 | 右侧展示的相关笔记数量 | 20 |
| 自动索引 | 文件变更时自动更新索引 | 开启 |
| Embedding 模型 | 本地模型 / 远程 API | 本地模型 |
| 排除文件夹 | 不参与索引的目录 | 无 |

### 本地模型配置

选择「本地模型」后，可配置：

| 选项 | 说明 |
|------|------|
| 本地模型 | 选择要下载和推理的 HuggingFace 模型 |
| 量化精度 | `q8` / `q4` / `fp16` / `fp32`，影响下载大小和推理精度 |
| 下载本地模型 | 下载缺失模型文件并初始化当前模型；不会额外执行一次测试推理 |
| 清理缓存并重下 | 删除当前版本缓存并重新下载，适合缓存损坏场景 |
| 测试本地模型 | 执行一次真实测试推理，确认模型是否可用 |

本地模型缓存位于：

```text
{vault}/.obsidian/plugins/semantic-connections/models/
```

缓存目录采用版本化命名。插件启动时会自动清理旧版本缓存；如果当前缓存损坏，可直接在设置页使用“清理缓存并重下”。
设置页中的下载状态会经历“下载文件 -> 模型文件已加载 -> 初始化推理会话 -> 预热 -> 模型已就绪”几个阶段；其中单个文件的 `done` 只表示该文件完成，不代表整套模型已经准备完毕。进度条只会在真正进入 `download` / `progress` / `done` 阶段后推进，`initiate`、`ready`、`warmup` 只更新状态文本，不会再提前把进度条推到高位。
当前实现会优先将本地模型的下载后初始化、ONNX/WASM 会话创建和预热推理放到独立的后台线程，主线程只负责按钮、进度条和状态文本更新。运行时降级链为三级：

1. **Node Worker**（`worker_threads`）：优先使用，完全后台执行
2. **Web Worker**（`globalThis.Worker` / `window.Worker`）：Node Worker 不可用时自动降级，使用浏览器标准 Worker API，模型缓存走浏览器 Cache API
3. **inline**（主线程）：前两者均不可用时的最终兜底，可能导致界面短暂卡顿

Web Worker 启动时现在会优先把 `local-model-web-worker.js` 读入内存并转换成 `blob:` URL，再交给浏览器 Worker API 加载，避免 `app://obsidian.md` 直接访问 `file://` 脚本时的跨源限制；只有 Blob Worker 不可用时才会回落到 `file://` URL。

设置页“下载本地模型”现在使用独立的临时 `LocalProvider` / 独立 worker，不再直接复用 `EmbeddingService` 当前的共享 provider；因此点击“下载”不会再先销毁当前本地运行时，也不会和正常搜索/索引那条链路互相抢进度监听。

为避免首次启动时自动下载本地模型并阻塞界面，当前版本在“索引为空 + 本地模型 provider”场景下不会自动重建索引；请先在设置页点击“下载”或“清理缓存并重下”，确认模型就绪后再手动执行“重建索引”。

当前实现中，只有“下载本地模型”和“清理缓存并重下”会允许从远程拉取缺失模型文件；“测试本地模型”、语义搜索、关联视图和“重建索引”都只使用本地缓存，不会再隐式触发下载。若模型尚未下载，会直接提示先执行下载。

如果点击”下载”或”测试本地模型”仍然失败，剩余常见原因通常是：网络无法访问 HuggingFace、当前缓存不完整、缓存目录写入失败、所选量化文件不存在、`local-model-worker.js` 或 `local-model-web-worker.js` 未正确构建或复制、WASM 初始化失败或内存不足。详细排查见 `TROUBLESHOOTING.md`。

### 远程 API 配置

选择「远程 API」后，需要填写：

| 选项 | 说明 | 默认值 |
|------|------|--------|
| API Key | OpenAI 或兼容服务的密钥 | - |
| API Base URL | 兼容 OpenAI 格式的地址 | `https://api.openai.com/v1` |
| 模型名称 | Embedding 模型 ID | `text-embedding-3-small` |
| 批量大小 | 单次请求最大文本数 | 100 |

支持任何 OpenAI 兼容的 Embedding API（Azure OpenAI、together.ai 等），只需修改 Base URL。

## 使用

1. **首次使用**：启用插件后会自动执行全量索引（也可通过命令手动触发）
2. **查看关联**：打开任意笔记，在右侧面板查看语义关联
3. **语义搜索**：通过命令面板打开 Lookup View，输入查询词
4. **本地模型模式**：先在设置页点击“下载”或“清理缓存并重下”，看到“模型已就绪”后再执行测试或重建索引

### 结果一致性说明

- 快速切换笔记时，Connections 面板会丢弃过期查询结果，不会显示上一篇笔记的结果
- 连续输入搜索词时，Lookup 面板会丢弃过期搜索结果，不会被慢请求覆盖
- 向量存储会严格校验维度一致性；若发现快照损坏或向量维度不一致，会拒绝加载并要求重新构建索引
- 远程 Embedding 响应会校验条数、索引连续性和向量维度，避免把坏数据写入索引

### 命令

| 命令 | 说明 |
|------|------|
| `Semantic Connections: 打开关联视图` | 在右侧打开 Connections 面板 |
| `Semantic Connections: 打开语义搜索` | 打开 Lookup 搜索面板 |
| `Semantic Connections: 重建索引` | 重新扫描全部笔记并构建索引 |
| `Semantic Connections: 清理旧本地模型缓存` | 删除当前版本之外的旧本地模型缓存 |

## 运行时错误日志

错误日志文件位于：

```text
{vault}/.obsidian/plugins/semantic-connections/error-log.json
```

现在该日志不再只记录“索引某个文件失败”。以下运行时问题也会尽量快速写入日志，便于直接定位：

- 插件启动、`onLayoutReady()` 和全量重建索引失败
- 索引快照加载或保存失败
- 旧本地模型缓存清理失败
- Connections / Lookup 视图查询失败
- 远程模型列表获取失败
- 与插件相关的未处理异常和未处理 Promise 拒绝
- 错误日志文件本身损坏或无法读取

常见 `errorType` 包括：

- `embedding`
- `scanning`
- `chunking`
- `storage`
- `query`
- `runtime`
- `configuration`
- `unknown`

排查问题时，建议同时查看：

1. Obsidian 开发者控制台中的原始报错
2. `error-log.json` 最新一条记录
3. 触发问题时的具体操作步骤

## 开发期运行日志

运行日志文件位于：

```text
{vault}/.obsidian/plugins/semantic-connections/runtime-log.json
```

它和 `error-log.json` 分开：

- `runtime-log.json` 记录成功路径、关键运行节点和重要回退信息
- `error-log.json` 记录失败、异常和可直接定位的问题上下文

当前运行日志会重点记录：

- `startup-sequence-started` / `plugin-ready`
- `index-snapshot-loaded`
- `rebuild-index-started` / `rebuild-index-finished`
- `local-runtime-mode-selected`：本地模型最终走了 `worker`、`web-worker` 还是 `inline`；若最终掉到 `inline`，会带上 `worker_fallback_code`，以及可用时的 `web_worker_fallback_code`
- `local-model-download-requested` / `local-model-download-started` / `local-model-download-first-byte`
- `local-model-download-ready` / `local-model-download-warmup`
- `local-model-ready` / `local-model-test-ok`
- `remote-model-list-fetched` / `remote-connection-test-ok`

如果你在开发阶段想先确认“插件有没有正常跑起来”“本地模型到底走了哪条成功路径”，优先看 `runtime-log.json`；如果是定位失败根因，再结合 `error-log.json` 和控制台。

## 技术架构

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

```
src/
├── main.ts                  插件入口
├── types.ts                 类型定义
├── settings.ts              设置页
├── storage/                 存储层（笔记、语义块、向量）
├── indexing/                索引层（扫描、切分、队列、编排）
├── embeddings/              向量层（Provider 接口、Local、Remote、内部 Mock）
├── search/                  搜索层（关联检索、语义搜索、段落选取）
├── views/                   视图层（Connections、Lookup）
├── workers/                 Worker 入口（Node Worker + Web Worker）
└── utils/                   工具函数
```

## 开发

```bash
# 安装依赖
npm install

# 开发模式（监听文件变化自动构建）
npm run dev

# 生产构建
npm run build
```

## 许可证

MIT

## Local Model Worker Note

In Obsidian/Electron, a Blob Web Worker can still expose Node-like `process` globals.
The local model Web Worker now spoofs that environment only during
`@huggingface/transformers` import and `pipeline()` startup so the worker stays
on the WASM backend instead of failing with
`Unsupported device: "wasm". Should be one of: dml, cpu.`
