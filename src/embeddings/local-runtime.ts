import { pathToFileURL } from "url";
import type { Vector } from "../types";
import type { LocalModelProgress, LocalRuntimeConfig } from "./local-model-shared";

// Dynamic import only, used for internal typing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FeatureExtractionPipeline = any;

export class LocalModelRuntime {
	private _dimension: number;
	private pipeline: FeatureExtractionPipeline | null = null;
	private initPromise: Promise<void> | null = null;
	private lastStage = "idle";
	private lastProgress: LocalModelProgress | null = null;
	private readonly modelId: string;
	private readonly dtype: string;
	private readonly cachePath: string;
	private readonly allowRemoteModels: boolean;
	private readonly onProgress?: (progress: LocalModelProgress) => void;

	constructor(config: LocalRuntimeConfig & { onProgress?: (progress: LocalModelProgress) => void }) {
		this.modelId = config.modelId;
		this._dimension = config.dimension;
		this.cachePath = config.cachePath;
		this.dtype = config.dtype ?? "q8";
		this.allowRemoteModels = config.allowRemoteModels ?? false;
		this.onProgress = config.onProgress;
	}

	get dimension(): number {
		return this._dimension;
	}

	getDiagnosticSnapshot(): { stage?: string; details?: string[] } {
		const details: string[] = [];
		if (this.lastProgress?.status) {
			details.push(`progress_status=${this.lastProgress.status}`);
		}
		if (this.lastProgress?.file) {
			details.push(`progress_file=${this.lastProgress.file}`);
		}
		if (typeof this.lastProgress?.loaded === "number") {
			details.push(`progress_loaded=${this.lastProgress.loaded}`);
		}
		if (typeof this.lastProgress?.total === "number") {
			details.push(`progress_total=${this.lastProgress.total}`);
		}
		return {
			stage: this.lastStage !== "idle" ? this.lastStage : undefined,
			details: details.length > 0 ? details : undefined,
		};
	}

	async prepare(): Promise<number> {
		this.markStage("prepare");
		await this.ensureInitialized();
		return this._dimension;
	}

	async embed(text: string): Promise<Vector> {
		this.markStage("embed");
		await this.ensureInitialized();

		const cleanText = text.trim() || " ";
		const output = await this.pipeline(cleanText, {
			pooling: "mean",
			normalize: true,
		});

		const vectors = output.tolist() as number[][];
		return vectors[0];
	}

	async embedBatch(texts: string[]): Promise<Vector[]> {
		if (texts.length === 0) {
			return [];
		}

		this.markStage("embed-batch");
		await this.ensureInitialized();

		const results: Vector[] = [];
		for (const text of texts) {
			const cleanText = text.trim() || " ";
			const output = await this.pipeline(cleanText, {
				pooling: "mean",
				normalize: true,
			});
			const vectors = output.tolist() as number[][];
			results.push(vectors[0]);
		}

		return results;
	}

	async dispose(): Promise<void> {
		this.markStage("dispose");
		if (!this.pipeline) {
			return;
		}

		if (typeof this.pipeline.dispose === "function") {
			await this.pipeline.dispose();
		}

		this.pipeline = null;
		this.initPromise = null;
	}

	private async ensureInitialized(): Promise<void> {
		if (this.pipeline) {
			return;
		}

		if (this.initPromise) {
			await this.initPromise;
			return;
		}

		this.markStage("initialize");
		this.initPromise = this.loadPipeline();
		try {
			await this.initPromise;
		} catch (error) {
			this.pipeline = null;
			this.initPromise = null;
			throw error;
		}
	}

	private async loadPipeline(): Promise<void> {
		this.markStage("import-transformers");
		const transformers = await this.importTransformersWebBackend();
		this.markStage("configure-runtime");
		const env = transformers.env;

		env.cacheDir = this.cachePath;
		env.localModelPath = this.cachePath;
		env.allowLocalModels = true;
		env.allowRemoteModels = this.allowRemoteModels;

		if (env.backends?.onnx?.wasm) {
			env.backends.onnx.wasm.proxy = false;
			env.backends.onnx.wasm.numThreads = 1;
		}

		this.markStage("create-pipeline");
		await this.runWithSpoofedWebEnvironment(async () => {
			this.pipeline = await transformers.pipeline("feature-extraction", this.modelId, {
				progress_callback: (info: Record<string, unknown>) => {
					this.emitProgress({
						status: String(info.status ?? ""),
						file: info.file ? String(info.file) : undefined,
						progress: typeof info.progress === "number" ? info.progress : undefined,
						loaded: typeof info.loaded === "number" ? info.loaded : undefined,
						total: typeof info.total === "number" ? info.total : undefined,
					});
				},
				dtype: this.dtype as "fp32" | "fp16" | "q8" | "q4",
				device: "wasm",
			});

			this.markStage("ready");
			this.emitProgress({ status: "ready" });
			this.markStage("warmup");
			this.emitProgress({ status: "warmup" });
			await this.yieldToEventLoop();
			const testOutput = await this.pipeline(" ", {
				pooling: "mean",
				normalize: true,
			});
			const testVec = (testOutput.tolist() as number[][])[0];
			if (testVec && testVec.length !== this._dimension) {
				console.warn(
					`LocalModelRuntime: actual dimension ${testVec.length} differs from expected ${this._dimension}; updating.`,
				);
				this._dimension = testVec.length;
			}
		});
	}

	private async yieldToEventLoop(): Promise<void> {
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
	}

	private markStage(stage: string): void {
		this.lastStage = stage;
	}

	private emitProgress(progress: LocalModelProgress): void {
		this.lastProgress = progress;
		this.lastStage = progress.status ? `progress:${progress.status}` : this.lastStage;
		this.onProgress?.(progress);
	}

	private async importTransformersWebBackend() {
		this.markStage("import-transformers-module");
		return this.runWithSpoofedWebEnvironment(
			() => import("@huggingface/transformers"),
			{ clearOrtSymbol: true },
		);
	}

	private async runWithSpoofedWebEnvironment<T>(
		callback: () => Promise<T>,
		options?: { clearOrtSymbol?: boolean },
	): Promise<T> {
		const ortSymbol = Symbol.for("onnxruntime");
		const globalAny = globalThis as typeof globalThis & Record<string | symbol, unknown>;
		const mutableGlobal = globalAny as Record<string | symbol, unknown>;
		const originalProcess = typeof process !== "undefined" ? process : undefined;
		const processWithElectronType = originalProcess as (NodeJS.Process & { type?: string }) | undefined;

		const clearOrtSymbol = options?.clearOrtSymbol ?? false;
		const hadOrt = clearOrtSymbol && Object.prototype.hasOwnProperty.call(globalAny, ortSymbol);
		const previousOrt = hadOrt ? globalAny[ortSymbol] : undefined;

		const originalReleaseDescriptor = originalProcess?.release
			? Object.getOwnPropertyDescriptor(originalProcess.release, "name")
			: undefined;
		const originalNodeVersionDescriptor = originalProcess?.versions
			? Object.getOwnPropertyDescriptor(originalProcess.versions, "node")
			: undefined;
		const originalTypeDescriptor = originalProcess
			? Object.getOwnPropertyDescriptor(originalProcess, "type")
			: undefined;
		const originalSelf = mutableGlobal.self;
		const originalLocation = mutableGlobal.location;
		const originalWorkerGlobalScope = mutableGlobal.WorkerGlobalScope;
		const hadSelf = Object.prototype.hasOwnProperty.call(mutableGlobal, "self");
		const hadLocation = Object.prototype.hasOwnProperty.call(mutableGlobal, "location");
		const hadWorkerGlobalScope = Object.prototype.hasOwnProperty.call(mutableGlobal, "WorkerGlobalScope");

		let releaseSpoofed = false;
		let nodeVersionSpoofed = false;
		let typeSpoofed = false;
		let selfSpoofed = false;
		let locationSpoofed = false;
		let workerScopeSpoofed = false;

		if (hadOrt) {
			try {
				delete mutableGlobal[ortSymbol];
			} catch {
				mutableGlobal[ortSymbol] = undefined;
			}
		}

		try {
			if (originalProcess?.release?.name === "node") {
				try {
					Object.defineProperty(originalProcess.release, "name", {
						configurable: true,
						enumerable: originalReleaseDescriptor?.enumerable ?? true,
						writable: true,
						value: "electron",
					});
					releaseSpoofed = true;
				} catch {
					// Ignore spoof failures.
				}
			}

			if (originalProcess?.versions && typeof originalProcess.versions.node === "string") {
				try {
					Object.defineProperty(originalProcess.versions, "node", {
						configurable: true,
						enumerable: originalNodeVersionDescriptor?.enumerable ?? true,
						writable: true,
						value: undefined,
					});
					nodeVersionSpoofed = true;
				} catch {
					// Ignore spoof failures.
				}
			}

			if (processWithElectronType && processWithElectronType.type !== "renderer") {
				try {
					Object.defineProperty(processWithElectronType, "type", {
						configurable: true,
						enumerable: originalTypeDescriptor?.enumerable ?? true,
						writable: true,
						value: "renderer",
					});
					typeSpoofed = true;
				} catch {
					// Ignore spoof failures.
				}
			}

			if (typeof mutableGlobal.WorkerGlobalScope === "undefined") {
				try {
					mutableGlobal.WorkerGlobalScope = class WorkerGlobalScope {};
					workerScopeSpoofed = true;
				} catch {
					// Ignore spoof failures.
				}
			}

			if (typeof mutableGlobal.location === "undefined") {
				try {
					const href =
						typeof __filename !== "undefined"
							? pathToFileURL(__filename).href
							: "file:///";
					mutableGlobal.location = { href, origin: "file://" };
					locationSpoofed = true;
				} catch {
					// Ignore spoof failures.
				}
			}

			if (typeof mutableGlobal.self === "undefined") {
				try {
					const spoofedSelf = Object.create(globalThis) as Record<string, unknown>;
					spoofedSelf.constructor = class DedicatedWorkerGlobalScope {};
					spoofedSelf.location = mutableGlobal.location;
					mutableGlobal.self = spoofedSelf;
					selfSpoofed = true;
				} catch {
					// Ignore spoof failures.
				}
			}

			return await callback();
		} finally {
			if (selfSpoofed) {
				try {
					if (hadSelf) {
						mutableGlobal.self = originalSelf;
					} else {
						delete mutableGlobal.self;
					}
				} catch {
					// Ignore restore failures.
				}
			}

			if (locationSpoofed) {
				try {
					if (hadLocation) {
						mutableGlobal.location = originalLocation;
					} else {
						delete mutableGlobal.location;
					}
				} catch {
					// Ignore restore failures.
				}
			}

			if (workerScopeSpoofed) {
				try {
					if (hadWorkerGlobalScope) {
						mutableGlobal.WorkerGlobalScope = originalWorkerGlobalScope;
					} else {
						delete mutableGlobal.WorkerGlobalScope;
					}
				} catch {
					// Ignore restore failures.
				}
			}

			if (typeSpoofed && originalProcess) {
				try {
					if (originalTypeDescriptor) {
						Object.defineProperty(originalProcess, "type", originalTypeDescriptor);
					} else {
						delete processWithElectronType?.type;
					}
				} catch {
					// Ignore restore failures.
				}
			}

			if (nodeVersionSpoofed && originalProcess?.versions) {
				try {
					if (originalNodeVersionDescriptor) {
						Object.defineProperty(originalProcess.versions, "node", originalNodeVersionDescriptor);
					}
				} catch {
					// Ignore restore failures.
				}
			}

			if (releaseSpoofed && originalProcess?.release) {
				try {
					if (originalReleaseDescriptor) {
						Object.defineProperty(originalProcess.release, "name", originalReleaseDescriptor);
					}
				} catch {
					// Ignore restore failures.
				}
			}

			if (hadOrt) {
				mutableGlobal[ortSymbol] = previousOrt;
			}
		}
	}
}
