import type { Vector } from "../types";

interface VectorStoreData {
	version: number;
	vectors: Record<string, number[]>;
	dimension: number;
}

export interface VectorStoreBinaryMetadata {
	version: number;
	encoding: "float32-le";
	dimension: number;
	vectorCount: number;
	ids: string[];
}

export interface VectorStoreBreakdown {
	vectorCount: number;
	noteVectorCount: number;
	chunkVectorCount: number;
	dimension: number;
}

export interface VectorSearchResult {
	id: string;
	score: number;
}

const CURRENT_VERSION = 1;
const CURRENT_BINARY_VERSION = 2;

export class VectorStore {
	private vectors: Map<string, Vector> = new Map();
	private dimension = 0;

	load(raw: unknown): void {
		if (!raw || typeof raw !== "object") {
			this.clear();
			return;
		}

		const data = raw as VectorStoreData;
		if (data.version !== CURRENT_VERSION || !data.vectors) {
			this.clear();
			return;
		}

		const nextVectors = new Map<string, Vector>();
		let nextDimension =
			typeof data.dimension === "number" && Number.isInteger(data.dimension) && data.dimension > 0
				? data.dimension
				: 0;

		for (const [id, vec] of Object.entries(data.vectors)) {
			const validated = this.validateVector(vec, id, nextDimension);
			if (nextDimension === 0) {
				nextDimension = validated.length;
			}
			nextVectors.set(id, validated);
		}

		this.vectors = nextVectors;
		this.dimension = nextVectors.size > 0 ? nextDimension : 0;
	}

	serialize(): VectorStoreData {
		const vectors: Record<string, number[]> = {};
		for (const [id, vec] of this.vectors) {
			vectors[id] = vec;
		}

		return {
			version: CURRENT_VERSION,
			vectors,
			dimension: this.dimension,
		};
	}

	serializeBinary(): { metadata: VectorStoreBinaryMetadata; buffer: ArrayBuffer } {
		const ids = Array.from(this.vectors.keys());
		const buffer = new ArrayBuffer(ids.length * this.dimension * 4);
		const view = new DataView(buffer);
		let byteOffset = 0;

		for (const id of ids) {
			const vector = this.vectors.get(id);
			if (!vector) {
				throw new Error(`VectorStore: missing vector for ${id} during binary serialization`);
			}

			for (const value of vector) {
				view.setFloat32(byteOffset, value, true);
				byteOffset += 4;
			}
		}

		return {
			metadata: {
				version: CURRENT_BINARY_VERSION,
				encoding: "float32-le",
				dimension: this.dimension,
				vectorCount: ids.length,
				ids,
			},
			buffer,
		};
	}

	loadBinary(raw: unknown, binary: ArrayBuffer): void {
		this.clear();

		if (!raw || typeof raw !== "object") {
			throw new Error("VectorStore: invalid binary metadata");
		}

		const metadata = raw as VectorStoreBinaryMetadata;
		if (
			metadata.version !== CURRENT_BINARY_VERSION ||
			metadata.encoding !== "float32-le" ||
			!Array.isArray(metadata.ids)
		) {
			throw new Error("VectorStore: unsupported binary metadata");
		}

		if (!Number.isInteger(metadata.dimension) || metadata.dimension < 0) {
			throw new Error("VectorStore: invalid binary metadata dimension");
		}

		if (!Number.isInteger(metadata.vectorCount) || metadata.vectorCount < 0) {
			throw new Error("VectorStore: invalid binary metadata vector count");
		}

		if (metadata.ids.length !== metadata.vectorCount) {
			throw new Error("VectorStore: binary metadata ids/vectorCount mismatch");
		}

		const expectedBytes = metadata.vectorCount * metadata.dimension * 4;
		if (binary.byteLength !== expectedBytes) {
			throw new Error(
				`VectorStore: binary snapshot size mismatch, expected ${expectedBytes}, got ${binary.byteLength}`,
			);
		}

		const view = new DataView(binary);
		let byteOffset = 0;

		for (const id of metadata.ids) {
			if (typeof id !== "string" || id.length === 0) {
				throw new Error("VectorStore: invalid vector id in binary metadata");
			}

			const vector = new Array<number>(metadata.dimension);
			for (let i = 0; i < metadata.dimension; i++) {
				vector[i] = view.getFloat32(byteOffset, true);
				byteOffset += 4;
			}

			this.vectors.set(id, this.validateVector(vector, id, metadata.dimension));
		}

		this.dimension = metadata.vectorCount > 0 ? metadata.dimension : 0;
	}

	getBreakdown(): VectorStoreBreakdown {
		let noteVectorCount = 0;
		let chunkVectorCount = 0;

		for (const id of this.vectors.keys()) {
			if (id.includes("#")) {
				chunkVectorCount++;
			} else {
				noteVectorCount++;
			}
		}

		return {
			vectorCount: this.vectors.size,
			noteVectorCount,
			chunkVectorCount,
			dimension: this.dimension,
		};
	}

	set(id: string, vector: Vector): void {
		const expectedDimension = this.dimension === 0 ? undefined : this.dimension;
		const validated = this.validateVector(vector, id, expectedDimension);
		if (this.dimension === 0) {
			this.dimension = validated.length;
		}

		this.vectors.set(id, validated);
	}

	setBatch(entries: Array<{ id: string; vector: Vector }>): void {
		for (const { id, vector } of entries) {
			this.set(id, vector);
		}
	}

	get(id: string): Vector | undefined {
		return this.vectors.get(id);
	}

	delete(id: string): boolean {
		const deleted = this.vectors.delete(id);
		this.resetDimensionIfEmpty();
		return deleted;
	}

	deleteByPrefix(prefix: string): void {
		for (const id of Array.from(this.vectors.keys())) {
			if (id.startsWith(prefix)) {
				this.vectors.delete(id);
			}
		}

		this.resetDimensionIfEmpty();
	}

	rename(oldPrefix: string, newPrefix: string): void {
		const toMigrate: Array<{ oldId: string; newId: string; vector: Vector }> = [];

		for (const [id, vec] of this.vectors) {
			if (id.startsWith(oldPrefix)) {
				const suffix = id.slice(oldPrefix.length);
				toMigrate.push({ oldId: id, newId: newPrefix + suffix, vector: vec });
			}
		}

		for (const { oldId, newId, vector } of toMigrate) {
			this.vectors.delete(oldId);
			this.vectors.set(newId, vector);
		}
	}

	search(
		query: Vector,
		topK: number,
		filterFn?: (id: string) => boolean,
	): VectorSearchResult[] {
		if (this.dimension > 0 && query.length !== this.dimension) {
			throw new Error(
				`VectorStore: query dimension mismatch, expected ${this.dimension}, got ${query.length}`,
			);
		}

		const results: VectorSearchResult[] = [];

		for (const [id, vec] of this.vectors) {
			if (filterFn && !filterFn(id)) {
				continue;
			}

			const score = this.cosineSimilarity(query, vec);
			results.push({ id, score });
		}

		results.sort((a, b) => b.score - a.score);
		return results.slice(0, topK);
	}

	get size(): number {
		return this.vectors.size;
	}

	clear(): void {
		this.vectors.clear();
		this.dimension = 0;
	}

	private validateVector(
		vector: unknown,
		id: string,
		expectedDimension?: number,
	): Vector {
		if (!Array.isArray(vector) || vector.length === 0) {
			throw new Error(`VectorStore: invalid vector for ${id}`);
		}

		if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
			throw new Error(`VectorStore: non-finite vector value for ${id}`);
		}

		if (expectedDimension !== undefined && vector.length !== expectedDimension) {
			throw new Error(
				`VectorStore: dimension mismatch for ${id}, expected ${expectedDimension}, got ${vector.length}`,
			);
		}

		return vector;
	}

	private resetDimensionIfEmpty(): void {
		if (this.vectors.size === 0) {
			this.dimension = 0;
		}
	}

	private cosineSimilarity(a: Vector, b: Vector): number {
		if (a.length !== b.length) {
			return 0;
		}

		let dotProduct = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < a.length; i++) {
			dotProduct += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}

		const denominator = Math.sqrt(normA) * Math.sqrt(normB);
		if (denominator === 0) {
			return 0;
		}

		return dotProduct / denominator;
	}
}
