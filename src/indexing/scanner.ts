/**
 * Scanner - Vault 文件扫描器
 *
 * 职责：
 * - 扫描 vault 中所有 Markdown 文件
 * - 根据排除规则过滤文件
 * - 读取文件内容和元数据
 * - 提取 tags、outgoing links 等信息
 *
 * 不负责索引和存储，只负责"发现并读取"。
 */

import { TFile, Vault, MetadataCache, CachedMetadata } from "obsidian";
import type { NoteMeta } from "../types";
import { hashContent } from "../utils/hash";

export class Scanner {
	constructor(
		private vault: Vault,
		private metadataCache: MetadataCache,
	) {}

	/**
	 * 扫描 vault 中所有符合条件的 Markdown 文件
	 *
	 * @param excludedFolders - 排除的文件夹列表
	 * @returns 符合条件的 TFile 列表
	 */
	getMarkdownFiles(excludedFolders: string[]): TFile[] {
		return this.vault.getMarkdownFiles().filter((file) => {
			// 排除指定文件夹中的文件
			return !excludedFolders.some((folder) =>
				file.path.startsWith(folder + "/") || file.path === folder
			);
		});
	}

	/**
	 * 读取单个文件内容
	 */
	async readContent(file: TFile): Promise<string> {
		return this.vault.cachedRead(file);
	}

	/**
	 * 为单个文件构建 NoteMeta
	 * 从文件内容和 Obsidian 缓存中提取所需信息
	 *
	 * @param file    - 目标文件
	 * @param content - 文件内容（已读取）
	 * @returns 笔记元数据
	 */
	buildNoteMeta(file: TFile, content: string): NoteMeta {
		const cache = this.metadataCache.getFileCache(file);

		return {
			path: file.path,
			title: this.extractTitle(file, cache),
			mtime: file.stat.mtime,
			hash: hashContent(content),
			tags: this.extractTags(cache),
			outgoingLinks: this.extractLinks(cache),
			summaryText: this.extractSummary(content),
		};
	}

	/**
	 * 提取笔记标题
	 * 优先级：frontmatter title > 首个 h1 标题 > 文件名
	 */
	private extractTitle(file: TFile, cache: CachedMetadata | null): string {
		// 1. 尝试 frontmatter title
		if (cache?.frontmatter?.title) {
			return cache.frontmatter.title;
		}

		// 2. 尝试首个 h1 标题
		if (cache?.headings) {
			const h1 = cache.headings.find((h) => h.level === 1);
			if (h1) return h1.heading;
		}

		// 3. 回退到文件名（去掉扩展名）
		return file.basename;
	}

	/**
	 * 从缓存中提取所有标签
	 * 合并 frontmatter tags 和正文内联 tags
	 */
	private extractTags(cache: CachedMetadata | null): string[] {
		const tags = new Set<string>();

		// frontmatter 中的 tags
		if (cache?.frontmatter?.tags) {
			const fmTags = cache.frontmatter.tags;
			if (Array.isArray(fmTags)) {
				fmTags.forEach((t: string) => tags.add(t));
			} else if (typeof fmTags === "string") {
				tags.add(fmTags);
			}
		}

		// 正文中的 #tag
		if (cache?.tags) {
			cache.tags.forEach((t) => tags.add(t.tag.replace(/^#/, "")));
		}

		return Array.from(tags);
	}

	/**
	 * 从缓存中提取出链（outgoing links）
	 * 包含 [[wikilinks]] 和 [markdown](links)
	 */
	private extractLinks(cache: CachedMetadata | null): string[] {
		const links: string[] = [];

		if (cache?.links) {
			cache.links.forEach((link) => {
				if (link.link) links.push(link.link);
			});
		}

		return links;
	}

	/**
	 * 提取摘要文本
	 * 取正文前 500 字符作为 note-level embedding 的输入
	 * 跳过 frontmatter 部分
	 */
	private extractSummary(content: string): string {
		// 去掉 frontmatter（--- ... ---）
		const withoutFm = content.replace(/^---[\s\S]*?---\n*/, "");
		// 取前 500 字符
		return withoutFm.slice(0, 500).trim();
	}
}
