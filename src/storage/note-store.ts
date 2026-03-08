/**
 * NoteStore - 笔记元数据存储
 *
 * 负责 NoteMeta 的增删改查与持久化。
 * 数据以 JSON 文件形式存储在 vault 的 `.semantic-connections/` 目录下。
 *
 * 设计要点：
 * - 内存中维护 Map<path, NoteMeta> 作为主索引
 * - 提供批量操作以减少 IO 次数
 * - 持久化由调用方决定时机（调用 save）
 */

import type { NoteMeta } from "../types";

/** 持久化文件中的数据格式 */
interface NoteStoreData {
	version: number;
	notes: Record<string, NoteMeta>;
}

const CURRENT_VERSION = 1;

export class NoteStore {
	/** 内存索引：path -> NoteMeta */
	private notes: Map<string, NoteMeta> = new Map();

	/** 从持久化数据加载 */
	load(raw: unknown): void {
		this.notes.clear();

		if (!raw || typeof raw !== "object") return;

		const data = raw as NoteStoreData;
		if (data.version !== CURRENT_VERSION || !data.notes) return;

		for (const [path, meta] of Object.entries(data.notes)) {
			this.notes.set(path, meta);
		}
	}

	/** 导出为可持久化的数据结构 */
	serialize(): NoteStoreData {
		const notes: Record<string, NoteMeta> = {};
		for (const [path, meta] of this.notes) {
			notes[path] = meta;
		}
		return { version: CURRENT_VERSION, notes };
	}

	/** 获取单条笔记元数据 */
	get(path: string): NoteMeta | undefined {
		return this.notes.get(path);
	}

	/** 获取所有笔记元数据 */
	getAll(): NoteMeta[] {
		return Array.from(this.notes.values());
	}

	/** 获取所有已索引的笔记路径 */
	getAllPaths(): string[] {
		return Array.from(this.notes.keys());
	}

	/** 新增或更新笔记元数据 */
	set(meta: NoteMeta): void {
		this.notes.set(meta.path, meta);
	}

	/** 批量设置笔记元数据 */
	setBatch(metas: NoteMeta[]): void {
		for (const meta of metas) {
			this.notes.set(meta.path, meta);
		}
	}

	/** 删除指定路径的笔记 */
	delete(path: string): boolean {
		return this.notes.delete(path);
	}

	/**
	 * 处理文件重命名
	 * 将旧路径的元数据迁移到新路径
	 */
	rename(oldPath: string, newPath: string): void {
		const meta = this.notes.get(oldPath);
		if (!meta) return;

		this.notes.delete(oldPath);
		meta.path = newPath;
		this.notes.set(newPath, meta);
	}

	/** 判断路径是否已有索引 */
	has(path: string): boolean {
		return this.notes.has(path);
	}

	/** 当前已索引笔记数量 */
	get size(): number {
		return this.notes.size;
	}

	/** 清空所有数据 */
	clear(): void {
		this.notes.clear();
	}
}
