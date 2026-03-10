/**
 * PassageSelector - 最佳段落选取器
 *
 * 职责：
 * - 从候选笔记的 chunks 中选出与当前笔记最契合的一段文字
 * - 比较当前笔记的 chunk 向量与候选笔记的 chunk 向量
 * - 支持按阈值筛选并返回多个候选段落（passages）
 *
 * 这是实现"不只展示相关笔记，还展示最契合段落"的核心模块。
 */

import type { PassageResult, Vector } from "../types";
import { ChunkStore } from "../storage/chunk-store";
import { VectorStore } from "../storage/vector-store";

export class PassageSelector {
	constructor(
		private chunkStore: ChunkStore,
		private vectorStore: VectorStore,
	) {}

	/**
	 * 从候选笔记中选出匹配的 passages
	 *
	 * 算法：
	 * 1. 取候选笔记的所有 chunks
	 * 2. 对每个候选 chunk，计算它与当前笔记所有 chunks 的最大相似度
	 * 3. 按阈值过滤后按分数降序排序，并截断到 maxResults
	 *
	 * @param candidateNotePath   - 候选笔记路径
	 * @param currentChunkVectors - 当前笔记的所有 chunk 向量
	 * @returns 匹配的 passages（可能为空）
	 */
	selectMatches(
		candidateNotePath: string,
		currentChunkVectors: Vector[],
		options?: { minScore?: number; maxResults?: number },
	): PassageResult[] {
		const candidateChunks = this.chunkStore.getByNote(candidateNotePath);
		if (candidateChunks.length === 0 || currentChunkVectors.length === 0) {
			return [];
		}

		const minScore = options?.minScore ?? -Infinity;
		const maxResults = options?.maxResults ?? 0;
		const matches: PassageResult[] = [];

		for (const chunk of candidateChunks) {
			const chunkVector = this.vectorStore.get(chunk.chunkId);
			if (!chunkVector) continue;

			// 计算该候选 chunk 与当前笔记所有 chunks 的最大相似度
			const maxSim = this.maxSimilarity(chunkVector, currentChunkVectors);

			if (maxSim < minScore) {
				continue;
			}

			matches.push({
				chunkId: chunk.chunkId,
				heading: chunk.heading,
				text: chunk.text,
				score: maxSim,
			});
		}

		if (matches.length === 0) {
			return [];
		}

		matches.sort((a, b) => b.score - a.score);
		if (maxResults > 0) {
			return matches.slice(0, maxResults);
		}
		return matches;
	}

	/**
	 * 计算一个向量与一组向量的最大余弦相似度
	 */
	private maxSimilarity(target: Vector, candidates: Vector[]): number {
		let max = -Infinity;
		for (const candidate of candidates) {
			const sim = this.cosineSimilarity(target, candidate);
			if (sim > max) max = sim;
		}
		return max;
	}

	/**
	 * 余弦相似度
	 */
	private cosineSimilarity(a: Vector, b: Vector): number {
		if (a.length !== b.length) return 0;

		let dot = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < a.length; i++) {
			dot += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}

		const denom = Math.sqrt(normA) * Math.sqrt(normB);
		return denom === 0 ? 0 : dot / denom;
	}
}
