# CLAUDE.md

## 组织架构

本项目按下面的结构组织：

1. `main.ts`
   - 插件入口
   - 注册 views / commands / settings / events
   - 初始化核心 services

2. `views/`
   - 右侧 Connections View
   - Lookup / Search View
   - 只负责 UI 与交互，不承载核心索引逻辑

3. `indexing/`
   - 扫描 Markdown 文件
   - 切分 note 为 chunks（标题块 / 段落块）
   - 增量索引与重建索引队列

4. `embeddings/`
   - EmbeddingProvider 抽象
   - mock / local / remote provider
   - 统一 embedding 调用入口

5. `storage/`
   - note 元数据存储
   - chunk 元数据存储
   - vector 存储与读取

6. `search/`
   - 相似度计算
   - 召回与排序
   - 从相关笔记中选出“最契合的一段文字”

7. `commands/`
   - 打开视图
   - 重建索引
   - 暂停 / 恢复自动索引

8. `utils/`
   - 文本处理
   - 路径过滤
   - debounce / logger 等辅助函数

---

## 项目目标

这是一个 Obsidian 插件项目，目标是做一个受 Smart Connections 启发、但**独立实现**的插件。

核心目标：

1. 为 vault 中的 Markdown 文件建立语义索引
2. 在 Obsidian 右侧展示与当前笔记最相关的内容
3. 不只展示“相关笔记”，还要展示“相关笔记中最契合的一段文字”
4. 支持自然语言语义搜索
5. 支持 create / modify / delete / rename 的增量索引

---

## 核心产品定义

### 1. Connections View（右侧主视图）
当用户打开某个 Markdown 文件时，右侧展示：

- 最相关的若干篇笔记
- 每篇笔记中与当前笔记**最契合的一段文字**
- 标题、路径、相似度、最佳片段摘要

### 2. Lookup View
用户输入自然语言查询后：

- 返回相关笔记
- 每条结果附带最相关 chunk / passage
- 支持点击打开源笔记

---

## 功能范围

### v1 必做
- Connections View
- Lookup View
- Markdown 扫描
- chunk 级切分
- note / chunk embedding
- 最佳 passage 选取
- 增量索引
- 基础设置页
- 基础命令

### v1 不做
- 聊天功能
- 多轮 agent
- 移动端适配
- 云端同步索引
- 复杂 rerank
- 复制 Smart Connections 代码或内部实现

---

## 检索与展示策略

为了满足“右侧展示最契合的一段文字”，采用两阶段策略：

### 第一阶段：note-level 召回
- 先找到与当前笔记最相关的若干篇候选笔记

### 第二阶段：chunk-level 精排
- 在候选笔记内部，比较其各个 chunk
- 选出与当前笔记最契合的那一段文字
- 将该段文字作为右侧结果的主展示内容

这样做的目标：

- 结果更像“相关上下文”，而不只是“相关文件名”
- UI 更接近 Smart Connections 的实际使用体验
- 架构上仍可控，不会一开始就过度复杂

---

## 索引粒度规则

### v1 索引粒度
v1 必须支持 chunk 级索引，但 chunk 规则保持简单：

- 按标题块切分，或
- 按自然段切分

每个 chunk 至少包含：

- `chunkId`
- `notePath`
- `heading`
- `text`
- `order`
- `vector`

每个 note 至少包含：

- `path`
- `title`
- `mtime`
- `hash`
- `tags`
- `outgoingLinks`
- `summaryText`
- `vector`（可选，但建议保留）

---

## 代码实现原则

1. `onload()` 必须保持轻量
   - 只做注册与初始化
   - 不要在 `onload()` 内做大规模索引计算

2. 所有重任务必须走 service / queue
   - 全量索引
   - 文件重建索引
   - chunk 生成
   - embedding 计算

3. Views 不承载核心业务逻辑
   - view 只负责展示与触发操作
   - 搜索 / 排序 / passage 选择必须放在 `search/` 或 `indexing/`

4. 对活动编辑器的修改优先使用 Editor API
   - 不要直接重写当前正在编辑的文件内容

5. 不复制 Smart Connections 代码
   - 可以借鉴交互目标
   - 但必须独立实现

---

## 推荐的数据流

### 当前笔记右侧推荐
1. 获取当前 active file
2. 读取当前 note 的索引结果
3. 做 note-level 召回
4. 对候选 notes 做 chunk-level 比较
5. 为每个候选 note 选出最佳 passage
6. 在右侧 view 渲染结果

### Lookup 搜索
1. 用户输入 query
2. 为 query 生成 embedding
3. 检索候选 notes / chunks
4. 聚合并排序
5. 展示最佳片段

---

## 事件处理规则

必须监听：

- `create`
- `modify`
- `delete`
- `rename`

要求：

- 所有事件通过 `registerEvent()` 注册
- 不把重计算直接写进事件回调
- 统一进入 reindex queue
- rename 必须单独处理，不能只依赖 metadata changed

---

## 目录职责约定

### `views/`
- `connections-view.ts`
  - 右侧相关推荐视图
  - 展示最佳 passage
- `lookup-view.ts`
  - 搜索视图
- `components/`
  - 结果列表、搜索框、空状态、状态标签

### `indexing/`
- `scanner.ts`
  - 扫描 vault 和读取内容
- `chunker.ts`
  - 将 note 切成标题块 / 段落块
- `reindex-service.ts`
  - 组织全量 / 单文件索引
- `reindex-queue.ts`
  - 防抖、去重、串行处理

### `embeddings/`
- `provider.ts`
  - EmbeddingProvider 接口
- `mock-provider.ts`
  - 开发期 mock
- `embedding-service.ts`
  - provider 调度层

### `storage/`
- `note-store.ts`
- `chunk-store.ts`
- `vector-store.ts`

### `search/`
- `similarity.ts`
  - 余弦相似度等纯函数
- `connections-service.ts`
  - 当前笔记相关推荐
- `lookup-service.ts`
  - 搜索逻辑
- `passage-selector.ts`
  - 从候选笔记中选最佳段落

---

## Claude 开发规则

当 Claude 接到任务时，默认流程如下：

1. 先阅读相关文件
2. 简要总结当前结构
3. 给出最小实现计划
4. 分小步实现
5. 说明改了哪些文件
6. 给出手动验证步骤

### Claude 不应做的事
- 不要一次性重写整个项目
- 不要引入聊天功能，除非明确要求
- 不要跳过 chunk-level 设计
- 不要把 passage 选择逻辑写进 view
- 不要为了风格问题改动无关文件
- 不要复制 Smart Connections 代码

---

## 当前版本的完成标准

一个功能被视为完成，至少要满足：

1. 构建通过
2. 代码符合现有架构
3. 能在 Obsidian 中手动验证
4. 右侧能展示相关笔记
5. 每条相关笔记能展示最佳 passage
6. 改动范围尽量小且清晰

---

## 当前优先级

1. 搭建插件骨架
2. 实现 Connections View 空壳
3. 实现 chunker
4. 实现 mock embeddings
5. 实现 note-level 召回
6. 实现 passage-selector
7. 在右侧展示最佳 passage
8. 再接入真实 embedding provider