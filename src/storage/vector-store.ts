import type { Vector } from "../types";

interface VectorStoreData {
	version: number;
	vectors: Record<string, number[]>;
	dimension: number;
}

type VectorEntry = {
	vector: Float32Array;
	/** Precomputed 1 / ||vector|| to speed up cosine similarity. */
	invNorm: number;
};

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
	private vectors: Map<string, VectorEntry> = new Map();
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

		const nextVectors = new Map<string, VectorEntry>();
		let nextDimension =
			typeof data.dimension === "number" && Number.isInteger(data.dimension) && data.dimension > 0
				? data.dimension
				: 0;

		for (const [id, vec] of Object.entries(data.vectors)) {
			const expectedDimension = nextDimension === 0 ? undefined : nextDimension;
			const entry = this.createVectorEntry(vec, id, expectedDimension);
			if (nextDimension === 0) {
				nextDimension = entry.vector.length;
			}
			nextVectors.set(id, entry);
		}

		this.vectors = nextVectors;
		this.dimension = nextVectors.size > 0 ? nextDimension : 0;
	}

	serialize(): VectorStoreData {
		const vectors: Record<string, number[]> = {};
		for (const [id, entry] of this.vectors) {
			vectors[id] = Array.from(entry.vector);
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
		const floatView = new Float32Array(buffer);
		let floatOffset = 0;

		for (const id of ids) {
			const entry = this.vectors.get(id);
			if (!entry) {
				throw new Error(`VectorStore: missing vector for ${id} during binary serialization`);
			}

			floatView.set(entry.vector, floatOffset);
			floatOffset += this.dimension;
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

		const floats = new Float32Array(binary);

		for (let index = 0; index < metadata.ids.length; index++) {
			const id = metadata.ids[index];
			if (typeof id !== "string" || id.length === 0) {
				throw new Error("VectorStore: invalid vector id in binary metadata");
			}

			const start = index * metadata.dimension;
			const end = start + metadata.dimension;
			const vector = floats.subarray(start, end);

			this.vectors.set(id, {
				vector,
				invNorm: this.computeInvNorm(vector),
			});
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
		const entry = this.createVectorEntry(vector, id, expectedDimension);
		if (this.dimension === 0) {
			this.dimension = entry.vector.length;
		}

		this.vectors.set(id, entry);
	}

	setBatch(entries: Array<{ id: string; vector: Vector }>): void {
		for (const { id, vector } of entries) {
			this.set(id, vector);
		}
	}

	get(id: string): Vector | undefined {
		const entry = this.vectors.get(id);
		return entry ? Array.from(entry.vector) : undefined;
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
		const toMigrate: Array<{ oldId: string; newId: string; entry: VectorEntry }> = [];

		for (const [id, entry] of this.vectors) {
			if (id.startsWith(oldPrefix)) {
				const suffix = id.slice(oldPrefix.length);
				toMigrate.push({ oldId: id, newId: newPrefix + suffix, entry });
			}
		}

		for (const { oldId, newId, entry } of toMigrate) {
			this.vectors.delete(oldId);
			this.vectors.set(newId, entry);
		}
	}

	search(
		query: Vector,
		topK: number,
		filterFn?: (id: string) => boolean,
	): VectorSearchResult[] {
		if (!Number.isInteger(topK) || topK <= 0 || this.vectors.size === 0) {
			return [];
		}

		if (this.dimension > 0 && query.length !== this.dimension) {
			throw new Error(
				`VectorStore: query dimension mismatch, expected ${this.dimension}, got ${query.length}`,
			);
		}

		const { vector: queryVector, invNorm: queryInvNorm } = this.createVectorEntry(
			query,
			"__query__",
			this.dimension === 0 ? undefined : this.dimension,
		);
		if (!Number.isFinite(queryInvNorm) || queryInvNorm === 0) {
			return [];
		}

		const limit = Math.min(topK, this.vectors.size);
		const heap: VectorSearchResult[] = [];

		const swap = (a: number, b: number): void => {
			const tmp = heap[a];
			heap[a] = heap[b];
			heap[b] = tmp;
		};

		const siftUp = (index: number): void => {
			let current = index;
			while (current > 0) {
				const parent = (current - 1) >> 1;
				if (heap[parent].score <= heap[current].score) {
					return;
				}
				swap(parent, current);
				current = parent;
			}
		};

		const siftDown = (index: number): void => {
			let current = index;
			while (true) {
				const left = current * 2 + 1;
				if (left >= heap.length) {
					return;
				}
				const right = left + 1;
				const smallest =
					right < heap.length && heap[right].score < heap[left].score
						? right
						: left;
				if (heap[current].score <= heap[smallest].score) {
					return;
				}
				swap(current, smallest);
				current = smallest;
			}
		};

		for (const [id, entry] of this.vectors) {
			if (filterFn && !filterFn(id)) {
				continue;
			}

			const invNorm = entry.invNorm;
			if (!Number.isFinite(invNorm) || invNorm === 0) {
				continue;
			}

			const vec = entry.vector;
			let dotProduct = 0;
			for (let i = 0; i < vec.length; i++) {
				dotProduct += queryVector[i] * vec[i];
			}

			const score = dotProduct * queryInvNorm * invNorm;
			if (!Number.isFinite(score)) {
				continue;
			}
			if (heap.length < limit) {
				heap.push({ id, score });
				siftUp(heap.length - 1);
				continue;
			}

			if (score > heap[0].score) {
				heap[0].id = id;
				heap[0].score = score;
				siftDown(0);
			}
		}

		heap.sort((a, b) => b.score - a.score);
		return heap;
	}

	get size(): number {
		return this.vectors.size;
	}

	clear(): void {
		this.vectors.clear();
		this.dimension = 0;
	}

	private createVectorEntry(
		vector: unknown,
		id: string,
		expectedDimension?: number,
	): VectorEntry {
		if (!Array.isArray(vector) || vector.length === 0) {
			throw new Error(`VectorStore: invalid vector for ${id}`);
		}

		if (expectedDimension !== undefined && vector.length !== expectedDimension) {
			throw new Error(
				`VectorStore: dimension mismatch for ${id}, expected ${expectedDimension}, got ${vector.length}`,
			);
		}

		const output = new Float32Array(vector.length);
		let normSquared = 0;
		for (let i = 0; i < vector.length; i++) {
			const value = vector[i];
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error(`VectorStore: non-finite vector value for ${id}`);
			}
			output[i] = value;
			normSquared += value * value;
		}

		return {
			vector: output,
			invNorm: normSquared > 0 ? 1 / Math.sqrt(normSquared) : 0,
		};
	}

	private computeInvNorm(vector: Float32Array): number {
		let normSquared = 0;
		for (let i = 0; i < vector.length; i++) {
			const value = vector[i];
			if (!Number.isFinite(value)) {
				return 0;
			}
			normSquared += value * value;
		}
		if (!Number.isFinite(normSquared) || normSquared <= 0) {
			return 0;
		}
		return 1 / Math.sqrt(normSquared);
	}

	private resetDimensionIfEmpty(): void {
		if (this.vectors.size === 0) {
			this.dimension = 0;
		}
	}
}
