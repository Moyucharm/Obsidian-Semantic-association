import type { ErrorDiagnostic, Vector } from "../types";
import type { LocalModelProgress, LocalRuntimeConfig } from "./local-model-shared";

export interface WorkerConfigureRequest {
	requestId: number;
	type: "configure";
	config: LocalRuntimeConfig;
}

export interface WorkerPrepareRequest {
	requestId: number;
	type: "prepare";
}

export interface WorkerEmbedRequest {
	requestId: number;
	type: "embed";
	text: string;
}

export interface WorkerEmbedBatchRequest {
	requestId: number;
	type: "embedBatch";
	texts: string[];
}

export interface WorkerDisposeRequest {
	requestId: number;
	type: "dispose";
}

export type LocalWorkerRequest =
	| WorkerConfigureRequest
	| WorkerPrepareRequest
	| WorkerEmbedRequest
	| WorkerEmbedBatchRequest
	| WorkerDisposeRequest;

export interface LocalWorkerSuccessPayload {
	dimension?: number;
	vector?: Vector;
	vectors?: Vector[];
}

export interface LocalWorkerSuccessResponse {
	kind: "result";
	requestId: number;
	success: true;
	payload: LocalWorkerSuccessPayload;
}

export interface LocalWorkerErrorResponse {
	kind: "result";
	requestId: number;
	success: false;
	error: ErrorDiagnostic;
}

export interface LocalWorkerProgressEvent {
	kind: "progress";
	progress: LocalModelProgress;
}

export type LocalWorkerResponse =
	| LocalWorkerSuccessResponse
	| LocalWorkerErrorResponse
	| LocalWorkerProgressEvent;
