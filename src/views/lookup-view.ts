import { ItemView, WorkspaceLeaf } from "obsidian";
import type SemanticConnectionsPlugin from "../main";
import type { LookupResult } from "../types";
import { debounce } from "../utils/debounce";

export const VIEW_TYPE_LOOKUP = "semantic-connections-lookup";

export class LookupView extends ItemView {
	private plugin: SemanticConnectionsPlugin;
	private searchInput: HTMLInputElement | null = null;
	private resultsContainer: HTMLElement | null = null;
	private searchRequestId = 0;

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

		const searchContainer = container.createEl("div", {
			cls: "sc-search-container",
		});
		this.searchInput = searchContainer.createEl("input", {
			type: "text",
			placeholder: "Enter text to run semantic search...",
			cls: "sc-search-input",
		});

		const debouncedSearch = debounce(() => this.executeSearch(), 300);
		this.searchInput.addEventListener("input", debouncedSearch);
		this.searchInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				void this.executeSearch();
			}
		});

		this.resultsContainer = container.createEl("div", {
			cls: "sc-results-container",
		});
	}

	async onClose(): Promise<void> {
		this.searchInput = null;
		this.resultsContainer = null;
		this.searchRequestId++;
	}

	private async executeSearch(): Promise<void> {
		const query = this.searchInput?.value?.trim() || "";
		if (!this.resultsContainer) {
			return;
		}

		if (!query) {
			this.searchRequestId++;
			this.resultsContainer.empty();
			return;
		}
		const requestId = ++this.searchRequestId;

		if (this.plugin.noteStore.size === 0) {
			this.renderMessage("The index is empty. Please run Rebuild Index first.");
			return;
		}

		this.renderMessage("Searching...");

		try {
			const results = await this.plugin.lookupService.search(
				query,
				this.plugin.settings.maxConnections,
			);
			if (this.isStaleSearch(requestId, query)) {
				return;
			}

			if (results.length === 0) {
				this.renderMessage("No matching results found.");
			} else {
				this.renderResults(results);
			}
		} catch (err) {
			if (this.isStaleSearch(requestId, query)) {
				return;
			}
			console.error("LookupView: search failed", err);
			await this.plugin.logRuntimeError("lookup-search", err, {
				errorType: "query",
				details: [
					`query_length=${query.length}`,
					`max_results=${this.plugin.settings.maxConnections}`,
				],
			});
			this.renderMessage("Search failed. Check the console or logs.");
		}
	}

	private isStaleSearch(requestId: number, expectedQuery: string): boolean {
		if (requestId !== this.searchRequestId) {
			return true;
		}
		const currentQuery = this.searchInput?.value?.trim() || "";
		return currentQuery !== expectedQuery;
	}

	private renderMessage(message: string): void {
		if (!this.resultsContainer) {
			return;
		}
		this.resultsContainer.empty();
		this.resultsContainer
			.createEl("div", { cls: "sc-placeholder" })
			.createEl("p", { text: message, cls: "sc-placeholder-text" });
	}

	private renderResults(results: LookupResult[]): void {
		if (!this.resultsContainer) {
			return;
		}
		this.resultsContainer.empty();

		const list = this.resultsContainer.createEl("div", { cls: "sc-results-list" });
		for (const result of results) {
			this.renderResultItem(list, result);
		}
	}

	private renderResultItem(parent: Element, result: LookupResult): void {
		const item = parent.createEl("div", { cls: "sc-result-item" });

		const header = item.createEl("div", { cls: "sc-result-header" });
		const titleEl = header.createEl("a", {
			text: result.title,
			cls: "sc-result-title",
		});
		titleEl.addEventListener("click", (event) => {
			event.preventDefault();
			this.app.workspace.openLinkText(result.notePath, "", false);
		});

		header.createEl("span", {
			text: `${(result.score * 100).toFixed(1)}%`,
			cls: "sc-result-score",
		});

		item.createEl("div", {
			text: result.notePath,
			cls: "sc-result-path",
		});

		if (result.passage) {
			const passageEl = item.createEl("div", { cls: "sc-result-passage" });

			if (result.passage.heading) {
				passageEl.createEl("div", {
					text: result.passage.heading,
					cls: "sc-passage-heading",
				});
			}

			const previewText =
				result.passage.text.length > 200
					? result.passage.text.slice(0, 200) + "..."
					: result.passage.text;

			passageEl.createEl("div", {
				text: previewText,
				cls: "sc-passage-text",
			});
		}
	}
}
