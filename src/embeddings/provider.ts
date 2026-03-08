/**
 * EmbeddingProvider - 向量生成接口
 *
 * 定义统一的 embedding 调用契约，
 * 所有 provider（mock / local / remote）都必须实现此接口。
 *
 * 遵循 ISP 原则：接口只包含 embedding 生成所需的最小方法集。
 */

import type { Vector } from "../types";

export interface EmbeddingProvider {
	/** provider 名称标识 */
	readonly name: string;

	/** 输出向量的维度 */
	readonly dimension: number;

	/**
	 * 为单条文本生成 embedding 向量
	 *
	 * @param text - 输入文本
	 * @returns 向量
	 */
	embed(text: string): Promise<Vector>;

	/**
	 * 为多条文本批量生成 embedding 向量
	 * 默认实现为逐条调用 embed，provider 可覆盖以优化批量性能
	 *
	 * @param texts - 输入文本数组
	 * @returns 向量数组，与输入一一对应
	 */
	embedBatch(texts: string[]): Promise<Vector[]>;
}
