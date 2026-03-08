/**
 * Chunker - 笔记内容切分器
 *
 * 职责：
 * - 将一篇笔记的 Markdown 内容切分为多个语义块（chunks）
 * - 支持按标题块切分和按段落切分两种模式
 * - 不负责 embedding 和存储，只负责"切"
 *
 * 切分规则（v1）：
 * 1. 优先按标题（## / ### / #### 等）切分
 * 2. 标题之间的内容归入该标题块
 * 3. 没有标题的顶部内容作为第一个块
 * 4. 过短的块会被合并到前一个块
 */

import type { ChunkMeta } from "../types";

/** 切分时的最小块长度（字符数），过短的块会被合并 */
const MIN_CHUNK_LENGTH = 50;

export class Chunker {
	/**
	 * 将笔记内容切分为 chunks
	 *
	 * @param notePath - 笔记文件路径
	 * @param content  - 笔记原始 Markdown 内容
	 * @returns ChunkMeta 数组（不含 vector，vector 由 embedding 阶段填充）
	 */
	chunk(notePath: string, content: string): ChunkMeta[] {
		// 去除 frontmatter
		const body = this.removeFrontmatter(content);
		if (!body.trim()) return [];

		// 按标题切分为原始段落
		const rawSections = this.splitByHeadings(body);

		// 合并过短的段落
		const mergedSections = this.mergeShortSections(rawSections);

		// 转换为 ChunkMeta 结构
		return mergedSections.map((section, index) => ({
			chunkId: `${notePath}#${index}`,
			notePath,
			heading: section.heading,
			text: section.text.trim(),
			order: index,
		}));
	}

	/**
	 * 去除 frontmatter（--- ... ---）
	 */
	private removeFrontmatter(content: string): string {
		return content.replace(/^---[\s\S]*?---\n*/, "");
	}

	/**
	 * 按标题行切分内容
	 * 识别 Markdown 标题（# ~ ######），将内容分段
	 *
	 * @returns 原始段落列表，每段包含 heading 和 text
	 */
	private splitByHeadings(body: string): Section[] {
		const lines = body.split("\n");
		const sections: Section[] = [];
		let currentHeading = "";
		let currentLines: string[] = [];

		// 匹配 Markdown 标题行（# ~ ######）
		const headingRegex = /^(#{1,6})\s+(.+)$/;

		for (const line of lines) {
			const match = line.match(headingRegex);

			if (match) {
				// 遇到新标题：保存当前段落，开始新段落
				if (currentLines.length > 0 || currentHeading) {
					sections.push({
						heading: currentHeading,
						text: currentLines.join("\n"),
					});
				}
				currentHeading = match[2].trim();
				currentLines = [];
			} else {
				currentLines.push(line);
			}
		}

		// 保存最后一段
		if (currentLines.length > 0 || currentHeading) {
			sections.push({
				heading: currentHeading,
				text: currentLines.join("\n"),
			});
		}

		return sections;
	}

	/**
	 * 合并过短的段落到前一个段落
	 * 避免产生信息量过低的碎片 chunk
	 */
	private mergeShortSections(sections: Section[]): Section[] {
		if (sections.length <= 1) return sections;

		const merged: Section[] = [];

		for (const section of sections) {
			const textLength = section.text.trim().length;

			if (
				merged.length > 0 &&
				textLength < MIN_CHUNK_LENGTH &&
				!section.heading // 有标题的段落不合并，保留语义边界
			) {
				// 合并到前一个段落
				const prev = merged[merged.length - 1];
				prev.text += "\n" + section.text;
			} else {
				merged.push({ ...section });
			}
		}

		return merged;
	}
}

/** 内部数据结构：切分后的原始段落 */
interface Section {
	/** 段落标题（可为空） */
	heading: string;
	/** 段落正文内容 */
	text: string;
}
