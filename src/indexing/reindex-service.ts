/**
 * ReindexService - 索引服务
 *
 * 职责：
 * - 编排完整的索引流程：扫描 → 切分 → embedding → 存储
 * - 支持全量索引和单文件索引两种模式
 * - 处理文件删除和重命名的索引清理
 *
 * 数据流：
 * Scanner → Chunker → EmbeddingService → NoteStore + ChunkStore + VectorStore
 */

import { TFile, type Vault } from "obsidian";
import type { NoteMeta, ChunkMeta } from "../types";
import { Scanner } from "./scanner";
import { Chunker } from "./chunker";
import { EmbeddingService } from "../embeddings/embedding-service";
import { NoteStore } from "../storage/note-store";
import { ChunkStore } from "../storage/chunk-store";
import { VectorStore } from "../storage/vector-store";
import type { IndexTask } from "./reindex-queue";

export class ReindexService {
	constructor(
		private vault: Vault,
		private scanner: Scanner,
		private chunker: Chunker,
		private embeddingService: EmbeddingService,
		private noteStore: NoteStore,
		private chunkStore: ChunkStore,
		private vectorStore: VectorStore,
	) {}

	/**
	 * 全量索引
	 * 扫描 vault 中所有 Markdown 文件，构建完整索引
	 *
	 * @param excludedFolders - 排除的文件夹
	 * @param onProgress - 进度回调（已完成数, 总数）
	 */
	async indexAll(
		excludedFolders: string[],
		onProgress?: (done: number, total: number) => void,
	): Promise<void> {
		const files = this.scanner.getMarkdownFiles(excludedFolders);
		const total = files.length;

		for (let i = 0; i < files.length; i++) {
			await this.indexFile(files[i]);
			onProgress?.(i + 1, total);
		}

		console.log(`ReindexService: indexed ${total} files`);
	}

	/**
	 * 索引单个文件
	 * 完整流程：读取 → 构建元数据 → 切分 → 生成 embedding → 存储
	 */
	async indexFile(file: TFile): Promise<void> {
		// 1. 读取文件内容
		const content = await this.scanner.readContent(file);

		// 2. 构建 NoteMeta
		const noteMeta = this.scanner.buildNoteMeta(file, content);

		// 3. 检查是否需要重新索引（内容 hash 未变则跳过）
		const existing = this.noteStore.get(file.path);
		if (existing && existing.hash === noteMeta.hash) {
			return; // 内容未变，跳过
		}

		// 4. 切分为 chunks
		const chunks = this.chunker.chunk(file.path, content);

		// 5. 生成 embedding 向量
		const chunkTexts = chunks.map((c) => c.text);
		const chunkVectors = await this.embeddingService.embedBatch(chunkTexts);

		// 为每个 chunk 填充向量
		for (let i = 0; i < chunks.length; i++) {
			chunks[i].vector = chunkVectors[i];
		}

		// 6. 为 note-level 生成 embedding（使用摘要文本）
		if (noteMeta.summaryText) {
			noteMeta.vector = await this.embeddingService.embed(noteMeta.summaryText);
		}

		// 7. 写入存储
		this.noteStore.set(noteMeta);
		this.chunkStore.replaceByNote(file.path, chunks);

		// 写入向量存储
		if (noteMeta.vector) {
			this.vectorStore.set(file.path, noteMeta.vector);
		}
		for (const chunk of chunks) {
			if (chunk.vector) {
				this.vectorStore.set(chunk.chunkId, chunk.vector);
			}
		}
	}

	/**
	 * 处理队列中的单个索引任务
	 * 由 ReindexQueue 调用
	 */
	async processTask(task: IndexTask): Promise<void> {
		switch (task.type) {
			case "create":
			case "modify": {
				const file = this.vault.getAbstractFileByPath(task.path);
				if (file instanceof TFile) {
					await this.indexFile(file);
				}
				break;
			}
			case "delete": {
				this.removeFile(task.path);
				break;
			}
			case "rename": {
				if (task.oldPath) {
					this.renameFile(task.oldPath, task.path);
					// rename 后重新索引新路径的文件
					const file = this.vault.getAbstractFileByPath(task.path);
					if (file instanceof TFile) {
						await this.indexFile(file);
					}
				}
				break;
			}
		}
	}

	/**
	 * 删除文件的所有索引数据
	 */
	private removeFile(path: string): void {
		this.noteStore.delete(path);
		this.chunkStore.deleteByNote(path);
		// 删除 note 向量和所有 chunk 向量
		this.vectorStore.delete(path);
		this.vectorStore.deleteByPrefix(path + "#");
	}

	/**
	 * 处理文件重命名的索引迁移
	 */
	private renameFile(oldPath: string, newPath: string): void {
		this.noteStore.rename(oldPath, newPath);
		this.chunkStore.rename(oldPath, newPath);
		// 迁移向量：note 向量 + chunk 向量
		this.vectorStore.rename(oldPath, newPath);
	}
}
