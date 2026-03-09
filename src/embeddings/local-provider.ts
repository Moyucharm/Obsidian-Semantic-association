import { readFileSync } from "fs";
import { pathToFileURL } from "url";
import { Worker } from "worker_threads";
import type { ErrorDiagnostic, Vector } from "../types";
import {
	createErrorFromDiagnostic,
	mergeErrorDetails,
	normalizeErrorDiagnostic,
} from "../utils/error-utils";
import type { EmbeddingProvider } from "./provider";
import type {
	LocalWorkerRequest,
	LocalWorkerResponse,
	LocalWorkerSuccessPayload,
} from "./local-worker-protocol";
import {
	SUPPORTED_LOCAL_MODELS,
	type LocalModelInfo,
	type LocalModelProgress,
	type LocalProviderConfig,
	type LocalProviderRuntimeEvent,
	type LocalRuntimeConfig,
	type LocalRuntimeMode,
} from "./local-model-shared";

type LocalRuntimeRequest =
	| { type: "prepare" }
	| { type: "embed"; text: string }
	| { type: "embedBatch"; texts: string[] }
	| { type: "dispose" };

type LocalWorkerOutboundRequest =
	| { type: "configure"; config: LocalRuntimeConfig }
	| LocalRuntimeRequest;

type PendingRequest = {
	resolve: (payload: LocalWorkerSuccessPayload) => void;
	reject: (error: Error) => void;
};

type LocalExecutionMode = "worker" | "web-worker" | "inline";

type WebWorkerLike = {
	postMessage(message: unknown): void;
	terminate(): void;
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
};

type WebWorkerConstructor = new (url: string) => WebWorkerLike;

type WebWorkerLaunchTarget = {
	url: string;
	details: string[];
	cleanupOnFailure: () => void;
};

type InlineRuntimeController = {
	handleRequest(request: LocalWorkerRequest): Promise<LocalWorkerSuccessPayload>;
	dispose(): Promise<void>;
};

type InlineRuntimeModule = {
	createLocalRuntimeController?: (
		onProgress?: (progress: LocalModelProgress) => void,
	) => InlineRuntimeController;
};

export {
	SUPPORTED_LOCAL_MODELS,
	type LocalModelInfo,
	type LocalModelProgress,
	type LocalProviderConfig,
	type LocalProviderRuntimeEvent,
} from "./local-model-shared";

export class LocalProvider implements EmbeddingProvider {
	readonly name = "local";

	private _dimension: number;
	private readonly modelId: string;
	private readonly dtype: string;
	private readonly cachePath: string;
	private allowRemoteModels: boolean;
	private readonly workerScriptPath: string;
	private readonly webWorkerScriptPath: string;
	private readonly onProgress?: (progress: LocalModelProgress) => void;
	private readonly onRuntimeEvent?: (event: LocalProviderRuntimeEvent) => void;

	private executionMode: LocalExecutionMode | null = null;
	private worker: Worker | null = null;
	private workerReadyPromise: Promise<void> | null = null;
	private webWorker: WebWorkerLike | null = null;
	private webWorkerReadyPromise: Promise<void> | null = null;
	private webWorkerObjectUrl: string | null = null;
	private webWorkerLaunchDetails: string[] = [];
	private inlineController: InlineRuntimeController | null = null;
	private inlineReadyPromise: Promise<void> | null = null;
	private inlineOperationQueue: Promise<void> = Promise.resolve();
	private inlineFallbackDiagnostic: ErrorDiagnostic | null = null;
	private reportedRuntimeMode: LocalRuntimeMode | null = null;
	private requestId = 0;
	private readonly pendingRequests = new Map<number, PendingRequest>();

	constructor(config: LocalProviderConfig) {
		this.modelId = config.modelId;
		this._dimension = config.dimension;
		this.cachePath = config.cachePath;
		this.dtype = config.dtype ?? "q8";
		this.allowRemoteModels = config.allowRemoteModels ?? false;
		this.workerScriptPath = config.workerScriptPath;
		this.webWorkerScriptPath = config.webWorkerScriptPath;
		this.onProgress = config.onProgress;
		this.onRuntimeEvent = config.onRuntimeEvent;
	}

	get dimension(): number {
		return this._dimension;
	}

	async prepare(): Promise<number> {
		await this.ensureRuntimePolicy(false);
		const payload = await this.request({
			type: "prepare",
		});
		this.applyPayload(payload);
		return this._dimension;
	}

	async downloadAndPrepare(): Promise<number> {
		await this.ensureRuntimePolicy(true);
		const payload = await this.request({
			type: "prepare",
		});
		this.applyPayload(payload);
		return this._dimension;
	}

	async embed(text: string): Promise<Vector> {
		await this.ensureRuntimePolicy(false);
		const payload = await this.request({
			type: "embed",
			text,
		});
		this.applyPayload(payload);
		if (!payload.vector) {
			throw this.createDiagnosticError("Local model runtime returned no vector.", {
				code: "ERR_LOCAL_RUNTIME_EMPTY_VECTOR",
				stage: "embed-response",
			});
		}
		return payload.vector;
	}

	async embedBatch(texts: string[]): Promise<Vector[]> {
		if (texts.length === 0) {
			return [];
		}

		await this.ensureRuntimePolicy(false);
		const payload = await this.request({
			type: "embedBatch",
			texts,
		});
		this.applyPayload(payload);
		if (!payload.vectors) {
			throw this.createDiagnosticError("Local model runtime returned no vectors.", {
				code: "ERR_LOCAL_RUNTIME_EMPTY_BATCH",
				stage: "embed-batch-response",
			});
		}
		return payload.vectors;
	}

	async dispose(): Promise<void> {
		const currentWorker = this.worker;
		const currentWebWorker = this.webWorker;
		const currentInlineController = this.inlineController;

		try {
			if (currentWorker) {
				try {
					if (this.workerReadyPromise) {
						await this.workerReadyPromise.catch(() => undefined);
					}

					if (this.worker === currentWorker) {
						await this.sendWorkerRequest({
							type: "dispose",
						}).catch(() => undefined);
					}
				} finally {
					this.teardownNodeWorker(currentWorker);
					await currentWorker.terminate().catch(() => undefined);
				}
			}

			if (currentWebWorker) {
				try {
					if (this.webWorkerReadyPromise) {
						await this.webWorkerReadyPromise.catch(() => undefined);
					}

					if (this.webWorker === currentWebWorker) {
						await this.sendWorkerRequest({
							type: "dispose",
						}).catch(() => undefined);
					}
				} finally {
					this.teardownWebWorker(currentWebWorker);
					currentWebWorker.terminate();
				}
			}

			if (currentInlineController) {
				await this.queueInlineOperation(async () => {
					if (!this.inlineController) {
						return;
					}

					const controller = this.inlineController;
					this.inlineController = null;
					this.inlineReadyPromise = null;
					await controller.dispose();
				}).catch(() => undefined);
			}
		} finally {
			this.worker = null;
			this.workerReadyPromise = null;
			this.webWorker = null;
			this.webWorkerReadyPromise = null;
			this.revokeWebWorkerObjectUrl();
			this.webWorkerLaunchDetails = [];
			this.inlineController = null;
			this.inlineReadyPromise = null;
			this.executionMode = null;
			this.inlineFallbackDiagnostic = null;
			this.reportedRuntimeMode = null;
		}
	}

	private async request(
		request: LocalRuntimeRequest,
	): Promise<LocalWorkerSuccessPayload> {
		try {
			await this.ensureRuntimeReady();
		} catch (error) {
			if (this.executionMode === "inline" || this.inlineFallbackDiagnostic) {
				throw this.decorateInlineError(error, request.type);
			}
			throw error;
		}

		if (this.executionMode === "inline") {
			return this.runInlineRequest(request);
		}

		return this.sendWorkerRequest(request);
	}

	private async ensureRuntimePolicy(allowRemoteModels: boolean): Promise<void> {
		if (this.allowRemoteModels === allowRemoteModels) {
			return;
		}

		this.allowRemoteModels = allowRemoteModels;
		await this.dispose();
		this.allowRemoteModels = allowRemoteModels;
	}

	private async ensureRuntimeReady(): Promise<void> {
		if (this.executionMode === "inline") {
			await this.ensureInlineReady();
			return;
		}

		if (this.executionMode === "web-worker") {
			await this.ensureWebWorkerReady();
			return;
		}

		await this.ensureNodeWorkerReady();
	}

	private async ensureNodeWorkerReady(): Promise<void> {
		if (!this.workerScriptPath) {
			throw this.createDiagnosticError("Local model worker script path is not configured.", {
				code: "ERR_LOCAL_WORKER_PATH",
				stage: "worker-path",
			});
		}

		if (this.workerReadyPromise) {
			await this.workerReadyPromise;
			return;
		}

		let worker: Worker;
		try {
			worker = new Worker(this.workerScriptPath);
		} catch (error) {
			const workerStartError = this.decorateError(error, {
				code: "ERR_LOCAL_WORKER_START",
				stage: "worker-start",
				details: [`worker_script_path=${this.workerScriptPath}`],
			});

			if (this.shouldFallbackToInline(workerStartError)) {
				let webWorkerFallbackError: Error | null = null;
				const browserWorkerAvailable = this.canUseWebWorker();

				// 优先尝试 Web Worker（浏览器标准 API），再降级 inline
				if (browserWorkerAvailable) {
					try {
						await this.ensureWebWorkerReady();
						return;
					} catch (error) {
						webWorkerFallbackError = this.decorateError(error, {
							code: "ERR_LOCAL_WEB_WORKER_START",
							stage: "web-worker-create",
							details: [
								`web_worker_script_path=${this.webWorkerScriptPath}`,
								`web_worker_script_url=${this.getWebWorkerScriptUrl()}`,
							],
						});
						// Web Worker 也失败，继续降级到 inline
					}
				}

				this.enableInlineFallback(
					workerStartError,
					webWorkerFallbackError,
					browserWorkerAvailable
						? undefined
						: [
								this.webWorkerScriptPath
									? "web_worker_api_available=false"
									: "web_worker_script_path=missing",
							],
				);
				await this.ensureInlineReady();
				return;
			}

			throw workerStartError;
		}

		this.executionMode = "worker";
		this.reportRuntimeMode("worker", {
			level: "info",
			message: "Local model runtime is using worker_threads.",
			details: [`worker_script_path=${this.workerScriptPath}`],
		});
		this.worker = worker;
		worker.on("message", this.handleWorkerMessage);
		worker.on("error", this.handleWorkerFailure);
		worker.on("exit", this.handleWorkerExit);

		this.workerReadyPromise = this.sendWorkerRequest({
			type: "configure",
			config: {
				modelId: this.modelId,
				dimension: this._dimension,
				cachePath: this.cachePath,
				dtype: this.dtype,
				allowRemoteModels: this.allowRemoteModels,
			},
		})
			.then((payload) => {
				this.applyPayload(payload);
			})
			.catch((error) => {
				this.teardownNodeWorker(worker, error);
				throw error;
			});

		await this.workerReadyPromise;
	}

	// ─── Web Worker (浏览器标准 Worker API) ───

	private canUseWebWorker(): boolean {
		return !!this.webWorkerScriptPath && this.getBrowserWorkerConstructor() !== null;
	}

	private async ensureWebWorkerReady(): Promise<void> {
		if (this.webWorkerReadyPromise) {
			await this.webWorkerReadyPromise;
			return;
		}

		const webWorker = this.createWebWorker();
		this.executionMode = "web-worker";
		this.webWorker = webWorker;
		this.reportRuntimeMode("web-worker", {
			level: "info",
			message: "Local model runtime is using Web Worker (browser Worker API).",
			details: this.webWorkerLaunchDetails,
		});

		webWorker.onmessage = (event: MessageEvent) => {
			this.handleWorkerMessage(event.data as LocalWorkerResponse);
		};
		webWorker.onerror = (event: ErrorEvent) => {
			event.preventDefault();
			this.teardownWebWorker(
				this.webWorker,
				this.decorateError(new Error(event.message || "Web Worker error"), {
					code: "ERR_LOCAL_WEB_WORKER_THREAD",
					stage: "web-worker-thread",
					details: [`web_worker_script_path=${this.webWorkerScriptPath}`],
				}),
			);
		};

		this.webWorkerReadyPromise = this.sendWorkerRequest({
			type: "configure",
			config: {
				modelId: this.modelId,
				dimension: this._dimension,
				cachePath: this.cachePath,
				dtype: this.dtype,
				allowRemoteModels: this.allowRemoteModels,
			},
		})
			.then((payload) => {
				this.applyPayload(payload);
			})
			.catch((error) => {
				this.teardownWebWorker(webWorker, error);
				throw error;
			});

		await this.webWorkerReadyPromise;
	}

	private createWebWorker(): WebWorkerLike {
		if (!this.webWorkerScriptPath) {
			throw this.createDiagnosticError("Web Worker script path is not configured.", {
				code: "ERR_LOCAL_WEB_WORKER_PATH",
				stage: "web-worker-create",
			});
		}

		const BrowserWorker = this.getBrowserWorkerConstructor();
		if (!BrowserWorker) {
			throw this.createDiagnosticError(
				"Browser Worker API is not available.",
				{
					code: "ERR_LOCAL_WEB_WORKER_UNAVAILABLE",
					stage: "web-worker-create",
					details: [`web_worker_script_path=${this.webWorkerScriptPath}`],
				},
			);
		}

		const launchTarget = this.createWebWorkerLaunchTarget();
		this.webWorkerLaunchDetails = launchTarget.details;

		try {
			return new BrowserWorker(launchTarget.url);
		} catch (error) {
			launchTarget.cleanupOnFailure();
			throw this.decorateError(error, {
				code: "ERR_LOCAL_WEB_WORKER_START",
				stage: "web-worker-create",
				details: launchTarget.details,
			});
		}
	}

	private teardownWebWorker(webWorker: WebWorkerLike | null, error?: unknown): void {
		if (!webWorker) {
			if (error) {
				this.rejectAllPending(error);
			}
			this.webWorkerReadyPromise = null;
			return;
		}

		if (this.webWorker === webWorker) {
			webWorker.onmessage = null;
			webWorker.onerror = null;
			this.webWorker = null;
			this.webWorkerReadyPromise = null;
			this.revokeWebWorkerObjectUrl();
			this.webWorkerLaunchDetails = [];
			if (this.executionMode === "web-worker") {
				this.executionMode = null;
			}
		}

		if (error) {
			this.rejectAllPending(error);
		}
	}

	// ─── Inline 降级（最终兜底） ───

	private async ensureInlineReady(): Promise<void> {
		if (this.inlineReadyPromise) {
			await this.inlineReadyPromise;
			return;
		}

		const controller = this.ensureInlineController();
		this.inlineReadyPromise = controller
			.handleRequest({
				type: "configure",
				config: {
					modelId: this.modelId,
					dimension: this._dimension,
					cachePath: this.cachePath,
					dtype: this.dtype,
					allowRemoteModels: this.allowRemoteModels,
				},
				requestId: 0,
			})
			.then((payload) => {
				this.applyPayload(payload);
			});

		try {
			await this.inlineReadyPromise;
		} catch (error) {
			this.inlineReadyPromise = null;
			if (this.inlineController === controller) {
				this.inlineController = null;
			}
			await controller.dispose().catch(() => undefined);
			throw error;
		}
	}

	private ensureInlineController(): InlineRuntimeController {
		if (this.inlineController) {
			return this.inlineController;
		}

		const runtimeRequire = (0, eval)("require") as
			| ((modulePath: string) => InlineRuntimeModule)
			| undefined;
		if (typeof runtimeRequire !== "function") {
			throw this.createDiagnosticError(
				"CommonJS require is not available for inline local runtime fallback.",
				{
					code: "ERR_LOCAL_INLINE_REQUIRE",
					stage: "inline-runtime-load",
					details: [`worker_script_path=${this.workerScriptPath}`],
				},
			);
		}

		const runtimeModule = runtimeRequire(this.workerScriptPath);
		if (typeof runtimeModule?.createLocalRuntimeController !== "function") {
			throw this.createDiagnosticError(
				"Local runtime controller export is missing from worker bundle.",
				{
					code: "ERR_LOCAL_INLINE_EXPORT",
					stage: "inline-runtime-load",
					details: [`worker_script_path=${this.workerScriptPath}`],
				},
			);
		}

		this.inlineController = runtimeModule.createLocalRuntimeController(this.onProgress);
		return this.inlineController;
	}

	private runInlineRequest(
		request: LocalRuntimeRequest,
	): Promise<LocalWorkerSuccessPayload> {
		return this.queueInlineOperation(async () => {
			try {
				const controller = this.ensureInlineController();
				return await controller.handleRequest({
					...request,
					requestId: 0,
				} as LocalWorkerRequest);
			} catch (error) {
				throw this.decorateInlineError(error, request.type);
			}
		});
	}

	private queueInlineOperation<T>(operation: () => Promise<T>): Promise<T> {
		const run = () => operation();
		const result = this.inlineOperationQueue.then(run, run);
		this.inlineOperationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private sendWorkerRequest(
		request: LocalWorkerOutboundRequest,
	): Promise<LocalWorkerSuccessPayload> {
		const target: { postMessage(msg: unknown): void } | null =
			this.worker ?? this.webWorker;
		if (!target) {
			return Promise.reject(
				this.createDiagnosticError("Local model worker is not running.", {
					code: "ERR_LOCAL_WORKER_STATE",
					stage: "worker-state",
				}),
			);
		}

		const requestId = ++this.requestId;
		return new Promise<LocalWorkerSuccessPayload>((resolve, reject) => {
			this.pendingRequests.set(requestId, { resolve, reject });
			try {
				target.postMessage({
					...request,
					requestId,
				} as LocalWorkerRequest);
			} catch (error) {
				this.pendingRequests.delete(requestId);
				reject(
					this.decorateError(error, {
						code: "ERR_LOCAL_WORKER_POST_MESSAGE",
						stage: `worker-send:${request.type}`,
						details: [`worker_request=${request.type}`],
					}),
				);
			}
		});
	}

	private readonly handleWorkerMessage = (message: LocalWorkerResponse): void => {
		if (message.kind === "progress") {
			this.onProgress?.(message.progress);
			return;
		}

		const pending = this.pendingRequests.get(message.requestId);
		if (!pending) {
			return;
		}

		this.pendingRequests.delete(message.requestId);
		if (message.success) {
			pending.resolve(message.payload);
			return;
		}

		pending.reject(
			createErrorFromDiagnostic({
				...message.error,
				details: mergeErrorDetails(message.error.details, [
					`worker_request_id=${message.requestId}`,
				]),
			}),
		);
	};

	private readonly handleWorkerFailure = (error: Error): void => {
		this.teardownNodeWorker(
			this.worker,
			this.decorateError(error, {
				code: "ERR_LOCAL_WORKER_THREAD",
				stage: "worker-thread",
				details: [`worker_script_path=${this.workerScriptPath}`],
			}),
		);
	};

	private readonly handleWorkerExit = (code: number): void => {
		if (code === 0 || !this.worker) {
			return;
		}
		this.teardownNodeWorker(
			this.worker,
			this.createDiagnosticError(`Local model worker exited with code ${code}.`, {
				code: "ERR_LOCAL_WORKER_EXIT",
				stage: "worker-exit",
				details: [`worker_exit_code=${code}`],
			}),
		);
	};

	private applyPayload(payload: LocalWorkerSuccessPayload): void {
		if (typeof payload.dimension === "number" && payload.dimension > 0) {
			this._dimension = payload.dimension;
		}
	}

	private teardownNodeWorker(worker: Worker | null, error?: unknown): void {
		if (!worker) {
			if (error) {
				this.rejectAllPending(error);
			}
			this.workerReadyPromise = null;
			return;
		}

		if (this.worker === worker) {
			worker.off("message", this.handleWorkerMessage);
			worker.off("error", this.handleWorkerFailure);
			worker.off("exit", this.handleWorkerExit);
			this.worker = null;
			this.workerReadyPromise = null;
			if (this.executionMode === "worker") {
				this.executionMode = null;
			}
		}

		if (error) {
			this.rejectAllPending(error);
		}
	}

	private rejectAllPending(error: unknown): void {
		const normalizedError =
			error instanceof Error
				? error
				: this.createDiagnosticError(String(error), {
					code: "ERR_LOCAL_WORKER_UNKNOWN",
					stage: "worker-unknown",
				});
		for (const pending of this.pendingRequests.values()) {
			pending.reject(normalizedError);
		}
		this.pendingRequests.clear();
	}

	private shouldFallbackToInline(error: unknown): boolean {
		const diagnostic = normalizeErrorDiagnostic(error);
		const message = diagnostic.message.toLowerCase();
		return (
			diagnostic.code === "ERR_MISSING_PLATFORM_FOR_WORKER" ||
			diagnostic.code === "ERR_WORKER_UNSUPPORTED_OPERATION" ||
			message.includes("does not support creating workers") ||
			message.includes("worker is not supported")
		);
	}

	private getBrowserWorkerConstructor(): WebWorkerConstructor | null {
		const globalWorker = (globalThis as Record<string, unknown>).Worker;
		if (typeof globalWorker === "function") {
			return globalWorker as WebWorkerConstructor;
		}

		if (typeof window !== "undefined") {
			const windowWorker = (window as unknown as Record<string, unknown>).Worker;
			if (typeof windowWorker === "function") {
				return windowWorker as WebWorkerConstructor;
			}
		}

		return null;
	}

	private getWebWorkerScriptUrl(): string {
		return pathToFileURL(this.webWorkerScriptPath).toString();
	}

	private createWebWorkerLaunchTarget(): WebWorkerLaunchTarget {
		const fileUrl = this.getWebWorkerScriptUrl();
		const baseDetails = [`web_worker_script_path=${this.webWorkerScriptPath}`];

		if (
			typeof Blob === "function" &&
			typeof URL !== "undefined" &&
			typeof URL.createObjectURL === "function" &&
			typeof URL.revokeObjectURL === "function"
		) {
			try {
				const scriptSource = readFileSync(this.webWorkerScriptPath, "utf8");
				const objectUrl = URL.createObjectURL(
					new Blob([scriptSource], { type: "text/javascript" }),
				);
				this.revokeWebWorkerObjectUrl();
				this.webWorkerObjectUrl = objectUrl;
				return {
					url: objectUrl,
					details: [
						...baseDetails,
						`web_worker_script_url=${objectUrl}`,
						"web_worker_script_strategy=blob",
					],
					cleanupOnFailure: () => {
						if (this.webWorkerObjectUrl === objectUrl) {
							this.revokeWebWorkerObjectUrl();
							return;
						}

						URL.revokeObjectURL(objectUrl);
					},
				};
			} catch (error) {
				const diagnostic = normalizeErrorDiagnostic(error);
				return {
					url: fileUrl,
					details: [
						...baseDetails,
						`web_worker_script_url=${fileUrl}`,
						"web_worker_script_strategy=file",
						diagnostic.code
							? `web_worker_blob_prepare_code=${diagnostic.code}`
							: undefined,
						diagnostic.message
							? `web_worker_blob_prepare_message=${diagnostic.message}`
							: undefined,
					].filter((detail): detail is string => Boolean(detail)),
					cleanupOnFailure: () => undefined,
				};
			}
		}

		return {
			url: fileUrl,
			details: [
				...baseDetails,
				`web_worker_script_url=${fileUrl}`,
				"web_worker_script_strategy=file",
				"web_worker_blob_supported=false",
			],
			cleanupOnFailure: () => undefined,
		};
	}

	private revokeWebWorkerObjectUrl(): void {
		if (
			this.webWorkerObjectUrl &&
			typeof URL !== "undefined" &&
			typeof URL.revokeObjectURL === "function"
		) {
			URL.revokeObjectURL(this.webWorkerObjectUrl);
		}

		this.webWorkerObjectUrl = null;
	}

	private enableInlineFallback(
		error: unknown,
		webWorkerError?: unknown,
		extraDetails?: string[],
	): void {
		const diagnostic = normalizeErrorDiagnostic(error);
		const webWorkerDiagnostic = webWorkerError
			? normalizeErrorDiagnostic(webWorkerError)
			: null;
		this.executionMode = "inline";
		this.inlineFallbackDiagnostic = diagnostic;
		this.reportRuntimeMode("inline", {
			level: "warn",
			message: "worker_threads unavailable; local model runtime fell back to inline mode.",
			details: mergeErrorDetails(
				diagnostic.details,
				webWorkerDiagnostic?.details,
				extraDetails,
				[
					diagnostic.code ? `worker_fallback_code=${diagnostic.code}` : undefined,
					diagnostic.message ? `worker_fallback_message=${diagnostic.message}` : undefined,
					webWorkerDiagnostic?.code
						? `web_worker_fallback_code=${webWorkerDiagnostic.code}`
						: undefined,
					webWorkerDiagnostic?.message
						? `web_worker_fallback_message=${webWorkerDiagnostic.message}`
						: undefined,
				].filter((item): item is string => Boolean(item)),
			),
		});
		console.warn(
			"Semantic Connections: worker_threads unavailable, using inline local runtime.",
			diagnostic.message,
		);
	}

	private reportRuntimeMode(
		mode: LocalRuntimeMode,
		event: Omit<LocalProviderRuntimeEvent, "event" | "mode">,
	): void {
		if (this.reportedRuntimeMode === mode) {
			return;
		}

		this.reportedRuntimeMode = mode;
		this.onRuntimeEvent?.({
			event: "local-runtime-mode-selected",
			mode,
			...event,
		});
	}

	private decorateInlineError(
		error: unknown,
		requestType: LocalRuntimeRequest["type"],
	): Error {
		const diagnostic = normalizeErrorDiagnostic(error);
		const fallbackReasonDetails =
			this.inlineFallbackDiagnostic?.code
				? [`worker_fallback_code=${this.inlineFallbackDiagnostic.code}`]
				: this.inlineFallbackDiagnostic?.message
					? [`worker_fallback_message=${this.inlineFallbackDiagnostic.message}`]
					: undefined;

		return createErrorFromDiagnostic({
			...diagnostic,
			stage: diagnostic.stage ?? `inline:${requestType}`,
			details: mergeErrorDetails(
				diagnostic.details,
				this.inlineFallbackDiagnostic?.details,
				[
					"local_runtime_mode=inline",
					`runtime_request=${requestType}`,
				],
				fallbackReasonDetails,
			),
		});
	}

	private decorateError(error: unknown, fallback: Omit<ErrorDiagnostic, "message">): Error {
		const diagnostic = normalizeErrorDiagnostic(error);
		return createErrorFromDiagnostic({
			...diagnostic,
			stage: diagnostic.stage ?? fallback.stage,
			code: diagnostic.code ?? fallback.code,
			details: mergeErrorDetails(diagnostic.details, fallback.details),
		});
	}

	private createDiagnosticError(
		message: string,
		diagnostic: Omit<ErrorDiagnostic, "message">,
	): Error {
		return createErrorFromDiagnostic({ message, ...diagnostic });
	}
}
