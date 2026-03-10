import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import type SemanticConnectionsPlugin from "../main";
import type { ConnectionResult } from "../types";
import { debounce } from "../utils/debounce";

export const VIEW_TYPE_CONNECTIONS = "semantic-connections-view";

export class ConnectionsView extends ItemView {
	private plugin: SemanticConnectionsPlugin;
	private currentNotePath = "";
	private lastMarkdownFile: TFile | null = null;
	private currentIndexVersion = -1;
	private refreshRequestId = 0;
	private scheduleRefresh = debounce((force: boolean = false) => {
		void this.refreshView(force);
	}, 300);

	constructor(leaf: WorkspaceLeaf, plugin: SemanticConnectionsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CONNECTIONS;
	}

	getDisplayText(): string {
		return "语义关联";
	}

	getIcon(): string {
		return "git-compare";
	}

	async onOpen(): Promise<void> {
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				const view = leaf?.view;
				if (view instanceof MarkdownView && view.file) {
					this.lastMarkdownFile = view.file;
				}
				void this.refreshView();
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") {
					return;
				}
				if (file.path !== this.currentNotePath) {
					return;
				}
				this.scheduleRefresh(true);
			}),
		);

		await this.refreshView();
	}

	async onClose(): Promise<void> {
		this.currentNotePath = "";
		this.lastMarkdownFile = null;
		this.currentIndexVersion = -1;
		this.refreshRequestId++;
	}

	onIndexVersionChanged(_version: number, _reason: string): void {
		void this.refreshView();
	}

	private async refreshView(force = false): Promise<void> {
		const file = this.getTargetFile();

		if (!file || file.extension !== "md") {
			this.refreshRequestId++;
			this.currentNotePath = "";
			this.currentIndexVersion = -1;
			this.renderEmpty("打开一篇笔记以查看语义关联。", null);
			return;
		}

		const indexVersion = this.plugin.indexVersion;
		if (
			!force &&
			file.path === this.currentNotePath &&
			indexVersion === this.currentIndexVersion
		) {
			return;
		}
		this.currentNotePath = file.path;
		this.currentIndexVersion = indexVersion;
		const requestId = ++this.refreshRequestId;

		if (this.plugin.noteStore.size === 0) {
			this.renderEmpty("索引为空，请先执行“重建索引”。", file);
			return;
		}

		this.renderLoading(file);
		try {
			const results = await this.plugin.connectionsService.findConnections(
				file.path,
				this.plugin.settings.maxConnections,
				{
					minSimilarityScore: this.plugin.settings.minSimilarityScore,
					maxPassagesPerNote: this.plugin.settings.maxPassagesPerNote,
					excludedFolders: this.plugin.settings.excludedFolders,
				},
			);
			if (this.isStaleRequest(requestId, file.path)) {
				return;
			}

			if (results.length === 0) {
				this.renderEmpty(
					"暂无关联笔记。建议尝试同步更多笔记或调整匹配阈值。",
					file,
				);
			} else {
				this.renderResults(results, file);
			}
		} catch (err) {
			if (this.isStaleRequest(requestId, file.path)) {
				return;
			}
			console.error("ConnectionsView: query failed", err);
			await this.plugin.logRuntimeError("connections-query", err, {
				errorType: "query",
				filePath: file.path,
				details: [
					`force_refresh=${force}`,
					`max_results=${this.plugin.settings.maxConnections}`,
				],
			});
			this.renderEmpty("加载关联结果失败，请检查控制台或日志。", file);
		}
	}

	/**
	 * When this view is in the right sidebar, it can become the active leaf.
	 * `workspace.getActiveFile()` would then be null, so we fall back to the most
	 * recently active leaf in the root split (the editor area).
	 */
	private getTargetFile(): TFile | null {
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile) {
			this.lastMarkdownFile = activeFile;
			return activeFile;
		}

		if (this.lastMarkdownFile) {
			return this.lastMarkdownFile;
		}

		const recentLeaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
		if (!recentLeaf) {
			return null;
		}

		const view = recentLeaf.view;
		if (view instanceof MarkdownView) {
			if (view.file) {
				this.lastMarkdownFile = view.file;
			}
			return view.file ?? null;
		}

		return null;
	}

	private isStaleRequest(requestId: number, expectedPath: string): boolean {
		if (requestId !== this.refreshRequestId) {
			return true;
		}
		const file = this.getTargetFile();
		return !file || file.path !== expectedPath;
	}

	private renderEmpty(message: string, file: TFile | null): void {
		const container = this.prepareContainer(file);
		container
			.createEl("div", { cls: "sc-placeholder" })
			.createEl("p", { text: message, cls: "sc-placeholder-text" });
	}

	private renderLoading(file: TFile): void {
		const container = this.prepareContainer(file);
		const placeholder = container.createEl("div", { cls: "sc-placeholder sc-loading" });
		placeholder.createEl("div", { cls: "sc-loading-spinner", attr: { "aria-label": "loading" } });
		placeholder.createEl("p", {
			text: "正在搜索关联笔记...",
			cls: "sc-placeholder-text",
		});
	}

	private renderResults(results: ConnectionResult[], file: TFile): void {
		const container = this.prepareContainer(file);

		const list = container.createEl("div", { cls: "sc-results-list" });
		for (const result of results) {
			this.renderResultItem(list, result);
		}
	}

	private prepareContainer(file: TFile | null): HTMLElement {
		const container = this.contentEl;
		container.empty();

		if (file) {
			const meta = this.plugin.noteStore.get(file.path);
			if (meta?.dirty || meta?.outdated) {
				this.renderDirtyBanner(container, file);
			}
		}

		return container;
	}

	private renderDirtyBanner(parent: HTMLElement, file: TFile): void {
		const banner = parent.createEl("div", { cls: "sc-dirty-banner" });
		banner.createEl("span", {
			text: "⚠️ 当前笔记内容已更新，关联结果可能过时",
		});

		const action = banner.createEl("a", {
			text: "[立即同步]",
			cls: "sc-dirty-banner-action",
			href: "#",
		});

		action.addEventListener("click", (event) => {
			event.preventDefault();
			if (this.plugin.isSyncing) {
				return;
			}

			action.addClass("is-disabled");
			action.setAttr("aria-disabled", "true");
			void this.plugin
				.syncNotes([file.path], { noticeTitle: "正在同步当前笔记..." })
				.finally(() => {
					void this.refreshView(true);
				});
		});
	}

	private mapSimilarityToPercent(rawScore: number): number {
		const score = Math.max(0, Math.min(1, rawScore));
		if (score <= 0.2) {
			return Math.round((score / 0.2) * 40);
		}
		if (score <= 0.5) {
			return Math.round(40 + ((score - 0.2) / 0.3) * 50);
		}
		return Math.round(90 + ((score - 0.5) / 0.5) * 10);
	}

	private renderResultItem(parent: Element, result: ConnectionResult): void {
		const item = parent.createEl("div", { cls: "sc-result-item" });

		const header = item.createEl("div", { cls: "sc-result-header" });
		const titleEl = header.createEl("a", {
			text: result.title,
			cls: "sc-result-title",
		});
		titleEl.addEventListener("click", (event) => {
			event.preventDefault();
			const range = this.plugin.chunkStore.get(result.bestPassage.chunkId)?.range;
			void this.plugin.openNoteInMainLeaf(result.notePath, range);
		});

		const rawSimilarity = result.bestPassage.score;
		const threshold = this.plugin.settings.minSimilarityScore;
		const isWeak = rawSimilarity < threshold;
		const mappedPercent = this.mapSimilarityToPercent(rawSimilarity);

		const scoreEl = header.createEl("span", {
			text: `匹配度 ${mappedPercent}%${isWeak ? " · 弱关联" : ""}`,
			cls: "sc-result-score",
		});
		scoreEl.setAttr(
			"title",
			[
				`阈值 ${(threshold * 100).toFixed(0)}%`,
				`段落(最高) ${(result.bestPassage.score * 100).toFixed(1)}%`,
				`段落(聚合) ${(result.passageScore * 100).toFixed(1)}%`,
				`笔记 ${(result.noteScore * 100).toFixed(1)}%`,
				`综合 ${(result.score * 100).toFixed(1)}%`,
			].join(" | "),
		);

		const bestChunk = this.plugin.chunkStore.get(result.bestPassage.chunkId);
		const headingText = (bestChunk?.heading ?? result.bestPassage.heading).trim();
		const snippetText = (bestChunk?.text ?? result.bestPassage.text).trim();
		const range = bestChunk?.range;

		const snippetEl = item.createEl("div", { cls: "sc-result-passage" });
		snippetEl.addEventListener("click", () => {
			void this.plugin.openNoteInMainLeaf(result.notePath, range);
		});
		snippetEl.setAttr(
			"title",
			`相似度 ${(rawSimilarity * 100).toFixed(1)}%${isWeak ? "（弱关联）" : ""}`,
		);

		if (headingText) {
			snippetEl.createEl("div", {
				text: headingText,
				cls: "sc-passage-heading",
			});
		}

		const previewText =
			snippetText.length > 200 ? snippetText.slice(0, 200) + "..." : snippetText;

		snippetEl.createEl("div", {
			text: previewText,
			cls: "sc-passage-text",
		});

		item.createEl("div", {
			text: result.notePath,
			cls: "sc-result-path",
		});
	}
}
