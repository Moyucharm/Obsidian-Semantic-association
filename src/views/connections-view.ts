import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type SemanticConnectionsPlugin from "../main";
import type { ConnectionResult } from "../types";
import { debounce } from "../utils/debounce";

export const VIEW_TYPE_CONNECTIONS = "semantic-connections-view";

export class ConnectionsView extends ItemView {
	private plugin: SemanticConnectionsPlugin;
	private currentNotePath = "";
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
		return "Semantic Connections";
	}

	getIcon(): string {
		return "git-compare";
	}

	async onOpen(): Promise<void> {
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
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
		this.refreshRequestId++;
	}

	private async refreshView(force = false): Promise<void> {
		const file = this.app.workspace.getActiveFile();

		if (!file || file.extension !== "md") {
			this.refreshRequestId++;
			this.renderEmpty("Open a note to view semantic connections.");
			this.currentNotePath = "";
			return;
		}

		if (!force && file.path === this.currentNotePath) {
			return;
		}
		this.currentNotePath = file.path;
		const requestId = ++this.refreshRequestId;

		if (this.plugin.noteStore.size === 0) {
			this.renderEmpty("The index is empty. Please run Rebuild Index first.");
			return;
		}

		this.renderLoading();
		try {
			const results = await this.plugin.connectionsService.findConnections(
				file.path,
				this.plugin.settings.maxConnections,
			);
			if (this.isStaleRequest(requestId, file.path)) {
				return;
			}

			if (results.length === 0) {
				this.renderEmpty("No related notes found yet.");
			} else {
				this.renderResults(results);
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
			this.renderEmpty("Failed to load connections. Check the console or logs.");
		}
	}

	private isStaleRequest(requestId: number, expectedPath: string): boolean {
		if (requestId !== this.refreshRequestId) {
			return true;
		}
		const activeFile = this.app.workspace.getActiveFile();
		return !activeFile || activeFile.path !== expectedPath;
	}

	private renderEmpty(message: string): void {
		const container = this.containerEl.children[1];
		container.empty();
		container
			.createEl("div", { cls: "sc-placeholder" })
			.createEl("p", { text: message, cls: "sc-placeholder-text" });
	}

	private renderLoading(): void {
		const container = this.containerEl.children[1];
		container.empty();
		container
			.createEl("div", { cls: "sc-placeholder" })
			.createEl("p", { text: "Loading connections...", cls: "sc-placeholder-text" });
	}

	private renderResults(results: ConnectionResult[]): void {
		const container = this.containerEl.children[1];
		container.empty();

		const list = container.createEl("div", { cls: "sc-results-list" });
		for (const result of results) {
			this.renderResultItem(list, result);
		}
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
			this.app.workspace.openLinkText(result.notePath, "", false);
		});

		const scoreEl = header.createEl("span", {
			text: `${(result.score * 100).toFixed(1)}%`,
			cls: "sc-result-score",
		});
		scoreEl.setAttr(
			"title",
			`Combined ${(result.score * 100).toFixed(1)}% | note ${(result.noteScore * 100).toFixed(1)}% | passage ${(result.passageScore * 100).toFixed(1)}%`,
		);

		item.createEl("div", {
			text: result.notePath,
			cls: "sc-result-path",
		});

		if (result.bestPassage) {
			const passageEl = item.createEl("div", { cls: "sc-result-passage" });

			if (result.bestPassage.heading) {
				passageEl.createEl("div", {
					text: result.bestPassage.heading,
					cls: "sc-passage-heading",
				});
			}

			const previewText =
				result.bestPassage.text.length > 200
					? result.bestPassage.text.slice(0, 200) + "..."
					: result.bestPassage.text;

			passageEl.createEl("div", {
				text: previewText,
				cls: "sc-passage-text",
			});
		}
	}
}
