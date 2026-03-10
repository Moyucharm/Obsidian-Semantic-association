import type { ChunkMeta } from "../types";

type TextSpan = {
	text: string;
	startLine: number;
	endLine: number;
};

type Section = {
	heading: string;
	lines: string[];
	startLine: number;
};

// Chunk sizes are tuned for embedding-based semantic retrieval:
// - Too small → sparse context, similarity scores tend to be unstable/noisy.
// - Too large → topic dilution and harder passage localization.
// Target: ~300–500 chars per chunk by default.
const MIN_CHUNK_LENGTH = 120;
const MAX_CHUNK_LENGTH = 500;
const SOFT_SPLIT_FLOOR = Math.max(MIN_CHUNK_LENGTH, Math.floor(MAX_CHUNK_LENGTH * 0.6));
const SENTENCE_BOUNDARIES = ".!?;\u3002\uFF01\uFF1F\uFF1B";
const CLAUSE_BOUNDARIES = ",:\uFF0C\u3001\uFF1A";

export class Chunker {
	chunk(notePath: string, content: string): ChunkMeta[] {
		const normalizedContent = this.normalizeLineEndings(content);
		const { body, bodyStartLine } = this.stripFrontmatterWithOffset(normalizedContent);
		if (!body.trim()) {
			return [];
		}

		const sections = this.splitByHeadings(body, bodyStartLine);
		const chunks: ChunkMeta[] = [];
		let order = 0;

		for (const section of sections) {
			const sectionChunks = this.buildSectionChunks(section);
			for (const span of sectionChunks) {
				const trimmedText = span.text.trim();
				if (!trimmedText) {
					continue;
				}

				chunks.push({
					chunkId: `${notePath}#${order}`,
					notePath,
					heading: section.heading,
					text: trimmedText,
					order,
					range: [span.startLine, span.endLine],
				});
				order++;
			}
		}

		return chunks;
	}

	private normalizeLineEndings(content: string): string {
		return content.replace(/\r\n?/g, "\n");
	}

	private stripFrontmatterWithOffset(content: string): { body: string; bodyStartLine: number } {
		const match = content.match(/^---\n[\s\S]*?\n(?:---|\.\.\.)\n*/);
		if (!match) {
			return { body: content, bodyStartLine: 0 };
		}

		const frontmatter = match[0];
		return {
			body: content.slice(frontmatter.length),
			bodyStartLine: this.countNewlines(frontmatter),
		};
	}

	private splitByHeadings(content: string, bodyStartLine: number): Section[] {
		const sections: Section[] = [];
		const lines = content.split("\n");
		const headingStack: string[] = [];
		let currentHeading = "";
		let currentLines: string[] = [];
		let currentStartLine: number | null = null;
		let activeFenceMarker: string | null = null;

		const flushSection = (): void => {
			if (currentLines.length === 0 || currentStartLine === null) {
				currentLines = [];
				currentStartLine = null;
				return;
			}

			const { startIndex, endIndex } = this.trimLineIndices(currentLines);
			if (startIndex > endIndex) {
				currentLines = [];
				currentStartLine = null;
				return;
			}

			const slicedLines = currentLines.slice(startIndex, endIndex + 1);
			const text = slicedLines.join("\n").trim();
			if (!text) {
				currentLines = [];
				currentStartLine = null;
				return;
			}

			sections.push({
				heading: currentHeading,
				lines: slicedLines,
				startLine: currentStartLine + startIndex,
			});
			currentLines = [];
			currentStartLine = null;
		};

		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			const absoluteLine = bodyStartLine + index;
			if (!activeFenceMarker) {
				const headingMatch = this.matchHeading(line);
				if (headingMatch) {
					flushSection();
					headingStack[headingMatch.level - 1] = headingMatch.text;
					headingStack.length = headingMatch.level;
					currentHeading = headingStack.join(" / ");
					continue;
				}
			}

			if (currentLines.length === 0) {
				currentStartLine = absoluteLine;
			}
			currentLines.push(line);
			activeFenceMarker = this.updateFenceMarker(line, activeFenceMarker);
		}

		flushSection();

		if (sections.length > 0) {
			return sections;
		}

		const { startIndex, endIndex } = this.trimLineIndices(lines);
		if (startIndex > endIndex) {
			return [];
		}

		return [
			{
				heading: "",
				lines: lines.slice(startIndex, endIndex + 1),
				startLine: bodyStartLine + startIndex,
			},
		];
	}

	private buildSectionChunks(section: Section): TextSpan[] {
		const blocks = this.splitIntoBlocks(section);
		if (blocks.length === 0) {
			return [];
		}

		const chunks: TextSpan[] = [];
		let currentText = "";
		let currentStartLine = 0;
		let currentEndLine = 0;

		const flushCurrent = (): void => {
			const trimmed = currentText.trim();
			if (trimmed) {
				chunks.push({
					text: trimmed,
					startLine: currentStartLine,
					endLine: currentEndLine,
				});
			}
			currentText = "";
		};

		for (const block of blocks) {
			const fragments = this.splitOversizedSpan(block);
			for (const fragment of fragments) {
				if (!currentText) {
					currentText = fragment.text;
					currentStartLine = fragment.startLine;
					currentEndLine = fragment.endLine;
					continue;
				}

				const merged = `${currentText}\n\n${fragment.text}`;
				if (
					currentText.length < MIN_CHUNK_LENGTH ||
					merged.length <= MAX_CHUNK_LENGTH
				) {
					currentText = merged;
					currentEndLine = fragment.endLine;
					continue;
				}

				flushCurrent();
				currentText = fragment.text;
				currentStartLine = fragment.startLine;
				currentEndLine = fragment.endLine;
			}
		}

		if (currentText) {
			const trimmed = currentText.trim();
			const previous = chunks[chunks.length - 1];
			if (
				trimmed.length < MIN_CHUNK_LENGTH &&
				previous &&
				`${previous.text}\n\n${trimmed}`.length <= MAX_CHUNK_LENGTH
			) {
				previous.text = `${previous.text}\n\n${trimmed}`;
				previous.endLine = currentEndLine;
			} else {
				flushCurrent();
			}
		}

		return chunks.filter((chunk) => chunk.text.trim().length > 0);
	}

	private splitIntoBlocks(section: Section): TextSpan[] {
		const blocks: TextSpan[] = [];
		const lines = section.lines;
		let currentLines: string[] = [];
		let currentStartLine: number | null = null;
		let activeFenceMarker: string | null = null;

		const flushBlock = (): void => {
			if (currentLines.length === 0 || currentStartLine === null) {
				currentLines = [];
				currentStartLine = null;
				return;
			}

			const { startIndex, endIndex } = this.trimLineIndices(currentLines);
			if (startIndex > endIndex) {
				currentLines = [];
				currentStartLine = null;
				return;
			}

			const slicedLines = currentLines.slice(startIndex, endIndex + 1);
			const text = slicedLines.join("\n").trim();
			if (text) {
				blocks.push({
					text,
					startLine: currentStartLine + startIndex,
					endLine: currentStartLine + endIndex,
				});
			}
			currentLines = [];
			currentStartLine = null;
		};

		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			const absoluteLine = section.startLine + index;
			if (!activeFenceMarker && line.trim().length === 0) {
				flushBlock();
				continue;
			}

			if (currentLines.length === 0) {
				currentStartLine = absoluteLine;
			}
			currentLines.push(line);
			activeFenceMarker = this.updateFenceMarker(line, activeFenceMarker);
		}

		flushBlock();
		return blocks;
	}

	private splitOversizedSpan(span: TextSpan): TextSpan[] {
		const trimmedSpan = this.trimSpan(span);
		if (!trimmedSpan) {
			return [];
		}
		if (trimmedSpan.text.length <= MAX_CHUNK_LENGTH) {
			return [trimmedSpan];
		}

		const fragments: TextSpan[] = [];
		let remaining = trimmedSpan.text;
		let remainingStartLine = trimmedSpan.startLine;

		while (remaining.length > MAX_CHUNK_LENGTH) {
			const splitPoint = this.findSplitPoint(remaining, MAX_CHUNK_LENGTH);
			const rawSlice = remaining.slice(0, splitPoint);
			const fragment = rawSlice.trim();

			if (!fragment) {
				const fallbackRaw = remaining.slice(0, MAX_CHUNK_LENGTH);
				const fallback = fallbackRaw.trim();
				if (fallback) {
					fragments.push({
						text: fallback,
						...this.computeTrimmedRange(remainingStartLine, fallbackRaw),
					});
				}

				const rawRemaining = remaining.slice(MAX_CHUNK_LENGTH);
				const baseStartLine = remainingStartLine + this.countNewlines(fallbackRaw);
				const trimmedRemaining = this.trimStartWithLineOffset(
					rawRemaining,
					baseStartLine,
				);
				remaining = trimmedRemaining.text;
				remainingStartLine = trimmedRemaining.startLine;
				continue;
			}

			fragments.push({
				text: fragment,
				...this.computeTrimmedRange(remainingStartLine, rawSlice),
			});

			const rawRemaining = remaining.slice(splitPoint);
			const baseStartLine = remainingStartLine + this.countNewlines(rawSlice);
			const trimmedRemaining = this.trimStartWithLineOffset(rawRemaining, baseStartLine);
			remaining = trimmedRemaining.text;
			remainingStartLine = trimmedRemaining.startLine;
		}

		if (remaining) {
			const finalText = remaining.trim();
			if (finalText) {
				fragments.push({
					text: finalText,
					...this.computeTrimmedRange(remainingStartLine, remaining),
				});
			}
		}

		return fragments.filter((fragment) => fragment.text.length > 0);
	}

	private findSplitPoint(text: string, limit: number): number {
		const preferredBoundaries = ["\n", SENTENCE_BOUNDARIES, CLAUSE_BOUNDARIES, " \t"];
		for (const boundaryChars of preferredBoundaries) {
			const splitPoint = this.findLastBoundary(text, limit, boundaryChars, SOFT_SPLIT_FLOOR);
			if (splitPoint > 0) {
				return splitPoint;
			}
		}

		for (const boundaryChars of preferredBoundaries) {
			const splitPoint = this.findLastBoundary(text, limit, boundaryChars, 0);
			if (splitPoint > 0) {
				return splitPoint;
			}
		}

		return Math.min(limit, text.length);
	}

	private findLastBoundary(
		text: string,
		limit: number,
		boundaryChars: string,
		floor: number,
	): number {
		const start = Math.min(limit, text.length - 1);
		for (let index = start; index >= floor; index--) {
			if (boundaryChars.includes(text[index])) {
				return index + 1;
			}
		}
		return -1;
	}

	private matchHeading(line: string): { level: number; text: string } | null {
		const match = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
		if (!match) {
			return null;
		}

		const text = match[2].trim();
		if (!text) {
			return null;
		}

		return {
			level: match[1].length,
			text,
		};
	}

	private updateFenceMarker(line: string, activeMarker: string | null): string | null {
		const trimmed = line.trimStart();
		const fenceMatch = trimmed.match(/^(```+|~~~+)/);
		if (!fenceMatch) {
			return activeMarker;
		}

		const marker = fenceMatch[1];
		if (!activeMarker) {
			return marker;
		}

		return marker.startsWith(activeMarker[0]) ? null : activeMarker;
	}

	private trimLineIndices(lines: string[]): { startIndex: number; endIndex: number } {
		let startIndex = 0;
		while (startIndex < lines.length && lines[startIndex].trim().length === 0) {
			startIndex++;
		}

		let endIndex = lines.length - 1;
		while (endIndex >= startIndex && lines[endIndex].trim().length === 0) {
			endIndex--;
		}

		return { startIndex, endIndex };
	}

	private countNewlines(text: string): number {
		let count = 0;
		for (let index = 0; index < text.length; index++) {
			if (text[index] === "\n") {
				count++;
			}
		}
		return count;
	}

	private trimSpan(span: TextSpan): TextSpan | null {
		const trimmedText = span.text.trim();
		if (!trimmedText) {
			return null;
		}

		const trimStartText = span.text.trimStart();
		const leadingRemoved = span.text.slice(0, span.text.length - trimStartText.length);
		const leadingNewlines = this.countNewlines(leadingRemoved);

		const trimEndText = span.text.trimEnd();
		const trailingRemoved = span.text.slice(trimEndText.length);
		const trailingNewlines = this.countNewlines(trailingRemoved);

		return {
			text: trimmedText,
			startLine: span.startLine + leadingNewlines,
			endLine: span.endLine - trailingNewlines,
		};
	}

	private computeTrimmedRange(
		baseStartLine: number,
		rawText: string,
	): { startLine: number; endLine: number } {
		const trimStartText = rawText.trimStart();
		const leadingRemoved = rawText.slice(0, rawText.length - trimStartText.length);
		const leadingNewlines = this.countNewlines(leadingRemoved);

		const trimEndText = rawText.trimEnd();
		const trailingRemoved = rawText.slice(trimEndText.length);
		const trailingNewlines = this.countNewlines(trailingRemoved);

		const rawNewlines = this.countNewlines(rawText);
		return {
			startLine: baseStartLine + leadingNewlines,
			endLine: baseStartLine + rawNewlines - trailingNewlines,
		};
	}

	private trimStartWithLineOffset(
		rawText: string,
		baseStartLine: number,
	): { text: string; startLine: number } {
		const trimmedText = rawText.trimStart();
		const removed = rawText.slice(0, rawText.length - trimmedText.length);
		return {
			text: trimmedText,
			startLine: baseStartLine + this.countNewlines(removed),
		};
	}
}
