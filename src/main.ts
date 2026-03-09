/**
 * 插件入口文件
 *
 * 职责：
 * - 注册 views、commands、settings、events
 * - 初始化核心 services 并建立依赖关系
 * - 保持 onload() 轻量，不做大规模计算
 */

import { Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import {
	SemanticConnectionsSettings,
	DEFAULT_SETTINGS,
	type LocalDtype,
	type IndexStorageSummary,
	type IndexErrorEntry,
	type RebuildIndexProgress,
	type RuntimeLogCategory,
	type RuntimeLogEntry,
	type RuntimeLogLevel,
} from "./types";
import { ConnectionsView, VIEW_TYPE_CONNECTIONS } from "./views/connections-view";
import { LookupView, VIEW_TYPE_LOOKUP } from "./views/lookup-view";
import { SettingTab } from "./settings";
import { NoteStore } from "./storage/note-store";
import { ChunkStore } from "./storage/chunk-store";
import { VectorStore } from "./storage/vector-store";
import { Scanner } from "./indexing/scanner";
import { Chunker } from "./indexing/chunker";
import { ReindexService } from "./indexing/reindex-service";
import { ReindexQueue } from "./indexing/reindex-queue";
import { EmbeddingService } from "./embeddings/embedding-service";
import { ConnectionsService } from "./search/connections-service";
import { LookupService } from "./search/lookup-service";
import { ErrorLogger } from "./utils/error-logger";
import { RuntimeLogger } from "./utils/runtime-logger";
import { mergeErrorDetails, normalizeErrorDiagnostic } from "./utils/error-utils";
import type {
	LocalModelProgress,
	LocalProviderRuntimeEvent,
} from "./embeddings/local-model-shared";

type RuntimeErrorLogOptions = {
	errorType?: IndexErrorEntry["errorType"];
	filePath?: string;
	details?: string[];
	provider?: string;
	stage?: string;
};

type RuntimeEventLogOptions = {
	level?: RuntimeLogLevel;
	category?: RuntimeLogCategory;
	details?: string[];
	provider?: string;
};

type RebuildIndexOptions = {
	onProgress?: (progress: RebuildIndexProgress) => void;
};

const LOCAL_DTYPES: LocalDtype[] = ["fp32", "fp16", "q8", "q4"];

export default class SemanticConnectionsPlugin extends Plugin {
	settings: SemanticConnectionsSettings = DEFAULT_SETTINGS;

	// 存储层
	noteStore!: NoteStore;
	chunkStore!: ChunkStore;
	vectorStore!: VectorStore;

	// Store 持久化
	private indexSnapshotPath: string = "";
	private indexVectorSnapshotPath: string = "";
	private indexSaveTimer: ReturnType<typeof setTimeout> | null = null;
	private indexSaveInProgress: Promise<void> | null = null;
	private indexSavePending = false;
	private indexSnapshotIncompatible = false;

	// 索引层
	private scanner!: Scanner;
	private chunker!: Chunker;
	private reindexService!: ReindexService;
	private reindexQueue!: ReindexQueue;

	// Embedding
	embeddingService!: EmbeddingService;

	// 搜索层
	connectionsService!: ConnectionsService;
	lookupService!: LookupService;

	// 错误日志
	errorLogger!: ErrorLogger;
	runtimeLogger!: RuntimeLogger;

	async onload(): Promise<void> {
		// 加载用户设置
		await this.loadSettings();

		// 初始化所有服务实例（轻量，不做计算）
		this.createServices();
		this.registerGlobalErrorHandlers();

		// 注册视图
		this.registerView(VIEW_TYPE_CONNECTIONS, (leaf) => new ConnectionsView(leaf, this));
		this.registerView(VIEW_TYPE_LOOKUP, (leaf) => new LookupView(leaf, this));

		// 注册命令
		this.addCommand({
			id: "open-connections-view",
			name: "打开关联视图",
			callback: () => this.activateView(VIEW_TYPE_CONNECTIONS),
		});

		this.addCommand({
			id: "open-lookup-view",
			name: "打开语义搜索",
			callback: () => this.activateView(VIEW_TYPE_LOOKUP),
		});

		this.addCommand({
			id: "rebuild-index",
			name: "重建索引",
			callback: () => this.rebuildIndex(),
		});

		this.addCommand({
			id: "show-index-storage-summary",
			name: "显示索引统计",
			callback: () => {
				void this.showIndexStorageSummary();
			},
		});

		this.addCommand({
			id: "clean-local-model-cache",
			name: "清理旧本地模型缓存",
			callback: () => this.cleanOldLocalModelCache(),
		});

		// 注册设置页
		this.addSettingTab(new SettingTab(this.app, this));

		// layout-ready 后执行初始索引和注册文件事件
		this.app.workspace.onLayoutReady(() => {
			void this.onLayoutReady().catch((error) => {
				console.error("Semantic Connections: onLayoutReady failed", error);
				void this.logRuntimeError("on-layout-ready", error, {
					stage: "on-layout-ready",
				});
			});
		});
	}

	onunload(): void {
		this.reindexQueue?.clear();

		// 释放 Embedding Provider 持有的资源（如 LocalProvider 的 ONNX Session）
		if (this.embeddingService) {
			// switchProvider 内部会调用旧 provider 的 dispose
			// 这里直接获取当前 provider 并释放
			const provider = this.embeddingService as unknown as { provider?: { dispose?: () => Promise<void> } };
			if (provider.provider?.dispose) {
				void provider.provider.dispose();
			}
		}

		// 卸载时尽量把最近的增量索引变更落盘（不能 await，做 best-effort）
		this.cancelIndexSaveTimer();
		this.indexSavePending = true;
		void this.flushIndexSave();
		void this.runtimeLogger?.save();
		void this.errorLogger?.save();
	}

	/** 加载设置 */
	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<SemanticConnectionsSettings> &
			Record<string, unknown> | null;
		const loaded = raw ?? {};
		const storedEmbeddingProvider =
			typeof loaded["embeddingProvider"] === "string"
				? String(loaded["embeddingProvider"])
				: undefined;
		const embeddingProvider =
			storedEmbeddingProvider === "mock" || storedEmbeddingProvider === "local"
				? storedEmbeddingProvider
				: DEFAULT_SETTINGS.embeddingProvider;
		const excludedFolders = Array.isArray(loaded.excludedFolders)
			? loaded.excludedFolders.filter((folder): folder is string => typeof folder === "string")
			: DEFAULT_SETTINGS.excludedFolders;
		const localDtype = LOCAL_DTYPES.includes(loaded.localDtype as LocalDtype)
			? (loaded.localDtype as LocalDtype)
			: DEFAULT_SETTINGS.localDtype;

		this.settings = {
			maxConnections:
				typeof loaded.maxConnections === "number"
					? loaded.maxConnections
					: DEFAULT_SETTINGS.maxConnections,
			excludedFolders,
			embeddingProvider,
			autoIndex:
				typeof loaded.autoIndex === "boolean"
					? loaded.autoIndex
					: DEFAULT_SETTINGS.autoIndex,
			autoOpenConnectionsView:
				typeof loaded.autoOpenConnectionsView === "boolean"
					? loaded.autoOpenConnectionsView
					: DEFAULT_SETTINGS.autoOpenConnectionsView,
			localModelId:
				typeof loaded.localModelId === "string" && loaded.localModelId.trim().length > 0
					? loaded.localModelId
					: DEFAULT_SETTINGS.localModelId,
			localDtype,
			forcePluginLocalModelStorage:
				typeof loaded.forcePluginLocalModelStorage === "boolean"
					? loaded.forcePluginLocalModelStorage
					: DEFAULT_SETTINGS.forcePluginLocalModelStorage,
		};
	}

	/** 保存设置 */
	async saveSettings(context: string = "settings"): Promise<void> {
		try {
			await this.saveData(this.settings);
		} catch (error) {
			console.error("Semantic Connections: failed to save settings", context, error);
			if (this.errorLogger) {
				await this.logRuntimeError("save-settings", error, {
					stage: "settings-save",
					errorType: "configuration",
					filePath: `__settings__/${context}`,
					details: [`context=${context}`],
				});
			}
			throw error;
		}
	}

	async logRuntimeError(
		operation: string,
		error: unknown,
		options: RuntimeErrorLogOptions = {},
	): Promise<void> {
		const diagnostic = normalizeErrorDiagnostic(error);
		const provider = options.provider ?? this.settings.embeddingProvider;
		const details = mergeErrorDetails(options.details, diagnostic.details, [
			`operation=${operation}`,
			`provider=${provider}`,
		]);

		await this.errorLogger.logAndSave({
			filePath: options.filePath ?? `__plugin__/${operation}`,
			errorType: options.errorType ?? "runtime",
			message: diagnostic.message,
			provider,
			errorName: diagnostic.name,
			errorCode: diagnostic.code,
			stage: diagnostic.stage ?? options.stage,
			stack: diagnostic.stack,
			details,
		});
	}

	async logRuntimeEvent(
		event: string,
		message: string,
		options: RuntimeEventLogOptions = {},
	): Promise<void> {
		await this.runtimeLogger.logAndSave({
			event,
			level: options.level ?? "info",
			category: options.category ?? "embedding",
			message,
			provider: options.provider ?? this.settings.embeddingProvider,
			details: options.details,
		});
	}

	getRecentRuntimeLogs(count: number = 50): RuntimeLogEntry[] {
		return this.runtimeLogger.getRecent(count);
	}

	async clearRuntimeLogs(): Promise<void> {
		try {
			await this.runtimeLogger.clear();
			if (this.runtimeLogger.isDirty) {
				throw new Error("Runtime log clear was not persisted.");
			}
		} catch (error) {
			await this.logRuntimeError("clear-runtime-logs", error, {
				stage: "runtime-log-clear",
				errorType: "storage",
				filePath: "__runtime__/runtime-log",
			});
			throw error;
		}
	}

	async clearErrorLogs(): Promise<void> {
		try {
			await this.errorLogger.clear();
			if (this.errorLogger.isDirty) {
				throw new Error("Error log clear was not persisted.");
			}
		} catch (error) {
			await this.logRuntimeEvent(
				"error-log-clear-failed",
				"错误日志清空失败，请检查插件目录写入权限。",
				{
					level: "warn",
					category: "storage",
					details: [
						"log=error",
						error instanceof Error ? `cause=${error.message}` : `cause=${String(error)}`,
					],
				},
			);
			throw error;
		}
	}

	private registerGlobalErrorHandlers(): void {
		if (typeof window === "undefined") {
			return;
		}

		this.registerDomEvent(window, "error", (event: ErrorEvent) => {
			if (!this.isPluginRelatedRuntimeValue(event.error ?? event.message ?? event.filename)) {
				return;
			}

			void this.logRuntimeError("window-error", event.error ?? event.message, {
				stage: "window-error",
				details: [
					event.filename ? `filename=${event.filename}` : undefined,
					typeof event.lineno === "number" ? `line=${event.lineno}` : undefined,
					typeof event.colno === "number" ? `column=${event.colno}` : undefined,
				].filter((item): item is string => Boolean(item)),
			});
		});

		this.registerDomEvent(window, "unhandledrejection", (event: PromiseRejectionEvent) => {
			if (!this.isPluginRelatedRuntimeValue(event.reason)) {
				return;
			}

			void this.logRuntimeError("unhandled-rejection", event.reason, {
				stage: "unhandled-rejection",
			});
		});
	}

	private isPluginRelatedRuntimeValue(value: unknown): boolean {
		const text =
			value instanceof Error
				? `${value.name} ${value.message} ${value.stack ?? ""}`
				: typeof value === "string"
					? value
					: value && typeof value === "object"
						? JSON.stringify(value)
						: String(value ?? "");
		const normalized = text.toLowerCase();
		return [
			"semantic connections",
			"semantic-connections",
			"local-model",
			"embeddingservice",
			"reindexservice",
			"lookupview",
			"connectionsview",
			this.manifest.id.toLowerCase(),
		].some((token) => normalized.includes(token));
	}

	/**
	 * 创建所有服务实例
	 * 只做实例化和依赖注入，不执行任何 IO 或计算
	 */
	private createServices(): void {
		this.indexSnapshotPath = this.getPluginDataPath("index-store.json");
		this.indexVectorSnapshotPath = this.getPluginDataPath("index-vectors.bin");

		// 错误日志
		const logPath = this.getPluginDataPath("error-log.json");
		this.errorLogger = new ErrorLogger(this.app.vault.adapter, logPath);
		const runtimeLogPath = this.getPluginDataPath("runtime-log.json");
		this.runtimeLogger = new RuntimeLogger(this.app.vault.adapter, runtimeLogPath);

		// 存储层
		this.noteStore = new NoteStore();
		this.chunkStore = new ChunkStore();
		this.vectorStore = new VectorStore();

		// 索引层
		this.scanner = new Scanner(this.app.vault, this.app.metadataCache);
		this.chunker = new Chunker();
		const adapterWithBasePath = this.app.vault.adapter as typeof this.app.vault.adapter & {
			getBasePath?: () => string;
		};
		const vaultBasePath = adapterWithBasePath.getBasePath?.() ?? "";
		const normalizedConfigDir = this.app.vault.configDir.replace(/\//g, "\\");
		const pluginBasePath = vaultBasePath
			? `${vaultBasePath.replace(/[\\/]+$/, "")}\\${normalizedConfigDir}\\plugins\\${this.manifest.id}`
			: "";

		this.embeddingService = new EmbeddingService(
			this.settings,
			`${this.app.vault.configDir}/plugins/${this.manifest.id}`,
			pluginBasePath,
			pluginBasePath ? `${pluginBasePath}\\local-model-worker.js` : "",
			pluginBasePath ? `${pluginBasePath}\\local-model-web-worker.js` : "",
			(event) => {
				void this.handleLocalRuntimeEvent(event);
			},
		);

		this.reindexService = new ReindexService(
			this.app.vault,
			this.scanner,
			this.chunker,
			this.embeddingService,
			this.noteStore,
			this.chunkStore,
			this.vectorStore,
			this.errorLogger,
		);

		this.reindexQueue = new ReindexQueue();
		this.reindexQueue.setExecutor(async (task) => {
			try {
				await this.reindexService.processTask(task);
			} finally {
				// 增量索引是零散的：用 debounce 合并持久化写入，避免频繁写大 JSON
				this.scheduleIndexSave();
			}
		});

		// 搜索层
		this.connectionsService = new ConnectionsService(
			this.noteStore,
			this.chunkStore,
			this.vectorStore,
		);

		this.lookupService = new LookupService(
			this.noteStore,
			this.chunkStore,
			this.vectorStore,
			this.embeddingService,
		);
	}

	/**
	 * layout-ready 后执行
	 * - 加载错误日志并执行月度清理
	 * - 注册文件变更事件
	 * - 如果从未索引过，触发全量索引
	 */
	private async onLayoutReady(): Promise<void> {
		// 加载错误日志 + 月度清理（30 天前的条目自动删除）
		await this.errorLogger.load();
		await this.errorLogger.cleanupIfNeeded();
		await this.runtimeLogger.load();
		await this.runtimeLogger.cleanupIfNeeded();
		await this.logRuntimeEvent(
			"startup-sequence-started",
			"插件启动流程已进入 layout-ready 阶段。",
			{
				category: "lifecycle",
			},
		);
		await this.cleanOldLocalModelCacheSilently();

		// 尝试从磁盘恢复上次的索引（避免每次启动都全量重建）
		await this.loadIndexSnapshot();

		// 注册文件变更事件（增量索引）
		this.registerFileEvents();
		if (this.settings.autoOpenConnectionsView) {
			await this.ensureViewOpen(VIEW_TYPE_CONNECTIONS);
			await this.logRuntimeEvent(
				"connections-view-auto-opened",
				"启动时已自动打开关联视图。",
				{
					category: "lifecycle",
				},
			);
		}

		// 检查是否需要全量索引
		if (this.noteStore.size === 0) {
			// 索引快照存在但与当前 Embedding 配置不兼容时，不自动重建，避免产生意外结果。
			if (this.indexSnapshotIncompatible) {
				new Notice("索引与当前 Embedding 配置不兼容，请手动执行「重建索引」。", 8000);
			} else if (this.settings.embeddingProvider === "local") {
				new Notice("当前使用本地模型且索引为空。请先在设置页点击“下载本地模型”，再手动执行“重建索引”。", 8000);
				await this.logRuntimeEvent(
					"startup-auto-rebuild-skipped",
					"已跳过启动时自动重建，因为本地模型下载需要用户手动触发。",
					{
						category: "lifecycle",
						provider: "local",
					},
				);
			} else {
				// mock 和 local 都可以直接开始索引
				// local 会在首次 embed 时触发模型下载
				await this.rebuildIndex();
			}
		}

		await this.logRuntimeEvent("plugin-ready", "插件启动完成。", {
			category: "lifecycle",
		});
		console.log("Semantic Connections: ready");
	}

	private async handleLocalRuntimeEvent(event: LocalProviderRuntimeEvent): Promise<void> {
		await this.logRuntimeEvent(event.event, event.message, {
			level: event.level ?? "info",
			category: "embedding",
			provider: "local",
			details: [`mode=${event.mode}`, ...(event.details ?? [])],
		});
	}

	/**
	 * 注册文件变更事件
	 * 通过 registerEvent 确保插件卸载时自动清理
	 */
	private registerFileEvents(): void {
		// 文件创建
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (!this.settings.autoIndex) return;
				if (!(file instanceof TFile) || file.extension !== "md") return;
				if (this.isExcludedPath(file.path)) return;
				this.reindexQueue.enqueue({ type: "create", path: file.path });
			}),
		);

		// 文件修改
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (!this.settings.autoIndex) return;
				if (!(file instanceof TFile) || file.extension !== "md") return;
				if (this.isExcludedPath(file.path)) return;
				this.reindexQueue.enqueue({ type: "modify", path: file.path });
			}),
		);

		// 文件删除
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (!this.settings.autoIndex) return;
				if (!(file instanceof TFile) || file.extension !== "md") return;
				// delete 需要清理索引：即使该文件位于 excludedFolders，也可能残留旧索引
				this.reindexQueue.enqueue({ type: "delete", path: file.path });
			}),
		);

		// 文件重命名
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (!this.settings.autoIndex) return;

				const newPath = file.path;
				const oldIsMd = this.isMarkdownPath(oldPath);
				const newIsMd = this.isMarkdownPath(newPath);

				// .md → 非 .md：移除旧索引
				if (oldIsMd && !newIsMd) {
					this.reindexQueue.enqueue({ type: "delete", path: oldPath });
					return;
				}

				// 非 .md → .md：等价于创建新索引（oldPath 不存在于索引中也无妨）
				if (!oldIsMd && newIsMd) {
					if (!this.isExcludedPath(newPath)) {
						this.reindexQueue.enqueue({ type: "create", path: newPath });
					}
					return;
				}

				// 都不是 .md：忽略
				if (!oldIsMd && !newIsMd) return;

				// .md → .md：如果新路径在 excludedFolders 中，则删除旧索引并跳过
				if (this.isExcludedPath(newPath)) {
					this.reindexQueue.enqueue({ type: "delete", path: oldPath });
					return;
				}

				// 从 excludedFolders 移出：老路径可能没索引，安全起见先删再建
				if (this.isExcludedPath(oldPath) && !this.isExcludedPath(newPath)) {
					this.reindexQueue.enqueue({ type: "delete", path: oldPath });
					this.reindexQueue.enqueue({ type: "create", path: newPath });
					return;
				}

				this.reindexQueue.enqueue({ type: "rename", path: newPath, oldPath });
			}),
		);
	}

	/** 是否是 Markdown 文件路径（用于 rename oldPath/newPath 的字符串判断） */
	private isMarkdownPath(path: string): boolean {
		return path.toLowerCase().endsWith(".md");
	}

	/** 是否在排除文件夹内（逻辑与 Scanner.getMarkdownFiles 保持一致） */
	private isExcludedPath(path: string): boolean {
		return this.settings.excludedFolders.some((folder) =>
			path.startsWith(folder + "/") || path === folder
		);
	}

	/**
	 * 激活指定类型的视图
	 * 如果已存在则聚焦，否则在右侧创建新叶子
	 */
	private async ensureViewOpen(viewType: string, options?: { reveal?: boolean }): Promise<void> {
		const { workspace } = this.app;
		const reveal = options?.reveal ?? false;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(viewType);
		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: viewType, active: true });
			}
		}

		if (leaf && reveal) {
			workspace.revealLeaf(leaf);
		}
	}

	async activateView(viewType: string): Promise<void> {
		await this.ensureViewOpen(viewType, { reveal: true });
	}

	/**
	 * 重建全量索引
	 *
	 * indexAll 返回 IndexSummary（total + failed），
	 * 即使部分文件失败也不会中断整个流程。
	 */
	/** 是否正在执行全量重建（防止设置页按钮重复触发） */
	isRebuilding = false;

	async rebuildIndex(options?: RebuildIndexOptions): Promise<void> {
		if (this.isRebuilding) return;
		this.isRebuilding = true;
		// 进入重建流程说明用户已明确要生成新索引
		this.indexSnapshotIncompatible = false;
		const emitProgress = (progress: RebuildIndexProgress): void => {
			options?.onProgress?.(progress);
		};
		let removeProgressListener: (() => void) | undefined;

		const notice = new Notice("正在构建语义索引...", 0);

		try {
			await this.logRuntimeEvent("rebuild-index-started", "已开始全量重建索引。", {
				category: "indexing",
			});
			// 清空旧错误日志：新一轮重建后日志应只包含本次结果
			if (this.settings.embeddingProvider === "local") {
				const checkingMessage = "正在检查本地模型状态...";
				notice.setMessage(checkingMessage);
				emitProgress({
					stage: "checking-local-model",
					message: checkingMessage,
					percent: 0,
				});

				const localModelReady = await this.embeddingService.ensureLocalModelReady();
				if (!localModelReady.ok) {
					throw new Error(
						`本地模型尚未就绪。请先在设置页点击“下载本地模型”。${localModelReady.error ? ` ${localModelReady.error}` : ""}`,
					);
				}
			}

			await this.errorLogger.clear();

			// Full rebuild: clear existing index data first.
			this.noteStore.clear();
			this.chunkStore.clear();
			this.vectorStore.clear();

			// 设置模型下载进度监听（LocalProvider 首次加载时需要下载模型文件）
			removeProgressListener = this.embeddingService.addProgressListener((info: LocalModelProgress) => {
				if ((info.status === "download" || info.status === "progress") && info.file) {
					const percent = Math.max(0, Math.round(info.progress ?? 0));
					const message =
						info.status === "progress"
							? `正在下载本地模型：${info.file} (${percent}%)`
							: `正在下载本地模型：${info.file}`;
					emitProgress({
						stage: "model-download",
						message,
						percent,
						file: info.file,
					});
					notice.setMessage(message);
					return;
				}

				if (info.status === "ready" || info.status === "done") {
					const message = "本地模型已就绪，开始构建索引...";
					emitProgress({
						stage: "model-ready",
						message,
						percent: 100,
					});
					notice.setMessage(message);
					return;
				}

				if (info.status === "warmup") {
					const message = "正在预热本地模型...";
					emitProgress({
						stage: "model-warmup",
						message,
						percent: 100,
					});
					notice.setMessage(message);
				}
			});

			const { total, failed } = await this.reindexService.indexAll(
				this.settings.excludedFolders,
				(done, total) => {
					const percent = total > 0 ? Math.round((done / total) * 100) : 100;
					const message =
						total > 0
							? `正在构建语义索引... (${done}/${total})`
							: "未发现需要索引的笔记";
					emitProgress({
						stage: "indexing",
						message,
						done,
						total,
						percent,
					});
					notice.setMessage(`正在构建语义索引... (${done}/${total})`);
				},
			);

			// 全量索引结束后落盘（即使部分文件失败，也保留已成功的结果）
			emitProgress({
				stage: "saving",
				message: "正在保存索引到磁盘...",
				percent: 100,
			});
			notice.setMessage("正在保存索引到磁盘...");
			await this.saveIndexSnapshot();

			if (failed > 0) {
				const message = `索引完成：${this.noteStore.size} 篇笔记（${failed} 篇失败，详见错误日志）`;
				emitProgress({
					stage: "success",
					message,
					percent: 100,
					failed,
					indexedNotes: this.noteStore.size,
				});
				notice.setMessage(message);
				await this.logRuntimeEvent(
					"rebuild-index-finished",
					"全量重建索引完成，但有部分失败。",
					{
						category: "indexing",
						details: [
							`indexed_notes=${this.noteStore.size}`,
							`failed=${failed}`,
							`total=${total}`,
						],
					},
				);
				setTimeout(() => notice.hide(), 5000);
			} else {
				const message = `索引完成：${this.noteStore.size} 篇笔记`;
				emitProgress({
					stage: "success",
					message,
					percent: 100,
					failed: 0,
					indexedNotes: this.noteStore.size,
				});
				notice.setMessage(message);
				await this.logRuntimeEvent(
					"rebuild-index-finished",
					"全量重建索引完成。",
					{
						category: "indexing",
						details: [
							`indexed_notes=${this.noteStore.size}`,
							`failed=0`,
							`total=${total}`,
						],
					},
				);
				setTimeout(() => notice.hide(), 3000);
			}
		} catch (err) {
			const diagnostic = normalizeErrorDiagnostic(err);
			const message = `重建索引失败：${diagnostic.message}`;
			emitProgress({
				stage: "error",
				message,
				percent: 0,
			});
			notice.setMessage(message);
			console.error("Semantic Connections: rebuild index failed", err);
			await this.logRuntimeEvent("rebuild-index-finished", message, {
				level: "warn",
				category: "indexing",
			});
			await this.logRuntimeError("rebuild-index", err, {
				stage: diagnostic.stage ?? "rebuild-index",
			});
			setTimeout(() => notice.hide(), 5000);
		} finally {
			removeProgressListener?.();
			this.isRebuilding = false;
		}
	}

	/** 插件私有数据目录下的文件路径（相对于 vault 根目录） */
	private getPluginDataPath(filename: string): string {
		return `${this.app.vault.configDir}/plugins/${this.manifest.id}/${filename}`;
	}

	private formatByteSize(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes <= 0) {
			return "0 B";
		}

		const units = ["B", "KB", "MB", "GB"];
		let value = bytes;
		let unitIndex = 0;
		while (value >= 1024 && unitIndex < units.length - 1) {
			value /= 1024;
			unitIndex++;
		}

		return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
	}

	async getIndexStorageSummary(): Promise<IndexStorageSummary> {
		const adapter = this.app.vault.adapter;
		const breakdown = this.vectorStore.getBreakdown();
		const jsonStat = this.indexSnapshotPath
			? await adapter.stat(this.indexSnapshotPath).catch(() => null)
			: null;
		const binaryStat = this.indexVectorSnapshotPath
			? await adapter.stat(this.indexVectorSnapshotPath).catch(() => null)
			: null;
		const rawParts = [
			jsonStat?.type === "file"
				? {
					label: "index-store.json",
					path: this.indexSnapshotPath,
					bytes: jsonStat.size,
				}
				: undefined,
			binaryStat?.type === "file"
				? {
					label: "index-vectors.bin",
					path: this.indexVectorSnapshotPath,
					bytes: binaryStat.size,
				}
				: undefined,
		].filter(
			(part): part is { label: string; path: string; bytes: number } => Boolean(part),
		);
		const totalBytes = rawParts.reduce((sum, part) => sum + part.bytes, 0);
		const parts = rawParts.map((part) => ({
			...part,
			share: totalBytes > 0 ? part.bytes / totalBytes : 0,
		}));

		return {
			noteCount: this.noteStore.size,
			chunkCount: this.chunkStore.size,
			vectorCount: breakdown.vectorCount,
			noteVectorCount: breakdown.noteVectorCount,
			chunkVectorCount: breakdown.chunkVectorCount,
			embeddingDimension: breakdown.dimension,
			snapshotFormat:
				binaryStat?.type === "file"
					? "json+binary"
					: jsonStat?.type === "file"
						? "json-only"
						: "missing",
			parts,
			totalBytes,
		};
	}

	async showIndexStorageSummary(): Promise<void> {
		try {
		const summary = await this.getIndexStorageSummary();
		const lines = [
			`索引统计：${summary.noteCount} 篇笔记，${summary.chunkCount} 个语义块，${summary.vectorCount} 个向量`,
			`向量细分：note=${summary.noteVectorCount}，chunk=${summary.chunkVectorCount}，dimension=${summary.embeddingDimension}`,
			`快照格式：${summary.snapshotFormat}`,
		];

		if (summary.parts.length > 0) {
			lines.push(
				`总占用：${this.formatByteSize(summary.totalBytes)}`,
				...summary.parts.flatMap((part) => [
					`${part.label}: ${this.formatByteSize(part.bytes)} (${(part.share * 100).toFixed(1)}%)`,
					`路径：${part.path}`,
				]),
			);
		} else {
			lines.push("尚未检测到已落盘的索引快照文件。");
		}

		new Notice(lines.join("\n"), 12000);
		console.info("Semantic Connections index storage summary\n" + lines.join("\n"));
		} catch (error) {
			new Notice("读取索引存储统计失败，请查看错误日志。", 6000);
			await this.logRuntimeError("show-index-storage-summary", error, {
				stage: "index-storage-summary",
				errorType: "storage",
				filePath: this.indexSnapshotPath || "__plugin__/index-storage-summary",
				details: [
					this.indexVectorSnapshotPath
						? `vector_binary_path=${this.indexVectorSnapshotPath}`
						: undefined,
				].filter((item): item is string => Boolean(item)),
			});
			console.error("Semantic Connections: failed to show index storage summary", error);
		}
	}

	private async loadIndexSnapshot(): Promise<void> {
		if (!this.indexSnapshotPath) return;

		try {
			if (!(await this.app.vault.adapter.exists(this.indexSnapshotPath))) return;

			const raw = await this.app.vault.adapter.read(this.indexSnapshotPath);
			const snapshot = JSON.parse(raw) as {
				version: number;
				savedAt?: number;
				embeddingProvider?: string;
				embeddingDimension?: number;
				localModelId?: string;
				localDtype?: string;
				vectorBinaryPath?: string;
				noteStore?: unknown;
				chunkStore?: unknown;
				vectorStore?: unknown;
			};

			if (!snapshot || typeof snapshot !== "object") {
				throw new Error("Index snapshot payload is invalid.");
			}
			if (snapshot.version !== 1 && snapshot.version !== 2) {
				throw new Error(`Unsupported index snapshot version: ${String(snapshot.version)}`);
			}
			const missingStores = ["noteStore", "chunkStore", "vectorStore"].filter((key) => {
				const value = snapshot[key as keyof typeof snapshot];
				return value === undefined || value === null;
			});
			if (missingStores.length > 0) {
				throw new Error(`Index snapshot is incomplete: ${missingStores.join(", ")}`);
			}

			// 快照与当前 embedding 配置不兼容时，拒绝加载，避免产生“随机召回”等异常结果
			const providerMismatch =
				snapshot.embeddingProvider &&
				snapshot.embeddingProvider !== this.settings.embeddingProvider;

			const modelMismatch =
				this.settings.embeddingProvider === "local"
					? (snapshot.localModelId &&
							snapshot.localModelId !== this.settings.localModelId) ||
						(snapshot.localDtype &&
							snapshot.localDtype !== this.settings.localDtype)
					: false;

			const dimensionMismatch =
				typeof snapshot.embeddingDimension === "number" &&
				snapshot.embeddingDimension > 0 &&
				this.embeddingService.dimension > 0 &&
				snapshot.embeddingDimension !== this.embeddingService.dimension;

			if (providerMismatch || modelMismatch || dimensionMismatch) {
				this.indexSnapshotIncompatible = true;
				new Notice(
					"检测到索引快照与当前 Embedding 配置不兼容：已跳过加载。请手动执行「重建索引」。",
					8000,
				);
				return;
			}

			this.noteStore.load(snapshot.noteStore);
			this.chunkStore.load(snapshot.chunkStore);
			if (snapshot.version === 2) {
				const vectorBinaryPath =
					typeof snapshot.vectorBinaryPath === "string" && snapshot.vectorBinaryPath.length > 0
						? snapshot.vectorBinaryPath
						: this.indexVectorSnapshotPath;
				if (!(await this.app.vault.adapter.exists(vectorBinaryPath))) {
					throw new Error(`Vector snapshot binary is missing: ${vectorBinaryPath}`);
				}
				const binary = await this.app.vault.adapter.readBinary(vectorBinaryPath);
				this.vectorStore.loadBinary(snapshot.vectorStore, binary);
			} else {
				this.vectorStore.load(snapshot.vectorStore);
			}
			await this.logRuntimeEvent(
				"index-snapshot-loaded",
				"已从磁盘恢复索引快照。",
				{
					category: "storage",
					details: [
						`notes=${this.noteStore.size}`,
						`chunks=${this.chunkStore.size}`,
						`vectors=${this.vectorStore.size}`,
					],
				},
			);

			console.log(
				`Semantic Connections: index loaded (notes=${this.noteStore.size}, chunks=${this.chunkStore.size}, vectors=${this.vectorStore.size})`,
			);
		} catch (err) {
			this.noteStore.clear();
			this.chunkStore.clear();
			this.vectorStore.clear();
			await this.logRuntimeError("load-index-snapshot", err, {
				stage: "index-snapshot-load",
				errorType: "storage",
				filePath: this.indexSnapshotPath,
			});
			console.warn("Semantic Connections: failed to load index snapshot, starting fresh", err);
		}
	}

	private async saveIndexSnapshot(): Promise<void> {
		if (!this.indexSnapshotPath || !this.indexVectorSnapshotPath) return;

		const replaceTextFile = async (path: string, contents: string): Promise<void> => {
			const tmpPath = path + ".tmp";
			await this.app.vault.adapter.write(tmpPath, contents);
			try {
				await this.app.vault.adapter.rename(tmpPath, path);
			} catch {
				if (await this.app.vault.adapter.exists(path)) {
					await this.app.vault.adapter.remove(path);
				}
				await this.app.vault.adapter.rename(tmpPath, path);
			}
		};

		const replaceBinaryFile = async (path: string, contents: ArrayBuffer): Promise<void> => {
			const tmpPath = path + ".tmp";
			await this.app.vault.adapter.writeBinary(tmpPath, contents);
			try {
				await this.app.vault.adapter.rename(tmpPath, path);
			} catch {
				if (await this.app.vault.adapter.exists(path)) {
					await this.app.vault.adapter.remove(path);
				}
				await this.app.vault.adapter.rename(tmpPath, path);
			}
		};

		try {
			const vectorSnapshot = this.vectorStore.serializeBinary();
			const snapshot = {
				version: 2,
				savedAt: Date.now(),
				embeddingProvider: this.settings.embeddingProvider,
				embeddingDimension: this.embeddingService.dimension,
				localModelId:
					this.settings.embeddingProvider === "local"
						? this.settings.localModelId
						: undefined,
				localDtype:
					this.settings.embeddingProvider === "local"
						? this.settings.localDtype
						: undefined,
				vectorBinaryPath: this.indexVectorSnapshotPath,
				noteStore: this.noteStore.serialize(),
				chunkStore: this.chunkStore.serialize(),
				vectorStore: vectorSnapshot.metadata,
			};

			const serialized = JSON.stringify(snapshot, null, 2);
			await replaceBinaryFile(this.indexVectorSnapshotPath, vectorSnapshot.buffer);
			await replaceTextFile(this.indexSnapshotPath, serialized);
		} catch (err) {
			await this.logRuntimeError("save-index-snapshot", err, {
				stage: "index-snapshot-save",
				errorType: "storage",
				filePath: this.indexSnapshotPath,
				details: [`vector_binary_path=${this.indexVectorSnapshotPath}`],
			});
			console.error("Semantic Connections: failed to save index snapshot", err);
		}
	}

	private getPathBasename(path: string): string {
		const normalized = path.replace(/\\/g, "/");
		const segments = normalized.split("/");
		return segments[segments.length - 1] || normalized;
	}

	private async getOldLocalCacheDirectories(): Promise<{
		modelsRoot: string;
		currentCache: string;
		staleCaches: string[];
	}> {
		const adapter = this.app.vault.adapter;
		const modelsRoot = this.getPluginDataPath("models");
		const currentCache = this.embeddingService.getLocalModelCachePath();
		if (!(await adapter.exists(modelsRoot))) {
			return {
				modelsRoot,
				currentCache,
				staleCaches: [],
			};
		}

		const list = await adapter.list(modelsRoot);
		const staleCaches = list.folders.filter((path) => {
			const baseName = this.getPathBasename(path);
			return /^cache-v/i.test(baseName) && path !== currentCache;
		});

		return {
			modelsRoot,
			currentCache,
			staleCaches,
		};
	}

	private async cleanOldLocalModelCacheSilently(): Promise<void> {
		try {
			const adapter = this.app.vault.adapter;
			const { staleCaches } = await this.getOldLocalCacheDirectories();
			if (staleCaches.length === 0) {
				return;
			}

			let removed = 0;
			for (const folder of staleCaches) {
				try {
					await adapter.rmdir(folder, true);
					removed++;
				} catch (error) {
					await this.logRuntimeError("clean-old-local-model-cache-silent-item", error, {
						stage: "local-cache-cleanup-silent:item",
						errorType: "storage",
						filePath: folder,
						provider: "local",
						details: [`folder=${folder}`],
					});
					console.warn("Semantic Connections: failed to remove old cache folder", folder, error);
				}
			}

			if (removed > 0) {
				await this.logRuntimeEvent(
					"old-local-model-cache-cleaned",
					"启动时已清理旧版本本地模型缓存目录。",
					{
						category: "storage",
						provider: "local",
						details: [`removed=${removed}`],
					},
				);
			}
		} catch (error) {
			await this.logRuntimeError("clean-old-local-model-cache-silent", error, {
				stage: "local-cache-cleanup-silent",
				errorType: "storage",
			});
		}
	}

	/**
	 * 清理旧的本地模型缓存（保留当前版本缓存目录）
	 */
	private async cleanOldLocalModelCache(): Promise<void> {
		const notice = new Notice("正在清理旧模型缓存...", 0);
		const adapter = this.app.vault.adapter;

		try {
			const { modelsRoot, staleCaches } = await this.getOldLocalCacheDirectories();
			if (!(await adapter.exists(modelsRoot))) {
				notice.setMessage("未发现模型缓存目录，无需清理。");
				setTimeout(() => notice.hide(), 2500);
				return;
			}

			let removedFolders = 0;
			for (const folder of staleCaches) {
				try {
					await adapter.rmdir(folder, true);
					removedFolders++;
				} catch (err) {
					await this.logRuntimeError("clean-old-local-model-cache-item", err, {
						stage: "local-cache-cleanup:item",
						errorType: "storage",
						filePath: folder,
						provider: "local",
						details: [`folder=${folder}`],
					});
					console.warn("Semantic Connections: failed to remove cache folder", folder, err);
				}
			}

			if (removedFolders === 0) {
				notice.setMessage("未发现旧缓存，无需清理。");
			} else {
				notice.setMessage(`清理完成：移除 ${removedFolders} 个旧缓存目录。`);
				await this.logRuntimeEvent(
					"old-local-model-cache-cleaned",
					"已通过命令清理旧版本本地模型缓存目录。",
					{
						category: "storage",
						provider: "local",
						details: [`removed=${removedFolders}`],
					},
				);
			}
			setTimeout(() => notice.hide(), 3000);
		} catch (err) {
			notice.setMessage("清理失败，请查看控制台。");
			notice.setMessage("清理失败，请查看错误日志。");
			await this.logRuntimeError("clean-old-local-model-cache", err, {
				stage: "local-cache-cleanup",
				errorType: "storage",
			});
			console.error("Semantic Connections: clean cache failed", err);
			setTimeout(() => notice.hide(), 4000);
		}
	}

	private scheduleIndexSave(): void {
		this.indexSavePending = true;
		this.cancelIndexSaveTimer();

		// 写入可能很大：等增量索引稳定一段时间再落盘
		this.indexSaveTimer = setTimeout(() => {
			void this.flushIndexSave();
		}, 10_000);
	}

	private cancelIndexSaveTimer(): void {
		if (this.indexSaveTimer) {
			clearTimeout(this.indexSaveTimer);
			this.indexSaveTimer = null;
		}
	}

	private async flushIndexSave(): Promise<void> {
		if (!this.indexSavePending) return;

		if (this.indexSaveInProgress) {
			await this.indexSaveInProgress;
			return;
		}

		this.indexSaveInProgress = (async () => {
			while (this.indexSavePending) {
				this.indexSavePending = false;
				await this.saveIndexSnapshot();
			}
		})();

		try {
			await this.indexSaveInProgress;
		} finally {
			this.indexSaveInProgress = null;
		}
	}
}
