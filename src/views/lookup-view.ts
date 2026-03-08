/**
 * Lookup View - 语义搜索视图
 *
 * 职责：
 * - 提供搜索输入框，支持自然语言查询
 * - 调用 LookupService 执行段落级语义搜索
 * - 渲染搜索结果（笔记标题 + 最佳 passage）
 * - 仅负责 UI，搜索逻辑由 search/lookup-service 处理
 */

import { ItemView, WorkspaceLeaf } from "obsidian";
import type SemanticConnectionsPlugin from "../main";
import type { LookupResult } from "../types";
import { debounce } from "../utils/debounce";

/** 视图类型标识符 */
export const VIEW_TYPE_LOOKUP = "semantic-connections-lookup";

export class LookupView extends ItemView {
	private plugin: SemanticConnectionsPlugin;
	/** 搜索输入框引用 */
	private searchInput: HTMLInputElement | null = null;
	/** 结果容器引用 */
	private resultsContainer: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: SemanticConnectionsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_LOOKUP;
	}

	getDisplayText(): string {
		return "Semantic Search";
	}

	getIcon(): string {
		return "search";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1];
		container.empty();

		// 搜索输入区域
		const searchContainer = container.createEl("div", {
			cls: "sc-search-container",
		});
		this.searchInput = searchContainer.createEl("input", {
			type: "text",
			placeholder: "输入关键词进行语义搜索...",
			cls: "sc-search-input",
		});

		// 防抖搜索：用户停止输入 300ms 后执行
		const debouncedSearch = debounce(() => this.executeSearch(), 300);
		this.searchInput.addEventListener("input", debouncedSearch);

		// 回车立即搜索
		this.searchInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				this.executeSearch();
			}
		});

		// 结果容器
		this.resultsContainer = container.createEl("div", {
			cls: "sc-results-container",
		});
	}

	async onClose(): Promise<void> {
		this.searchInput = null;
		this.resultsContainer = null;
	}

	/** 执行语义搜索 */
	private async executeSearch(): Promise<void> {
		const query = this.searchInput?.value?.trim() || "";
		if (!this.resultsContainer) return;

		if (!query) {
			this.resultsContainer.empty();
			return;
		}

		// 检查索引状态
		if (this.plugin.noteStore.size === 0) {
			this.renderMessage("索引为空，请先执行「重建索引」命令");
			return;
		}

		this.renderMessage("正在搜索...");

		try {
			const results = await this.plugin.lookupService.search(
				query,
				this.plugin.settings.maxConnections,
			);

			if (results.length === 0) {
				this.renderMessage("未找到相关结果");
			} else {
				this.renderResults(results);
			}
		} catch (err) {
			console.error("LookupView: search failed", err);
			this.renderMessage("搜索失败，请查看控制台");
		}
	}

	/** 渲染提示消息 */
	private renderMessage(message: string): void {
		if (!this.resultsContainer) return;
		this.resultsContainer.empty();
		this.resultsContainer.createEl("div", { cls: "sc-placeholder" })
			.createEl("p", { text: message, cls: "sc-placeholder-text" });
	}

	/** 渲染搜索结果列表 */
	private renderResults(results: LookupResult[]): void {
		if (!this.resultsContainer) return;
		this.resultsContainer.empty();

		const list = this.resultsContainer.createEl("div", { cls: "sc-results-list" });

		for (const result of results) {
			this.renderResultItem(list, result);
		}
	}

	/**
	 * 渲染单条搜索结果
	 * 包含：标题、分数、路径、最佳 passage
	 */
	private renderResultItem(parent: Element, result: LookupResult): void {
		const item = parent.createEl("div", { cls: "sc-result-item" });

		// 标题行
		const header = item.createEl("div", { cls: "sc-result-header" });
		const titleEl = header.createEl("a", {
			text: result.title,
			cls: "sc-result-title",
		});
		titleEl.addEventListener("click", (e) => {
			e.preventDefault();
			this.app.workspace.openLinkText(result.notePath, "", false);
		});

		// 分数
		header.createEl("span", {
			text: `${(result.score * 100).toFixed(1)}%`,
			cls: "sc-result-score",
		});

		// 路径
		item.createEl("div", {
			text: result.notePath,
			cls: "sc-result-path",
		});

		// 最佳 passage
		if (result.passage) {
			const passageEl = item.createEl("div", { cls: "sc-result-passage" });

			if (result.passage.heading) {
				passageEl.createEl("div", {
					text: result.passage.heading,
					cls: "sc-passage-heading",
				});
			}

			const previewText = result.passage.text.length > 200
				? result.passage.text.slice(0, 200) + "..."
				: result.passage.text;

			passageEl.createEl("div", {
				text: previewText,
				cls: "sc-passage-text",
			});
		}
	}
}
