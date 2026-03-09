import type { ErrorDiagnostic, Vector } from "../types";
import type { SemanticConnectionsSettings } from "../types";
import { normalizeErrorDiagnostic } from "../utils/error-utils";
import type { EmbeddingProvider } from "./provider";
import { MockProvider } from "./mock-provider";
import { LocalProvider, SUPPORTED_LOCAL_MODELS } from "./local-provider";
import { RemoteProvider } from "./remote-provider";
import type { LocalModelProgress, LocalProviderRuntimeEvent } from "./local-provider";

const LOCAL_MODEL_CACHE_VERSION = 2;
const TRANSFORMERS_JS_VERSION = "3.8.1";

type ServiceOperationFailure = {
	ok: false;
	error: string;
	diagnostic: ErrorDiagnostic;
};

type ServiceOperationSuccess<T> = { ok: true } & T;

export class EmbeddingService {
	private provider: EmbeddingProvider;
	private pluginDataPath: string;
	private pluginBasePath: string;
	private localWorkerScriptPath: string;
	private localWebWorkerScriptPath: string;
	private readonly progressListeners = new Set<(progress: LocalModelProgress) => void>();
	private localRuntimeEventListener?: (event: LocalProviderRuntimeEvent) => void;

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

	getLocalModelCachePath(): string {
		const base = this.pluginDataPath ? `${this.pluginDataPath}/models` : "./models";
		return `${base}/cache-v${LOCAL_MODEL_CACHE_VERSION}-tf${TRANSFORMERS_JS_VERSION}`;
	}

	getAbsoluteLocalModelCachePath(): string {
		const relativeCachePath = this.getLocalModelCachePath().replace(/\//g, "\\");
		if (!this.pluginBasePath) {
			return relativeCachePath;
		}

		return `${this.pluginBasePath}\\models\\cache-v${LOCAL_MODEL_CACHE_VERSION}-tf${TRANSFORMERS_JS_VERSION}`;
	}

	get providerName(): string {
		return this.provider.name;
	}

	get dimension(): number {
		return this.provider.dimension;
	}

	async embed(text: string): Promise<Vector> {
		return this.provider.embed(text);
	}

	async embedBatch(texts: string[]): Promise<Vector[]> {
		return this.provider.embedBatch(texts);
	}

	switchProvider(settings: SemanticConnectionsSettings): void {
		if (this.provider.dispose) {
			void this.provider.dispose();
		}

		this.settings = settings;
		this.provider = this.createProvider(settings);
	}

	async disposeCurrentProvider(): Promise<void> {
		if (this.provider.dispose) {
			await this.provider.dispose();
		}
	}

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
		const modelInfo = SUPPORTED_LOCAL_MODELS.find((model) => model.id === this.settings.localModelId);
		return new LocalProvider({
			modelId: this.settings.localModelId,
			dimension: modelInfo?.dimension ?? 384,
			cachePath: this.getAbsoluteLocalModelCachePath(),
			dtype: this.settings.localDtype,
			allowRemoteModels: options?.allowRemoteModels ?? false,
			workerScriptPath: this.localWorkerScriptPath,
			webWorkerScriptPath: this.localWebWorkerScriptPath,
			preferFileSystemCache: this.settings.forcePluginLocalModelStorage,
			onProgress: (info) => {
				if (options?.broadcastProgress ?? true) {
					this.emitProgress(info);
				}
				options?.onProgress?.(info);
			},
			onRuntimeEvent: (event) => this.localRuntimeEventListener?.(event),
		});
	}

	private createRemoteProvider(settings: SemanticConnectionsSettings): RemoteProvider {
		return new RemoteProvider({
			baseUrl: settings.remoteBaseUrl,
			apiKey: settings.remoteApiKey,
			model: settings.remoteModel,
			timeoutMs: settings.remoteTimeoutMs,
			batchSize: settings.remoteBatchSize,
		});
	}

	private createProvider(settings: SemanticConnectionsSettings): EmbeddingProvider {
		switch (settings.embeddingProvider) {
			case "local":
				return this.createLocalProvider();
			case "remote":
				return this.createRemoteProvider(settings);
			case "mock":
			default:
				return new MockProvider();
		}
	}
}
