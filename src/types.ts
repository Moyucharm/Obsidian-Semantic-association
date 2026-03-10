/**
 * Shared plugin types.
 */

export type Vector = number[];

export interface ErrorDiagnostic {
	message: string;
	name?: string;
	code?: string;
	stage?: string;
	stack?: string;
	details?: string[];
}

export type RuntimeLogLevel = "info" | "warn";

export type RuntimeLogCategory =
	| "lifecycle"
	| "indexing"
	| "embedding"
	| "storage"
	| "configuration"
	| "query";

export interface RuntimeLogEntry {
	timestamp: number;
	event: string;
	level: RuntimeLogLevel;
	category: RuntimeLogCategory;
	message: string;
	provider?: string;
	details?: string[];
}

export interface NoteMeta {
	path: string;
	title: string;
	mtime: number;
	hash: string;
	/**
	 * 内容已变更但尚未重新索引（仅本地标记，不触发自动 embedding）。
	 * dirty/outdated 语义等价：outdated 为兼容字段。
	 */
	dirty?: boolean;
	outdated?: boolean;
	tags: string[];
	outgoingLinks: string[];
	summaryText: string;
	vector?: Vector;
}

export interface ChunkMeta {
	chunkId: string;
	notePath: string;
	heading: string;
	text: string;
	order: number;
	/**
	 * 0-based line range [startLine, endLine] in the source note.
	 * Used for precise navigation from search results.
	 */
	range: [number, number];
	vector?: Vector;
}

export interface ConnectionResult {
	notePath: string;
	title: string;
	score: number;
	noteScore: number;
	passageScore: number;
	bestPassage: PassageResult;
	passages: PassageResult[];
}

export interface PassageResult {
	chunkId: string;
	heading: string;
	text: string;
	score: number;
}

export interface LookupResult {
	notePath: string;
	title: string;
	passage: PassageResult;
	score: number;
}

export interface SemanticConnectionsSettings {
	maxConnections: number;
	minSimilarityScore: number;
	maxPassagesPerNote: number;
	excludedFolders: string[];
	embeddingProvider: "remote";
	autoIndex: boolean;
	autoOpenConnectionsView: boolean;
	/**
	 * 上次全量重建索引的时间戳（毫秒）。
	 *
	 * 用于启动时的“索引过期提醒”（例如 7 天未重建则提示用户）。
	 */
	lastFullRebuildAt: number;
	remoteBaseUrl: string;
	remoteApiKey: string;
	remoteModel: string;
	remoteTimeoutMs: number;
	remoteBatchSize: number;
}

export type ErrorLogType =
	| "embedding"
	| "scanning"
	| "chunking"
	| "storage"
	| "query"
	| "runtime"
	| "configuration"
	| "unknown";

export interface IndexErrorEntry {
	timestamp: number;
	filePath: string;
	errorType: ErrorLogType;
	message: string;
	provider?: string;
	errorName?: string;
	errorCode?: string;
	stage?: string;
	stack?: string;
	details?: string[];
}

export interface IndexSummary {
	total: number;
	failed: number;
}

export type RebuildIndexStage = "preparing" | "indexing" | "saving" | "success" | "error";

export interface RebuildIndexProgress {
	stage: RebuildIndexStage;
	message: string;
	done?: number;
	total?: number;
	percent?: number;
	file?: string;
	failed?: number;
	indexedNotes?: number;
}

export interface IndexStoragePartSummary {
	label: string;
	path: string;
	bytes: number;
	share: number;
}

export interface IndexStorageSummary {
	noteCount: number;
	chunkCount: number;
	vectorCount: number;
	noteVectorCount: number;
	chunkVectorCount: number;
	embeddingDimension: number;
	snapshotFormat: "missing" | "json-only" | "json+binary";
	parts: IndexStoragePartSummary[];
	totalBytes: number;
}

export const DEFAULT_SETTINGS: SemanticConnectionsSettings = {
	maxConnections: 20,
	minSimilarityScore: 0.25,
	maxPassagesPerNote: 5,
	excludedFolders: [],
	embeddingProvider: "remote",
	autoIndex: false,
	autoOpenConnectionsView: true,
	lastFullRebuildAt: 0,
	remoteBaseUrl: "",
	remoteApiKey: "",
	remoteModel: "BAAI/bge-m3",
	remoteTimeoutMs: 30_000,
	remoteBatchSize: 16,
};
