import { parentPort } from "worker_threads";
import { LocalModelRuntime } from "../embeddings/local-runtime";
import type {
	LocalModelProgress,
	LocalRuntimeConfig,
} from "../embeddings/local-model-shared";
import type {
	LocalWorkerRequest,
	LocalWorkerResponse,
	LocalWorkerSuccessPayload,
} from "../embeddings/local-worker-protocol";
import { mergeErrorDetails, normalizeErrorDiagnostic } from "../utils/error-utils";

export interface LocalRuntimeController {
	handleRequest(request: LocalWorkerRequest): Promise<LocalWorkerSuccessPayload>;
	dispose(): Promise<void>;
}

const buildConfigKey = (config: LocalRuntimeConfig): string =>
	JSON.stringify({
		modelId: config.modelId,
		dimension: config.dimension,
		cachePath: config.cachePath,
		dtype: config.dtype ?? "q8",
		allowRemoteModels: config.allowRemoteModels ?? false,
	});

export const createLocalRuntimeController = (
	onProgress?: (progress: LocalModelProgress) => void,
): LocalRuntimeController => {
	let runtime: LocalModelRuntime | null = null;
	let currentConfigKey = "";

	const ensureRuntime = async (config?: LocalRuntimeConfig): Promise<LocalModelRuntime> => {
		if (config) {
			const nextKey = buildConfigKey(config);
			if (!runtime || currentConfigKey !== nextKey) {
				if (runtime) {
					await runtime.dispose();
				}
				runtime = new LocalModelRuntime({
					...config,
					onProgress,
				});
				currentConfigKey = nextKey;
			}
		}

		if (!runtime) {
			throw new Error("Local model worker is not configured.");
		}

		return runtime;
	};

	return {
		async handleRequest(request: LocalWorkerRequest): Promise<LocalWorkerSuccessPayload> {
			switch (request.type) {
				case "configure": {
					const configuredRuntime = await ensureRuntime(request.config);
					return { dimension: configuredRuntime.dimension };
				}
				case "prepare": {
					const preparedRuntime = await ensureRuntime();
					const dimension = await preparedRuntime.prepare();
					return { dimension };
				}
				case "embed": {
					const embedRuntime = await ensureRuntime();
					const vector = await embedRuntime.embed(request.text);
					return {
						vector,
						dimension: embedRuntime.dimension,
					};
				}
				case "embedBatch": {
					const embedBatchRuntime = await ensureRuntime();
					const vectors = await embedBatchRuntime.embedBatch(request.texts);
					return {
						vectors,
						dimension: embedBatchRuntime.dimension,
					};
				}
				case "dispose": {
					if (runtime) {
						await runtime.dispose();
						runtime = null;
						currentConfigKey = "";
					}
					return {};
				}
			}
		},
		async dispose(): Promise<void> {
			if (runtime) {
				await runtime.dispose();
				runtime = null;
				currentConfigKey = "";
			}
		},
	};
};

const postMessage = (message: LocalWorkerResponse): void => {
	parentPort!.postMessage(message);
};

const respondSuccess = (requestId: number, payload: LocalWorkerSuccessPayload = {}): void => {
	postMessage({
		kind: "result",
		requestId,
		success: true,
		payload,
	});
};

const respondError = (
	requestId: number,
	error: unknown,
	requestType: LocalWorkerRequest["type"],
): void => {
	const diagnostic = normalizeErrorDiagnostic(error);
	postMessage({
		kind: "result",
		requestId,
		success: false,
		error: {
			...diagnostic,
			stage: diagnostic.stage ?? `worker:${requestType}`,
			details: mergeErrorDetails(diagnostic.details, [
				`worker_request=${requestType}`,
			]),
		},
	});
};

if (parentPort) {
	const controller = createLocalRuntimeController((progress) => {
		postMessage({ kind: "progress", progress });
	});
	let operationQueue: Promise<void> = Promise.resolve();

	parentPort.on("message", (request: LocalWorkerRequest) => {
		const run = async () => {
			try {
				const payload = await controller.handleRequest(request);
				respondSuccess(request.requestId, payload);
			} catch (error) {
				respondError(request.requestId, error, request.type);
			}
		};

		operationQueue = operationQueue.then(run, run);
	});
}
