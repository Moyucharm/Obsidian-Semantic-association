/**
 * MockProvider - 开发测试用的 Mock Embedding Provider
 *
 * 职责：
 * - 在不依赖真实模型的情况下跑通全流程
 * - 生成基于文本内容的伪向量（非随机，同一文本产生相同向量）
 * - 保证语义相近的文本产生相对接近的向量
 *
 * 算法：
 * 使用字符频率统计生成固定维度的向量，
 * 相似文本会有相近的字符分布，从而产生接近的余弦相似度。
 * 这不是真正的语义理解，但足够用于开发调试。
 */

import type { Vector } from "../types";
import type { EmbeddingProvider } from "./provider";

/** Mock 向量维度 */
const MOCK_DIMENSION = 128;

export class MockProvider implements EmbeddingProvider {
	readonly name = "mock";
	readonly dimension = MOCK_DIMENSION;

	async embed(text: string): Promise<Vector> {
		return this.generateVector(text);
	}

	async embedBatch(texts: string[]): Promise<Vector[]> {
		return texts.map((text) => this.generateVector(text));
	}

	/**
	 * 基于字符频率生成伪向量
	 *
	 * 步骤：
	 * 1. 统计文本中每个字符的出现频率
	 * 2. 将频率映射到固定维度的向量槽位
	 * 3. 对向量做 L2 归一化
	 *
	 * 同一文本始终产生相同的向量（确定性）
	 */
	private generateVector(text: string): Vector {
		const vector = new Array<number>(MOCK_DIMENSION).fill(0);

		if (!text || text.length === 0) return vector;

		// 统计字符频率并映射到向量槽位
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i);
			const slot = code % MOCK_DIMENSION;
			vector[slot] += 1;
		}

		// L2 归一化：使向量长度为 1，便于余弦相似度计算
		const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
		if (norm > 0) {
			for (let i = 0; i < vector.length; i++) {
				vector[i] /= norm;
			}
		}

		return vector;
	}
}
