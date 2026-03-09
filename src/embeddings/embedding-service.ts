/**
 * EmbeddingService - Embedding 调度服务（门面 + 工厂）
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Embedding Layer（向量化层）                          │
 * │  被谁调用：                                                          │
 * │    - ReindexService（索引时生成 embedding）                           │
 * │    - LookupService（搜索时将查询文本转为向量）                         │
 * │  依赖谁：MockProvider 或 RemoteProvider（通过 EmbeddingProvider 接口）│
 * │  参见：ARCHITECTURE.md「四、Embedding 层」                            │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 这是上层模块与 Embedding 能力之间的「门面」（Facade）。
 *
 * ## 为什么需要 EmbeddingService
 *
 * 上层模块（ReindexService、LookupService）不应该直接使用 MockProvider
 * 或 RemoteProvider。原因：
 *
 * 1. **解耦**：上层不关心当前用的是哪个 provider
 * 2. **运行时切换**：用户可以在设置中随时切换 provider，
 *    EmbeddingService 的 switchProvider() 方法处理这个切换
 * 3. **统一入口**：所有 embedding 调用都经过这里，方便添加
 *    全局逻辑（如日志、缓存、指标统计）
 *
 * ## 设计模式
 *
 * 结合了两种模式：
 *
 * ### 门面模式（Facade）
 * ```
 * ReindexService → EmbeddingService.embed()
 *                                    ↓
 *                       provider.embed()  ← 内部委托
 * ```
 * 上层只看到简单的 embed/embedBatch 方法，不知道内部是 mock 还是 remote。
 *
 * ### 工厂方法模式（Factory Method）
 * ```
 * createProvider(settings)
 *   → settings.embeddingProvider === "remote" → new RemoteProvider(...)
 *   → settings.embeddingProvider === "mock"   → new MockProvider()
 * ```
 * 根据配置创建对应的 provider 实例。新增 provider 只需添加一个 case。
 *
 * ## 数据流
 *
 * ### 索引阶段（ReindexService → EmbeddingService）
 * ```
 * ReindexService.indexFile()
 *   → step 5: embeddingService.embedBatch(chunkTexts)
 *       → provider.embedBatch(chunkTexts)
 *         → [chunk 向量数组]
 *   → step 6: embeddingService.embed(summaryText)
 *       → provider.embed(summaryText)
 *         → note 向量
 * ```
 *
 * ### 搜索阶段（LookupService → EmbeddingService）
 * ```
 * LookupService.search(queryText)
 *   → embeddingService.embed(queryText)
 *     → provider.embed(queryText)
 *       → 查询向量
 *   → vectorStore.search(查询向量, topK, filterFn)
 * ```
 *
 * ## 生命周期
 *
 * 1. main.ts 的 createServices() 中创建 EmbeddingService
 * 2. 首次创建时根据 settings 实例化对应的 provider
 * 3. 用户在 Settings Tab 中切换 provider 时，
 *    main.ts 调用 switchProvider() 重新创建 provider
 * 4. 切换 provider 后需要重建索引（因为新旧 provider 维度可能不同）
 */

import type { ErrorDiagnostic, Vector, RemoteModelInfo } from "../types";
import type { SemanticConnectionsSettings } from "../types";
import { normalizeErrorDiagnostic } from "../utils/error-utils";
import type { EmbeddingProvider } from "./provider";
import { MockProvider } from "./mock-provider";
import { RemoteProvider } from "./remote-provider";
import { LocalProvider, SUPPORTED_LOCAL_MODELS } from "./local-provider";
import type { LocalModelProgress, LocalProviderRuntimeEvent } from "./local-provider";

// 本地模型缓存版本：当 Transformers.js 升级或缓存结构变更时手动递增
const LOCAL_MODEL_CACHE_VERSION = 2;
const TRANSFORMERS_JS_VERSION = "3.8.1";

type ServiceOperationFailure = {
	ok: false;
	error: string;
	diagnostic: ErrorDiagnostic;
};

type ServiceOperationSuccess<T> = { ok: true } & T;

export class EmbeddingService {
	/**
	 * 当前使用的 provider 实例
	 *
	 * 通过 EmbeddingProvider 接口引用，不关心具体类型。
	 * 所有 embed/embedBatch 调用都委托给这个实例。
	 */
	private provider: EmbeddingProvider;

	/** 插件数据目录路径（用于 LocalProvider 的模型缓存） */
	private pluginDataPath: string;
	private pluginBasePath: string;
	private localWorkerScriptPath: string;
	private localWebWorkerScriptPath: string;

	/** 模型下载/加载进度监听器 */
	private readonly progressListeners = new Set<(progress: LocalModelProgress) => void>();
	private localRuntimeEventListener?: (event: LocalProviderRuntimeEvent) => void;

	/**
	 * @param settings - 插件全局设置
	 * @param pluginDataPath - 插件数据目录的相对路径（如 ".obsidian/plugins/semantic-connections"）
	 *
	 * 构造时根据 settings.embeddingProvider 创建对应的 provider。
	 * 保存 settings 引用是为了 switchProvider() 时能访问最新配置。
	 */
	constructor(
		private settings: SemanticConnectionsSettings,
		pluginDataPath: string = "",
		pluginBasePath: string = "",
		localWorkerScriptPath: string = "",
		localWebWorkerScriptPath: string = "",
		localRuntimeEventListener?: (event: LocalProviderRuntimeEvent) => void,
	) {
		this.pluginDataPath = pluginDataPath;
		this.pluginBasePath = pluginBasePath;
		this.localWorkerScriptPath = localWorkerScriptPath;
		this.localWebWorkerScriptPath = localWebWorkerScriptPath;
		this.localRuntimeEventListener = localRuntimeEventListener;
		this.provider = this.createProvider(settings);
	}

	/** 生成本地模型缓存目录（隔离旧版本缓存，避免更新后混用） */
	getLocalModelCachePath(): string {
		const base = this.pluginDataPath
			? `${this.pluginDataPath}/models`
			: "./models";
		return `${base}/cache-v${LOCAL_MODEL_CACHE_VERSION}-tf${TRANSFORMERS_JS_VERSION}`;
	}

	getAbsoluteLocalModelCachePath(): string {
		const relativeCachePath = this.getLocalModelCachePath().replace(/\//g, "\\");
		if (!this.pluginBasePath) {
			return relativeCachePath;
		}

		return `${this.pluginBasePath}\\models\\cache-v${LOCAL_MODEL_CACHE_VERSION}-tf${TRANSFORMERS_JS_VERSION}`;
	}

	/**
	 * 当前使用的 provider 名称
	 *
	 * 返回值：\"mock\" 或 \"remote\"
	 * 用于 UI 显示和日志记录。
	 */
	get providerName(): string {
		return this.provider.name;
	}

	/**
	 * 当前向量维度
	 *
	 * 委托给 provider.dimension。
	 * - MockProvider：始终返回 128
	 * - RemoteProvider：初始 1536，首次 API 调用后动态更新
	 */
	get dimension(): number {
		return this.provider.dimension;
	}

	/**
	 * 为单条文本生成 embedding
	 *
	 * 纯委托方法：直接转发给当前 provider。
	 * 之所以不直接暴露 provider，是为了保持封装性，
	 * 后续可以在此添加缓存、日志等切面逻辑。
	 */
	async embed(text: string): Promise<Vector> {
		return this.provider.embed(text);
	}

	/**
	 * 批量生成 embedding
	 *
	 * 同样是纯委托。批量调用的价值体现在 RemoteProvider 中：
	 * 一次 HTTP 请求发送多条文本，减少网络往返。
	 */
	async embedBatch(texts: string[]): Promise<Vector[]> {
		return this.provider.embedBatch(texts);
	}

	/**
	 * 切换 provider
	 *
	 * 在以下场景调用：
	 * - 用户在 Settings Tab 中从 mock 切换到 remote
	 * - 用户在 Settings Tab 中修改了 remote 的配置（URL、Model、Key）
	 *
	 * main.ts 中的 onSettingsChanged() 会调用此方法：
	 * ```
	 * this.embeddingService.switchProvider(this.settings);
	 * ```
	 *
	 * 注意：切换 provider 后，旧向量与新向量维度可能不同，
	 * 需要用户手动执行「重建索引」命令来重新生成所有向量。
	 */
	switchProvider(settings: SemanticConnectionsSettings): void {
		// 释放旧 provider 的资源（如 LocalProvider 的 ONNX Session）
		if (this.provider.dispose) {
			void this.provider.dispose();
		}
		this.settings = settings;
		this.provider = this.createProvider(settings);
	}

	/**
	 * 显式释放当前 provider 资源。
	 *
	 * 主要用于删除当前本地模型缓存前，先断开已加载的本地模型会话。
	 */
	async disposeCurrentProvider(): Promise<void> {
		if (this.provider.dispose) {
			await this.provider.dispose();
		}
	}

	/**
	 * 测试当前 provider 的连接是否正常
	 *
	 * 发送一条短文本进行 embed 请求，验证 API 配置（Key / URL / Model）是否有效。
	 * - mock provider 始终成功
	 * - remote provider 会实际调用 API
	 *
	 * @returns 成功时返回维度信息，失败时返回错误描述
	 */
	async testConnection(): Promise<
		ServiceOperationSuccess<{ dimension: number }> | ServiceOperationFailure
	> {
		try {
			const vec = await this.provider.embed("connection test");
			return { ok: true, dimension: vec.length };
		} catch (err) {
			return this.buildFailureResult(err);
		}
	}

	/**
	 * 准备当前本地模型：
	 * - 下载缺失模型文件
	 * - 初始化推理会话
	 * - 返回最终向量维度
	 *
	 * 与 testConnection() 的区别是：这里不会再额外执行一次测试 embedding，
	 * 因此更适合作为设置页“下载”按钮的实际动作。
	 */
	async prepareLocalModel(): Promise<
		ServiceOperationSuccess<{ dimension: number }> | ServiceOperationFailure
	>;
	async prepareLocalModel(options: {
		progressListener?: (progress: LocalModelProgress) => void;
	}): Promise<ServiceOperationSuccess<{ dimension: number }> | ServiceOperationFailure>;
	async prepareLocalModel(options?: {
		progressListener?: (progress: LocalModelProgress) => void;
	}): Promise<ServiceOperationSuccess<{ dimension: number }> | ServiceOperationFailure> {
		if (this.settings.embeddingProvider !== "local") {
			return this.buildFailureResult({
				message: "当前 provider 不是本地模型",
				code: "ERR_PROVIDER_NOT_LOCAL",
				stage: "provider-selection",
			});
		}

		const temporaryProvider = this.createLocalProvider({
			allowRemoteModels: true,
			onProgress: options?.progressListener,
			broadcastProgress: false,
		});

		try {
			const dimension = await temporaryProvider.downloadAndPrepare();
			return { ok: true, dimension };
		} catch (err) {
			return this.buildFailureResult(err);
		} finally {
			await temporaryProvider.dispose().catch(() => undefined);
		}
	}

	async ensureLocalModelReady(): Promise<
		ServiceOperationSuccess<{ dimension: number }> | ServiceOperationFailure
	> {
		if (!(this.provider instanceof LocalProvider)) {
			return this.buildFailureResult({
				message: "当前 provider 不是本地模型",
				code: "ERR_PROVIDER_NOT_LOCAL",
				stage: "provider-selection",
			});
		}

		try {
			const dimension = await this.provider.prepare();
			return { ok: true, dimension };
		} catch (err) {
			return this.buildFailureResult(err);
		}
	}

	/**
	 * 获取远程 API 的可用 embedding 模型列表
	 *
	 * 仅在 provider 为 "remote" 且 apiUrl 已配置时有效。
	 * 用于设置页的模型下拉选择框。
	 *
	 * 与 testConnection() 采用相同的 ok/error 返回模式，
	 * 确保上层 UI 统一处理成功和失败场景。
	 *
	 * @returns 成功时返回模型列表，失败时返回错误信息
	 */
	async fetchAvailableModels(): Promise<
		| { ok: true; models: RemoteModelInfo[] }
		| { ok: false; error: string; diagnostic?: ErrorDiagnostic }
	> {
		if (this.settings.embeddingProvider !== "remote") {
			return { ok: false, error: "当前非远程模式" };
		}
		if (!this.settings.remoteApiUrl) {
			return { ok: false, error: "API Base URL 未配置" };
		}

		try {
			const models = await RemoteProvider.fetchModels(
				this.settings.remoteApiUrl,
				this.settings.remoteApiKey,
			);
			return { ok: true, models };
		} catch (err) {
			const diagnostic = normalizeErrorDiagnostic(err);
			return {
				ok: false,
				error: diagnostic.message,
				diagnostic,
			};
		}
	}

	/**
	 * 设置模型下载/加载进度监听器
	 *
	 * 由 main.ts 在 rebuildIndex() 中使用，
	 * 将 LocalProvider 的模型下载进度传递到 Notice。
	 *
	 * @param fn - 进度回调，传入 undefined 清除监听
	 */
	addProgressListener(fn: (progress: LocalModelProgress) => void): () => void {
		this.progressListeners.add(fn);
		return () => {
			this.progressListeners.delete(fn);
		};
	}

	private buildFailureResult(error: unknown): ServiceOperationFailure {
		const diagnostic = normalizeErrorDiagnostic(error);
		return {
			ok: false,
			error: diagnostic.message,
			diagnostic,
		};
	}

	private emitProgress(progress: LocalModelProgress): void {
		for (const listener of Array.from(this.progressListeners)) {
			listener(progress);
		}
	}

	private createLocalProvider(options?: {
		allowRemoteModels?: boolean;
		onProgress?: (progress: LocalModelProgress) => void;
		broadcastProgress?: boolean;
	}): LocalProvider {
		const modelInfo = SUPPORTED_LOCAL_MODELS.find((m) => m.id === this.settings.localModelId);
		return new LocalProvider({
			modelId: this.settings.localModelId,
			dimension: modelInfo?.dimension ?? 384,
			cachePath: this.getAbsoluteLocalModelCachePath(),
			dtype: this.settings.localDtype,
			allowRemoteModels: options?.allowRemoteModels ?? false,
			workerScriptPath: this.localWorkerScriptPath,
			webWorkerScriptPath: this.localWebWorkerScriptPath,
			onProgress: (info) => {
				if (options?.broadcastProgress ?? true) {
					this.emitProgress(info);
				}
				options?.onProgress?.(info);
			},
			onRuntimeEvent: (event) => this.localRuntimeEventListener?.(event),
		});
	}

	/**
	 * 根据设置创建对应的 provider 实例（工厂方法）
	 *
	 * 遵循 OCP 原则（开闭原则）：
	 * - 新增 provider 类型时，只需在此处添加一个 case
	 * - 不需要修改 embed/embedBatch 等方法
	 * - 不需要修改 ReindexService、LookupService 等调用方
	 *
	 * 当前支持：
	 * - "remote"：使用 OpenAI 兼容 API（生产推荐）
	 * - "local"：使用 Transformers.js 本地推理（无 API 费用）
	 * - "mock"：使用字符频率伪向量（开发调试用）
	 * - default → mock：未知类型时降级到 mock，避免崩溃
	 */
	private createProvider(settings: SemanticConnectionsSettings): EmbeddingProvider {
		switch (settings.embeddingProvider) {
			case "remote":
				return new RemoteProvider({
					apiKey: settings.remoteApiKey,
					apiUrl: settings.remoteApiUrl,
					model: settings.remoteModel,
					batchSize: settings.remoteBatchSize,
				});
			case "local":
				return this.createLocalProvider();
			case "mock":
			default:
				// default 降级到 mock：即使 settings 中出现未知值也不会崩溃
				return new MockProvider();
		}
	}
}
