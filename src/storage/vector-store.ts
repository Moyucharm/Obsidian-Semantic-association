/**
 * VectorStore - 向量存储与检索
 *
 * 负责向量的存储和最近邻搜索。
 * v1 采用内存暴力搜索（brute-force），后续可替换为 ANN 索引。
 *
 * 设计要点：
 * - 向量按 id 存储（id 可以是 notePath 或 chunkId）
 * - 搜索时遍历所有向量计算余弦相似度
 * - 支持按 id 前缀过滤（如只搜索特定笔记的 chunks）
 */

import type { Vector } from "../types";

/** 持久化数据格式 */
interface VectorStoreData {
	version: number;
	vectors: Record<string, number[]>;
	/** 向量维度（所有向量必须一致） */
	dimension: number;
}

const CURRENT_VERSION = 1;

/** 搜索结果项 */
export interface VectorSearchResult {
	id: string;
	score: number;
}

export class VectorStore {
	/** id -> 向量 */
	private vectors: Map<string, Vector> = new Map();
	/** 当前向量维度，由第一条写入的向量决定 */
	private dimension: number = 0;

	/** 从持久化数据加载 */
	load(raw: unknown): void {
		this.vectors.clear();
		this.dimension = 0;

		if (!raw || typeof raw !== "object") return;

		const data = raw as VectorStoreData;
		if (data.version !== CURRENT_VERSION || !data.vectors) return;

		this.dimension = data.dimension || 0;
		for (const [id, vec] of Object.entries(data.vectors)) {
			this.vectors.set(id, vec);
		}
	}

	/** 导出为可持久化的数据结构 */
	serialize(): VectorStoreData {
		const vectors: Record<string, number[]> = {};
		for (const [id, vec] of this.vectors) {
			vectors[id] = vec;
		}
		return { version: CURRENT_VERSION, vectors, dimension: this.dimension };
	}

	/** 写入一条向量 */
	set(id: string, vector: Vector): void {
		// 首次写入时确定维度
		if (this.dimension === 0) {
			this.dimension = vector.length;
		}
		this.vectors.set(id, vector);
	}

	/** 批量写入向量 */
	setBatch(entries: Array<{ id: string; vector: Vector }>): void {
		for (const { id, vector } of entries) {
			this.set(id, vector);
		}
	}

	/** 获取单条向量 */
	get(id: string): Vector | undefined {
		return this.vectors.get(id);
	}

	/** 删除单条向量 */
	delete(id: string): boolean {
		return this.vectors.delete(id);
	}

	/** 删除所有以指定前缀开头的向量（用于删除某笔记的所有 chunk 向量） */
	deleteByPrefix(prefix: string): void {
		for (const id of Array.from(this.vectors.keys())) {
			if (id.startsWith(prefix)) {
				this.vectors.delete(id);
			}
		}
	}

	/**
	 * 处理文件重命名：将旧前缀的向量迁移到新前缀
	 */
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

	/**
	 * 最近邻搜索（暴力遍历）
	 *
	 * @param query - 查询向量
	 * @param topK  - 返回最相似的 K 条结果
	 * @param filterFn - 可选过滤函数，用于排除特定 id
	 * @returns 按相似度降序排列的结果
	 */
	search(
		query: Vector,
		topK: number,
		filterFn?: (id: string) => boolean,
	): VectorSearchResult[] {
		const results: VectorSearchResult[] = [];

		for (const [id, vec] of this.vectors) {
			// 应用过滤条件（如排除当前笔记自身）
			if (filterFn && !filterFn(id)) continue;

			const score = this.cosineSimilarity(query, vec);
			results.push({ id, score });
		}

		// 按相似度降序排序，取 topK
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, topK);
	}

	/** 当前存储的向量数量 */
	get size(): number {
		return this.vectors.size;
	}

	/** 清空所有向量 */
	clear(): void {
		this.vectors.clear();
		this.dimension = 0;
	}

	/**
	 * 余弦相似度计算
	 * cos(A, B) = (A · B) / (|A| * |B|)
	 *
	 * @returns 相似度值，范围 [-1, 1]，越大越相似
	 */
	private cosineSimilarity(a: Vector, b: Vector): number {
		if (a.length !== b.length) return 0;

		let dotProduct = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < a.length; i++) {
			dotProduct += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}

		const denominator = Math.sqrt(normA) * Math.sqrt(normB);

		// 避免除以零
		if (denominator === 0) return 0;

		return dotProduct / denominator;
	}
}
