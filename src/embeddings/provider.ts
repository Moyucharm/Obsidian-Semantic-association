import type { Vector } from "../types";

export interface EmbeddingProvider {
	readonly name: string;
	readonly dimension: number;

	embed(text: string): Promise<Vector>;
	embedBatch(texts: string[]): Promise<Vector[]>;
	prepare?(): Promise<number>;
	dispose?(): Promise<void>;
}
