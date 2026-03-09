import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { Vector } from "../types";
import {
	createErrorFromDiagnostic,
	mergeErrorDetails,
	normalizeErrorDiagnostic,
} from "../utils/error-utils";
import type { EmbeddingProvider } from "./provider";

export interface RemoteProviderConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	timeoutMs?: number;
	batchSize?: number;
}

type RemoteEmbeddingItem = {
	embedding?: unknown;
};

type RemoteEmbeddingResponse = {
	data?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

export const normalizeRemoteBaseUrl = (baseUrl: string): string => {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return "";
	}

	try {
		const url = new URL(trimmed);
		let pathname = url.pathname
			.replace(/\/v1\/embeddings\/?$/i, "")
			.replace(/\/v1\/?$/i, "")
			.replace(/\/+$/, "");
		url.pathname = pathname.length > 0 ? pathname : "/";
		return url.toString().replace(/\/$/, "");
	} catch {
		return trimmed;
	}
};

export class RemoteProvider implements EmbeddingProvider {
	readonly name = "remote";

	private _dimension = 0;
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly batchSize: number;

	constructor(config: RemoteProviderConfig) {
		this.baseUrl = config.baseUrl;
		this.apiKey = config.apiKey;
		this.model = config.model;
		this.timeoutMs = config.timeoutMs ?? 30_000;
		this.batchSize = config.batchSize ?? 16;
	}

	get dimension(): number {
		return this._dimension;
	}

	async embed(text: string): Promise<Vector> {
		const vectors = await this.embedBatch([text]);
		if (vectors.length === 0) {
			throw this.createDiagnosticError("Remote embeddings API returned no vectors.", {
				code: "ERR_REMOTE_EMBEDDING_EMPTY",
				stage: "embed-response",
			});
		}
		return vectors[0];
	}

	async embedBatch(texts: string[]): Promise<Vector[]> {
		if (texts.length === 0) {
			return [];
		}

		const batchSize = this.getValidatedBatchSize();
		const vectors: Vector[] = [];

		for (let start = 0; start < texts.length; start += batchSize) {
			const chunk = texts.slice(start, start + batchSize);
			const chunkVectors = await this.requestEmbeddings(chunk);
			vectors.push(...chunkVectors);
		}

		return vectors;
	}

	private async requestEmbeddings(inputs: string[]): Promise<Vector[]> {
		const endpoint = this.getEmbeddingsEndpoint();
		const response = await this.sendRequest(endpoint, inputs);

		if (response.status < 200 || response.status >= 300) {
			throw this.buildHttpError(endpoint, response, inputs.length);
		}

		const payload = this.parseSuccessResponse(response, endpoint, inputs.length);
		const vectors = this.extractVectors(payload, inputs.length, endpoint);
		this.applyDimension(vectors[0].length, endpoint);
		return vectors;
	}

	private async sendRequest(
		endpoint: string,
		inputs: string[],
	): Promise<RequestUrlResponse> {
		const timeoutMs = this.getValidatedTimeoutMs();
		const requestPromise = requestUrl({
			url: endpoint,
			method: "POST",
			contentType: "application/json",
			headers: {
				Authorization: `Bearer ${this.getRequiredApiKey()}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.getRequiredModel(),
				input: inputs,
			}),
			throw: false,
		});

		try {
			return await this.withTimeout(requestPromise, timeoutMs, endpoint, inputs.length);
		} catch (error) {
			const diagnostic = normalizeErrorDiagnostic(error);
			if (diagnostic.code === "ERR_REMOTE_REQUEST_TIMEOUT") {
				throw error;
			}

			throw this.decorateError(error, {
				code: "ERR_REMOTE_REQUEST_NETWORK",
				stage: "request-send",
				details: [`url=${endpoint}`, `input_count=${inputs.length}`],
			});
		}
	}

	private parseSuccessResponse(
		response: RequestUrlResponse,
		endpoint: string,
		inputCount: number,
	): RemoteEmbeddingResponse {
		const text = response.text?.trim() ?? "";
		if (!text) {
			throw this.createDiagnosticError("Remote embeddings API returned an empty response body.", {
				code: "ERR_REMOTE_RESPONSE_JSON",
				stage: "response-json",
				details: [`status=${response.status}`, `url=${endpoint}`, `input_count=${inputCount}`],
			});
		}

		try {
			return JSON.parse(text) as RemoteEmbeddingResponse;
		} catch (error) {
			throw this.decorateError(error, {
				code: "ERR_REMOTE_RESPONSE_JSON",
				stage: "response-json",
				details: [
					`status=${response.status}`,
					`url=${endpoint}`,
					`input_count=${inputCount}`,
				],
			});
		}
	}

	private extractVectors(
		payload: RemoteEmbeddingResponse,
		expectedCount: number,
		endpoint: string,
	): Vector[] {
		if (!Array.isArray(payload.data)) {
			throw this.createDiagnosticError(
				"Remote embeddings API response is missing a data array.",
				{
					code: "ERR_REMOTE_RESPONSE_DATA",
					stage: "response-data",
					details: [`url=${endpoint}`, `expected_count=${expectedCount}`],
				},
			);
		}

		if (payload.data.length !== expectedCount) {
			throw this.createDiagnosticError(
				`Remote embeddings API returned ${payload.data.length} embeddings for ${expectedCount} inputs.`,
				{
					code: "ERR_REMOTE_RESPONSE_DATA_COUNT",
					stage: "response-data",
					details: [
						`url=${endpoint}`,
						`expected_count=${expectedCount}`,
						`received_count=${payload.data.length}`,
					],
				},
			);
		}

		const vectors = payload.data.map((item, index) =>
			this.parseEmbeddingItem(item as RemoteEmbeddingItem, index, endpoint),
		);

		if (vectors.length === 0) {
			throw this.createDiagnosticError("Remote embeddings API returned no embeddings.", {
				code: "ERR_REMOTE_EMBEDDING_EMPTY",
				stage: "response-embedding",
				details: [`url=${endpoint}`, `expected_count=${expectedCount}`],
			});
		}

		const batchDimension = vectors[0].length;
		for (let index = 1; index < vectors.length; index++) {
			if (vectors[index].length !== batchDimension) {
				throw this.createDiagnosticError(
					`Remote embeddings API returned inconsistent vector dimensions in one batch.`,
					{
						code: "ERR_REMOTE_EMBEDDING_DIMENSION",
						stage: "response-dimension",
						details: [
							`url=${endpoint}`,
							`expected_dimension=${batchDimension}`,
							`received_dimension=${vectors[index].length}`,
							`item_index=${index}`,
						],
					},
				);
			}
		}

		return vectors;
	}

	private parseEmbeddingItem(
		item: RemoteEmbeddingItem,
		index: number,
		endpoint: string,
	): Vector {
		if (!isRecord(item) || !Array.isArray(item.embedding) || item.embedding.length === 0) {
			throw this.createDiagnosticError(
				`Remote embeddings API response item ${index} has no embedding vector.`,
				{
					code: "ERR_REMOTE_EMBEDDING_MISSING",
					stage: "response-embedding",
					details: [`url=${endpoint}`, `item_index=${index}`],
				},
			);
		}

		if (
			item.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
		) {
			throw this.createDiagnosticError(
				`Remote embeddings API response item ${index} contains non-finite values.`,
				{
					code: "ERR_REMOTE_EMBEDDING_INVALID",
					stage: "response-embedding",
					details: [`url=${endpoint}`, `item_index=${index}`],
				},
			);
		}

		return item.embedding.map((value) => Number(value));
	}

	private applyDimension(nextDimension: number, endpoint: string): void {
		if (!Number.isInteger(nextDimension) || nextDimension <= 0) {
			throw this.createDiagnosticError("Remote embeddings API returned an invalid vector size.", {
				code: "ERR_REMOTE_EMBEDDING_DIMENSION",
				stage: "response-dimension",
				details: [`url=${endpoint}`, `received_dimension=${nextDimension}`],
			});
		}

		// bge-m3 dense vectors are commonly 1024 dims, but the plugin trusts the actual API response.
		if (this._dimension === 0) {
			this._dimension = nextDimension;
			return;
		}

		if (this._dimension !== nextDimension) {
			throw this.createDiagnosticError(
				`Remote embeddings dimension changed from ${this._dimension} to ${nextDimension}.`,
				{
					code: "ERR_REMOTE_EMBEDDING_DIMENSION",
					stage: "response-dimension",
					details: [
						`expected_dimension=${this._dimension}`,
						`received_dimension=${nextDimension}`,
						`url=${endpoint}`,
					],
				},
			);
		}
	}

	private buildHttpError(
		endpoint: string,
		response: RequestUrlResponse,
		inputCount: number,
	): Error {
		const responseText = response.text?.trim() ?? "";
		const message = this.extractHttpErrorMessage(response.status, responseText);
		return this.createDiagnosticError(message, {
			code: "ERR_REMOTE_RESPONSE_STATUS",
			stage: "response-status",
			details: [
				`status=${response.status}`,
				`url=${endpoint}`,
				`input_count=${inputCount}`,
			],
		});
	}

	private extractHttpErrorMessage(status: number, responseText: string): string {
		const parsed = this.tryParseJson(responseText);
		if (parsed) {
			const message =
				this.readFirstString(parsed.error) ??
				this.readFirstString(parsed.message) ??
				this.readFirstString(parsed.detail);
			if (message) {
				return `Remote embeddings API request failed with status ${status}: ${message}`;
			}
		}

		if (responseText) {
			return `Remote embeddings API request failed with status ${status}: ${responseText.slice(0, 300)}`;
		}

		return `Remote embeddings API request failed with status ${status}.`;
	}

	private tryParseJson(text: string): Record<string, unknown> | null {
		if (!text) {
			return null;
		}

		try {
			const parsed = JSON.parse(text);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	private readFirstString(value: unknown): string | undefined {
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				const nested = this.readFirstString(item);
				if (nested) {
					return nested;
				}
			}
			return undefined;
		}

		if (isRecord(value)) {
			for (const key of ["message", "detail", "type", "code"]) {
				const nested = this.readFirstString(value[key]);
				if (nested) {
					return nested;
				}
			}
		}

		return undefined;
	}

	private async withTimeout<T>(
		promise: Promise<T>,
		timeoutMs: number,
		endpoint: string,
		inputCount: number,
	): Promise<T> {
		let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

		return new Promise<T>((resolve, reject) => {
			timer = globalThis.setTimeout(() => {
				reject(
					this.createDiagnosticError(
						`Remote embeddings request timed out after ${timeoutMs}ms.`,
						{
							code: "ERR_REMOTE_REQUEST_TIMEOUT",
							stage: "request-timeout",
							details: [`timeout_ms=${timeoutMs}`, `url=${endpoint}`, `input_count=${inputCount}`],
						},
					),
				);
			}, timeoutMs);

			void promise.then(
				(value) => {
					if (timer !== undefined) {
						globalThis.clearTimeout(timer);
					}
					resolve(value);
				},
				(error) => {
					if (timer !== undefined) {
						globalThis.clearTimeout(timer);
					}
					reject(error);
				},
			);
		});
	}

	private getEmbeddingsEndpoint(): string {
		const baseUrl = normalizeRemoteBaseUrl(this.getRequiredBaseUrl());
		let url: URL;

		try {
			url = new URL(baseUrl);
		} catch {
			throw this.createDiagnosticError("Remote API Base URL is invalid.", {
				code: "ERR_REMOTE_BASE_URL_INVALID",
				stage: "provider-config",
				details: [`base_url=${baseUrl}`],
			});
		}

		const basePath = url.pathname.replace(/\/+$/, "");
		url.pathname = `${basePath}/v1/embeddings`.replace(/\/{2,}/g, "/");
		return url.toString();
	}

	private getRequiredBaseUrl(): string {
		if (!this.baseUrl.trim()) {
			throw this.createDiagnosticError("Remote API Base URL is required.", {
				code: "ERR_REMOTE_BASE_URL_MISSING",
				stage: "provider-config",
			});
		}
		return this.baseUrl.trim();
	}

	private getRequiredApiKey(): string {
		if (!this.apiKey.trim()) {
			throw this.createDiagnosticError("Remote API Key is required.", {
				code: "ERR_REMOTE_API_KEY_MISSING",
				stage: "provider-config",
			});
		}
		return this.apiKey.trim();
	}

	private getRequiredModel(): string {
		if (!this.model.trim()) {
			throw this.createDiagnosticError("Remote embedding model is required.", {
				code: "ERR_REMOTE_MODEL_MISSING",
				stage: "provider-config",
			});
		}
		return this.model.trim();
	}

	private getValidatedTimeoutMs(): number {
		if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
			throw this.createDiagnosticError("Remote timeout must be a positive integer.", {
				code: "ERR_REMOTE_TIMEOUT_INVALID",
				stage: "provider-config",
				details: [`timeout_ms=${this.timeoutMs}`],
			});
		}
		return this.timeoutMs;
	}

	private getValidatedBatchSize(): number {
		if (!Number.isInteger(this.batchSize) || this.batchSize <= 0) {
			throw this.createDiagnosticError("Remote batch size must be a positive integer.", {
				code: "ERR_REMOTE_BATCH_SIZE_INVALID",
				stage: "provider-config",
				details: [`batch_size=${this.batchSize}`],
			});
		}
		return this.batchSize;
	}

	private decorateError(
		error: unknown,
		fallback: {
			code: string;
			stage: string;
			details?: string[];
		},
	): Error {
		const diagnostic = normalizeErrorDiagnostic(error);
		return createErrorFromDiagnostic({
			message: diagnostic.message,
			name: diagnostic.name,
			code: diagnostic.code ?? fallback.code,
			stage: diagnostic.stage ?? fallback.stage,
			stack: diagnostic.stack,
			details: mergeErrorDetails(diagnostic.details, fallback.details),
		});
	}

	private createDiagnosticError(
		message: string,
		diagnostic: {
			code: string;
			stage: string;
			details?: string[];
		},
	): Error {
		return createErrorFromDiagnostic({
			message,
			code: diagnostic.code,
			stage: diagnostic.stage,
			details: diagnostic.details,
		});
	}
}
