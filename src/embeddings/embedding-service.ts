/**
 * EmbeddingService - Embedding 调度层
 *
 * 职责：
 * - 根据用户设置选择对应的 EmbeddingProvider
 * - 提供统一的 embedding 调用入口
 * - 隔离上层模块与具体 provider 的耦合
 *
 * 遵循 DIP 原则：上层依赖此 service 而非具体 provider。
 */

import type { Vector } from "../types";
import type { EmbeddingProvider } from "./provider";
import { MockProvider } from "./mock-provider";

export class EmbeddingService {
	private provider: EmbeddingProvider;

	constructor(providerType: string = "mock") {
		this.provider = this.createProvider(providerType);
	}

	/** 当前使用的 provider 名称 */
	get providerName(): string {
		return this.provider.name;
	}

	/** 当前向量维度 */
	get dimension(): number {
		return this.provider.dimension;
	}

	/** 为单条文本生成 embedding */
	async embed(text: string): Promise<Vector> {
		return this.provider.embed(text);
	}

	/** 批量生成 embedding */
	async embedBatch(texts: string[]): Promise<Vector[]> {
		return this.provider.embedBatch(texts);
	}

	/**
	 * 切换 provider
	 * 用于用户在设置中更换 embedding 模型时调用
	 */
	switchProvider(providerType: string): void {
		this.provider = this.createProvider(providerType);
	}

	/**
	 * 根据类型创建对应的 provider 实例
	 * 遵循 OCP 原则：新增 provider 只需在此处添加分支
	 */
	private createProvider(type: string): EmbeddingProvider {
		switch (type) {
			case "mock":
				return new MockProvider();
			// TODO: case "local": return new LocalProvider();
			// TODO: case "remote": return new RemoteProvider();
			default:
				console.warn(`Unknown embedding provider: ${type}, falling back to mock`);
				return new MockProvider();
		}
	}
}
