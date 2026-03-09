import type { RuntimeLogLevel } from "../types";

export interface LocalModelInfo {
	id: string;
	name: string;
	dimension: number;
	description: string;
	sizeHints: Record<string, string>;
}

export const SUPPORTED_LOCAL_MODELS: LocalModelInfo[] = [
	{
		id: "Xenova/bge-small-zh-v1.5",
		name: "bge-small-zh-v1.5 (Chinese, 512d)",
		dimension: 512,
		description: "Lightweight Chinese model with fast inference.",
		sizeHints: { fp32: "~95MB", fp16: "~48MB", q8: "~24MB", q4: "~52MB" },
	},
	{
		id: "Xenova/bge-base-zh-v1.5",
		name: "bge-base-zh-v1.5 (Chinese, 768d)",
		dimension: 768,
		description: "Balanced Chinese model recommended for general use.",
		sizeHints: { fp32: "~407MB", fp16: "~204MB", q8: "~102MB", q4: "~120MB" },
	},
	{
		id: "Xenova/bge-large-zh-v1.5",
		name: "bge-large-zh-v1.5 (Chinese, 1024d)",
		dimension: 1024,
		description: "Largest Chinese model with the best quality and slower inference.",
		sizeHints: { fp32: "~1.3GB", fp16: "~650MB", q8: "~326MB", q4: "~279MB" },
	},
];

export interface LocalModelProgress {
	status: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
}

export interface LocalRuntimeConfig {
	modelId: string;
	dimension: number;
	cachePath: string;
	dtype?: string;
	allowRemoteModels?: boolean;
}

export type LocalRuntimeMode = "worker" | "web-worker" | "inline";

export interface LocalProviderRuntimeEvent {
	event: "local-runtime-mode-selected";
	mode: LocalRuntimeMode;
	level?: RuntimeLogLevel;
	message: string;
	details?: string[];
}

export interface LocalProviderConfig extends LocalRuntimeConfig {
	workerScriptPath: string;
	webWorkerScriptPath: string;
	onProgress?: (progress: LocalModelProgress) => void;
	onRuntimeEvent?: (event: LocalProviderRuntimeEvent) => void;
}
