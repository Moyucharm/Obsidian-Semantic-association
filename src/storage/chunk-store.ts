/**
 * ChunkStore - 语义块元数据存储
 *
 * 负责 ChunkMeta 的增删改查与持久化。
 * 每个 chunk 通过 chunkId（`${notePath}#${order}`）唯一标识。
 *
 * 设计要点：
 * - 内存中维护两级索引：
 *   1. chunkId -> ChunkMeta（全局查找）
 *   2. notePath -> ChunkMeta[]（按笔记聚合查询）
 * - 删除笔记时需级联清除其所有 chunks
 */

import type { ChunkMeta } from "../types";

/** 持久化文件中的数据格式 */
interface ChunkStoreData {
	version: number;
	chunks: Record<string, ChunkMeta>;
}

const CURRENT_VERSION = 1;

export class ChunkStore {
	/** 全局索引：chunkId -> ChunkMeta */
	private chunks: Map<string, ChunkMeta> = new Map();
	/** 按笔记聚合索引：notePath -> chunkId[] */
	private noteChunks: Map<string, string[]> = new Map();

	/** 从持久化数据加载，同时重建 noteChunks 索引 */
	load(raw: unknown): void {
		this.chunks.clear();
		this.noteChunks.clear();

		if (!raw || typeof raw !== "object") return;

		const data = raw as ChunkStoreData;
		if (data.version !== CURRENT_VERSION || !data.chunks) return;

		for (const [id, chunk] of Object.entries(data.chunks)) {
			this.chunks.set(id, chunk);
			this.addToNoteIndex(chunk.notePath, id);
		}
	}

	/** 导出为可持久化的数据结构 */
	serialize(): ChunkStoreData {
		const chunks: Record<string, ChunkMeta> = {};
		for (const [id, chunk] of this.chunks) {
			chunks[id] = chunk;
		}
		return { version: CURRENT_VERSION, chunks };
	}

	/** 获取单个 chunk */
	get(chunkId: string): ChunkMeta | undefined {
		return this.chunks.get(chunkId);
	}

	/** 获取指定笔记的所有 chunks，按 order 排序 */
	getByNote(notePath: string): ChunkMeta[] {
		const ids = this.noteChunks.get(notePath);
		if (!ids) return [];

		return ids
			.map((id) => this.chunks.get(id))
			.filter((c): c is ChunkMeta => c !== undefined)
			.sort((a, b) => a.order - b.order);
	}

	/** 获取所有 chunks */
	getAll(): ChunkMeta[] {
		return Array.from(this.chunks.values());
	}

	/** 新增或更新 chunk */
	set(chunk: ChunkMeta): void {
		this.chunks.set(chunk.chunkId, chunk);
		this.addToNoteIndex(chunk.notePath, chunk.chunkId);
	}

	/**
	 * 替换指定笔记的所有 chunks
	 * 先清除旧数据，再写入新数据（用于文件修改后重新切分）
	 */
	replaceByNote(notePath: string, chunks: ChunkMeta[]): void {
		this.deleteByNote(notePath);
		for (const chunk of chunks) {
			this.set(chunk);
		}
	}

	/** 删除指定笔记的所有 chunks（级联删除） */
	deleteByNote(notePath: string): void {
		const ids = this.noteChunks.get(notePath);
		if (!ids) return;

		for (const id of ids) {
			this.chunks.delete(id);
		}
		this.noteChunks.delete(notePath);
	}

	/**
	 * 处理文件重命名
	 * 需要更新所有相关 chunk 的 notePath 和 chunkId
	 */
	rename(oldPath: string, newPath: string): void {
		const oldChunks = this.getByNote(oldPath);
		if (oldChunks.length === 0) return;

		// 清除旧索引
		this.deleteByNote(oldPath);

		// 用新路径重新写入
		for (const chunk of oldChunks) {
			chunk.notePath = newPath;
			chunk.chunkId = `${newPath}#${chunk.order}`;
			this.set(chunk);
		}
	}

	/** 当前 chunk 总数 */
	get size(): number {
		return this.chunks.size;
	}

	/** 清空所有数据 */
	clear(): void {
		this.chunks.clear();
		this.noteChunks.clear();
	}

	/** 将 chunkId 添加到 noteChunks 索引中（内部方法） */
	private addToNoteIndex(notePath: string, chunkId: string): void {
		const ids = this.noteChunks.get(notePath);
		if (ids) {
			if (!ids.includes(chunkId)) {
				ids.push(chunkId);
			}
		} else {
			this.noteChunks.set(notePath, [chunkId]);
		}
	}
}
