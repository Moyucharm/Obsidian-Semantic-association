/**
 * Browser Worker entry for local model execution.
 *
 * This worker mirrors the message protocol used by the Node worker fallback,
 * but it runs through the standard Worker API and forces Transformers.js to
 * stay on its web/WASM backend even inside Obsidian's Electron runtime.
 */

import type {
	LocalWorkerRequest,
	LocalWorkerResponse,
	LocalWorkerSuccessPayload,
} from "../embeddings/local-worker-protocol";
import type {
	LocalModelProgress,
	LocalRuntimeConfig,
} from "../embeddings/local-model-shared";
import { mergeErrorDetails, normalizeErrorDiagnostic } from "../utils/error-utils";

declare const self: {
	onmessage: ((event: MessageEvent<LocalWorkerRequest>) => void) | null;
	postMessage(message: unknown): void;
	constructor?: { name?: string };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FeatureExtractionPipeline = any;

type MutableProcess = NodeJS.Process & { type?: string };
type MutableRecord = Record<string | symbol, unknown>;

const WEB_WORKER_CONSTRUCTOR_NAMES = new Set([
	"DedicatedWorkerGlobalScope",
	"ServiceWorkerGlobalScope",
	"SharedWorkerGlobalScope",
]);

let runtimeConfig: LocalRuntimeConfig | null = null;
let pipeline: FeatureExtractionPipeline | null = null;
let currentDimension = 0;
let initPromise: Promise<void> | null = null;

const post = (message: LocalWorkerResponse): void => {
	self.postMessage(message);
};

const respondSuccess = (requestId: number, payload: LocalWorkerSuccessPayload = {}): void => {
	post({ kind: "result", requestId, success: true, payload });
};

const respondError = (requestId: number, error: unknown, requestType: string): void => {
	const diagnostic = normalizeErrorDiagnostic(error);
	post({
		kind: "result",
		requestId,
		success: false,
		error: {
			...diagnostic,
			stage: diagnostic.stage ?? `web-worker:${requestType}`,
			details: mergeErrorDetails(diagnostic.details, [
				`worker_request=${requestType}`,
				"local_runtime_mode=web-worker",
				"web_worker_env_spoofed=true",
			]),
		},
	});
};

const emitProgress = (progress: LocalModelProgress): void => {
	post({ kind: "progress", progress });
};

const importTransformersWebBackend = async () =>
	runWithSpoofedWebEnvironment(
		() => import("@huggingface/transformers"),
		{ clearOrtSymbol: true },
	);

const runWithSpoofedWebEnvironment = async <T>(
	callback: () => Promise<T>,
	options?: { clearOrtSymbol?: boolean },
): Promise<T> => {
	const ortSymbol = Symbol.for("onnxruntime");
	const globalAny = globalThis as typeof globalThis & MutableRecord;
	const processAny = typeof process !== "undefined" ? process : undefined;
	const mutableProcess = processAny as MutableProcess | undefined;
	const selfAny = self as unknown as MutableRecord;

	const clearOrtSymbol = options?.clearOrtSymbol ?? false;
	const hadOrtSymbol =
		clearOrtSymbol && Object.prototype.hasOwnProperty.call(globalAny, ortSymbol);
	const previousOrtSymbol = hadOrtSymbol ? globalAny[ortSymbol] : undefined;

	const originalReleaseDescriptor = processAny?.release
		? Object.getOwnPropertyDescriptor(processAny.release, "name")
		: undefined;
	const originalNodeVersionDescriptor = processAny?.versions
		? Object.getOwnPropertyDescriptor(processAny.versions, "node")
		: undefined;
	const originalTypeDescriptor = processAny
		? Object.getOwnPropertyDescriptor(processAny, "type")
		: undefined;
	const originalSelfConstructorDescriptor = Object.getOwnPropertyDescriptor(
		selfAny,
		"constructor",
	);

	let releaseSpoofed = false;
	let nodeVersionSpoofed = false;
	let processTypeSpoofed = false;
	let selfConstructorSpoofed = false;

	if (hadOrtSymbol) {
		try {
			delete globalAny[ortSymbol];
		} catch {
			globalAny[ortSymbol] = undefined;
		}
	}

	try {
		if (processAny?.release?.name === "node") {
			try {
				Object.defineProperty(processAny.release, "name", {
					configurable: true,
					enumerable: originalReleaseDescriptor?.enumerable ?? true,
					writable: true,
					value: "electron",
				});
				releaseSpoofed = true;
			} catch {
				// Ignore spoof failures and let the worker surface the real error.
			}
		}

		if (processAny?.versions && typeof processAny.versions.node === "string") {
			try {
				Object.defineProperty(processAny.versions, "node", {
					configurable: true,
					enumerable: originalNodeVersionDescriptor?.enumerable ?? true,
					writable: true,
					value: undefined,
				});
				nodeVersionSpoofed = true;
			} catch {
				// Ignore spoof failures and let the worker surface the real error.
			}
		}

		if (mutableProcess && mutableProcess.type !== "renderer") {
			try {
				Object.defineProperty(mutableProcess, "type", {
					configurable: true,
					enumerable: originalTypeDescriptor?.enumerable ?? true,
					writable: true,
					value: "renderer",
				});
				processTypeSpoofed = true;
			} catch {
				// Ignore spoof failures and let the worker surface the real error.
			}
		}

		if (!WEB_WORKER_CONSTRUCTOR_NAMES.has(String(self.constructor?.name ?? ""))) {
			try {
				Object.defineProperty(selfAny, "constructor", {
					configurable: true,
					enumerable: false,
					writable: true,
					value: class DedicatedWorkerGlobalScope {},
				});
				selfConstructorSpoofed = true;
			} catch {
				// Ignore spoof failures and let the worker surface the real error.
			}
		}

		return await callback();
	} finally {
		if (selfConstructorSpoofed) {
			try {
				if (originalSelfConstructorDescriptor) {
					Object.defineProperty(selfAny, "constructor", originalSelfConstructorDescriptor);
				} else {
					Reflect.deleteProperty(selfAny, "constructor");
				}
			} catch {
				// Ignore restore failures.
			}
		}

		if (processTypeSpoofed && processAny) {
			try {
				if (originalTypeDescriptor) {
					Object.defineProperty(processAny, "type", originalTypeDescriptor);
				} else {
					const processWithOptionalType = mutableProcess as { type?: string } | undefined;
					if (processWithOptionalType) {
						delete processWithOptionalType.type;
					}
				}
			} catch {
				// Ignore restore failures.
			}
		}

		if (nodeVersionSpoofed && processAny?.versions && originalNodeVersionDescriptor) {
			try {
				Object.defineProperty(processAny.versions, "node", originalNodeVersionDescriptor);
			} catch {
				// Ignore restore failures.
			}
		}

		if (releaseSpoofed && processAny?.release && originalReleaseDescriptor) {
			try {
				Object.defineProperty(processAny.release, "name", originalReleaseDescriptor);
			} catch {
				// Ignore restore failures.
			}
		}

		if (hadOrtSymbol) {
			globalAny[ortSymbol] = previousOrtSymbol;
		}
	}
};

const loadPipeline = async (): Promise<void> => {
	const activeConfig = runtimeConfig;
	if (!activeConfig) {
		throw new Error("Web worker is not configured.");
	}

	const transformers = await importTransformersWebBackend();
	const env = transformers.env as typeof transformers.env & {
		useFS?: boolean;
		useBrowserCache?: boolean;
	};

	// Keep this worker on the browser cache + WASM path even when Obsidian
	// exposes Electron/Node globals inside the Worker context. Browser cache
	// still counts as a local model source, so local loads must remain enabled.
	env.allowLocalModels = true;
	env.allowRemoteModels = activeConfig.allowRemoteModels ?? false;
	env.useFS = false;
	env.useBrowserCache = true;

	if (env.backends?.onnx?.wasm) {
		env.backends.onnx.wasm.proxy = false;
		env.backends.onnx.wasm.numThreads = 1;
	}

	await runWithSpoofedWebEnvironment(async () => {
		pipeline = await transformers.pipeline("feature-extraction", activeConfig.modelId, {
			progress_callback: (info: Record<string, unknown>) => {
				emitProgress({
					status: String(info.status ?? ""),
					file: info.file ? String(info.file) : undefined,
					progress: typeof info.progress === "number" ? info.progress : undefined,
					loaded: typeof info.loaded === "number" ? info.loaded : undefined,
					total: typeof info.total === "number" ? info.total : undefined,
				});
			},
			dtype: (activeConfig.dtype ?? "q8") as "fp32" | "fp16" | "q8" | "q4",
			device: "wasm",
		});

		emitProgress({ status: "ready" });
		emitProgress({ status: "warmup" });
		const testOutput = await pipeline(" ", { pooling: "mean", normalize: true });
		const testVector = (testOutput.tolist() as number[][])[0];
		if (testVector && testVector.length !== currentDimension) {
			currentDimension = testVector.length;
		}
	});
};

const ensureInitialized = async (): Promise<void> => {
	if (pipeline) {
		return;
	}

	if (initPromise) {
		await initPromise;
		return;
	}

	initPromise = loadPipeline();
	try {
		await initPromise;
	} catch (error) {
		pipeline = null;
		initPromise = null;
		throw error;
	}
};

const handleRequest = async (request: LocalWorkerRequest): Promise<void> => {
	try {
		switch (request.type) {
			case "configure": {
				if (
					runtimeConfig &&
					JSON.stringify({
						modelId: runtimeConfig.modelId,
						dtype: runtimeConfig.dtype,
						allowRemoteModels: runtimeConfig.allowRemoteModels,
					}) !==
						JSON.stringify({
							modelId: request.config.modelId,
							dtype: request.config.dtype,
							allowRemoteModels: request.config.allowRemoteModels,
						})
				) {
					if (pipeline?.dispose) {
						await pipeline.dispose();
					}
					pipeline = null;
					initPromise = null;
				}

				runtimeConfig = request.config;
				currentDimension = request.config.dimension;
				respondSuccess(request.requestId, { dimension: currentDimension });
				return;
			}
			case "prepare": {
				await ensureInitialized();
				respondSuccess(request.requestId, { dimension: currentDimension });
				return;
			}
			case "embed": {
				await ensureInitialized();
				const text = request.text.trim() || " ";
				const output = await pipeline(text, { pooling: "mean", normalize: true });
				const vector = (output.tolist() as number[][])[0];
				respondSuccess(request.requestId, { vector, dimension: currentDimension });
				return;
			}
			case "embedBatch": {
				await ensureInitialized();
				const vectors: number[][] = [];
				for (const text of request.texts) {
					const cleanText = text.trim() || " ";
					const output = await pipeline(cleanText, { pooling: "mean", normalize: true });
					vectors.push((output.tolist() as number[][])[0]);
				}
				respondSuccess(request.requestId, { vectors, dimension: currentDimension });
				return;
			}
			case "dispose": {
				if (pipeline?.dispose) {
					await pipeline.dispose();
				}
				pipeline = null;
				initPromise = null;
				respondSuccess(request.requestId);
				return;
			}
		}
	} catch (error) {
		respondError(request.requestId, error, request.type);
	}
};

let operationQueue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<LocalWorkerRequest>) => {
	const request = event.data;
	const run = () => handleRequest(request);
	operationQueue = operationQueue.then(run, run);
};
