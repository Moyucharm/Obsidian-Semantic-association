/**
 * Plugin settings UI.
 */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SemanticConnectionsPlugin from "./main";
import {
	DEFAULT_SETTINGS,
	type IndexErrorEntry,
	type RebuildIndexProgress,
	type RuntimeLogEntry,
} from "./types";
import { normalizeRemoteBaseUrl } from "./embeddings/remote-provider";

export class SettingTab extends PluginSettingTab {
	private plugin: SemanticConnectionsPlugin;

	constructor(app: App, plugin: SemanticConnectionsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Semantic Connections Settings" });
		this.renderRemoteSettings(containerEl);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("One folder path per line. These folders are skipped during indexing.")
			.addTextArea((text) =>
				text
					.setPlaceholder("templates\narchive")
					.setValue(this.plugin.settings.excludedFolders.join("\n"))
					.onChange(async (value) => {
						const previousValue = [...this.plugin.settings.excludedFolders];
						this.plugin.settings.excludedFolders = value
							.split("\n")
							.map((item) => item.trim())
							.filter((item) => item.length > 0);
						const saved = await this.saveSettingsOrRollback("excluded-folders", () => {
							this.plugin.settings.excludedFolders = previousValue;
						});
						if (saved) {
							new Notice(
								"Excluded folders updated. Rebuild the index to apply them to existing data.",
								6000,
							);
						}
					}),
			);

		this.renderIndexManagement(containerEl);
		this.renderLogSection(containerEl);
	}

	private renderRemoteSettings(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "Remote embeddings" });

		new Setting(containerEl)
			.setName("API Base URL")
			.setDesc("Requests are sent to {baseUrl}/v1/embeddings.")
			.addText((text) => {
				const commit = async (): Promise<void> => {
					const previousValue = this.plugin.settings.remoteBaseUrl;
					const nextValue = normalizeRemoteBaseUrl(text.getValue());
					this.plugin.settings.remoteBaseUrl = nextValue;
					const saved = await this.saveSettingsOrRollback(
						"remote-base-url",
						() => {
							this.plugin.settings.remoteBaseUrl = previousValue;
						},
						{ refresh: false },
					);
					if (!saved) {
						text.setValue(previousValue);
						return;
					}

					text.setValue(this.plugin.settings.remoteBaseUrl);
					this.plugin.embeddingService.switchProvider(this.plugin.settings);
					if (previousValue !== nextValue) {
						this.invalidateIndex(
							"Remote API Base URL changed. The existing index was cleared. Please rebuild the index.",
						);
					}
				};

				text
					.setPlaceholder("https://your-api.example.com")
					.setValue(this.plugin.settings.remoteBaseUrl);
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("Bearer token used for the remote embeddings API.")
			.addText((text) => {
				const commit = async (): Promise<void> => {
					const previousValue = this.plugin.settings.remoteApiKey;
					const nextValue = text.getValue().trim();
					this.plugin.settings.remoteApiKey = nextValue;
					const saved = await this.saveSettingsOrRollback(
						"remote-api-key",
						() => {
							this.plugin.settings.remoteApiKey = previousValue;
						},
						{ refresh: false },
					);
					if (!saved) {
						text.setValue(previousValue);
						return;
					}

					text.setValue(this.plugin.settings.remoteApiKey);
					this.plugin.embeddingService.switchProvider(this.plugin.settings);
				};

				text.setPlaceholder("sk-...").setValue(this.plugin.settings.remoteApiKey);
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				text.inputEl.spellcheck = false;
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});

		new Setting(containerEl)
			.setName("Remote Model")
			.setDesc("Dense embedding model name. Defaults to BAAI/bge-m3.")
			.addText((text) => {
				const commit = async (): Promise<void> => {
					const previousValue = this.plugin.settings.remoteModel;
					const nextValue = text.getValue().trim() || DEFAULT_SETTINGS.remoteModel;
					this.plugin.settings.remoteModel = nextValue;
					const saved = await this.saveSettingsOrRollback(
						"remote-model",
						() => {
							this.plugin.settings.remoteModel = previousValue;
						},
						{ refresh: false },
					);
					if (!saved) {
						text.setValue(previousValue);
						return;
					}

					text.setValue(this.plugin.settings.remoteModel);
					this.plugin.embeddingService.switchProvider(this.plugin.settings);
					if (previousValue !== nextValue) {
						this.invalidateIndex(
							"Remote model changed. The existing index was cleared. Please rebuild the index.",
						);
					}
				};

				text
					.setPlaceholder(DEFAULT_SETTINGS.remoteModel)
					.setValue(this.plugin.settings.remoteModel);
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});

		new Setting(containerEl)
			.setName("Timeout")
			.setDesc("Remote request timeout in milliseconds.")
			.addText((text) => {
				const commit = async (): Promise<void> => {
					const previousValue = this.plugin.settings.remoteTimeoutMs;
					const nextValue = this.parsePositiveIntegerInput(
						text.getValue(),
						DEFAULT_SETTINGS.remoteTimeoutMs,
						1000,
					);
					this.plugin.settings.remoteTimeoutMs = nextValue;
					const saved = await this.saveSettingsOrRollback(
						"remote-timeout-ms",
						() => {
							this.plugin.settings.remoteTimeoutMs = previousValue;
						},
						{ refresh: false },
					);
					if (!saved) {
						text.setValue(String(previousValue));
						return;
					}

					text.setValue(String(this.plugin.settings.remoteTimeoutMs));
					this.plugin.embeddingService.switchProvider(this.plugin.settings);
				};

				text.setPlaceholder(String(DEFAULT_SETTINGS.remoteTimeoutMs));
				text.setValue(String(this.plugin.settings.remoteTimeoutMs));
				text.inputEl.type = "number";
				text.inputEl.min = "1000";
				text.inputEl.step = "1000";
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});

		new Setting(containerEl)
			.setName("Batch Size")
			.setDesc("Maximum number of texts sent in one embeddings request.")
			.addText((text) => {
				const commit = async (): Promise<void> => {
					const previousValue = this.plugin.settings.remoteBatchSize;
					const nextValue = this.parsePositiveIntegerInput(
						text.getValue(),
						DEFAULT_SETTINGS.remoteBatchSize,
						1,
					);
					this.plugin.settings.remoteBatchSize = nextValue;
					const saved = await this.saveSettingsOrRollback(
						"remote-batch-size",
						() => {
							this.plugin.settings.remoteBatchSize = previousValue;
						},
						{ refresh: false },
					);
					if (!saved) {
						text.setValue(String(previousValue));
						return;
					}

					text.setValue(String(this.plugin.settings.remoteBatchSize));
					this.plugin.embeddingService.switchProvider(this.plugin.settings);
				};

				text.setPlaceholder(String(DEFAULT_SETTINGS.remoteBatchSize));
				text.setValue(String(this.plugin.settings.remoteBatchSize));
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.step = "1";
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});

		const testSetting = new Setting(containerEl)
			.setName("Test Connection")
			.setDesc("Send a real embeddings request to verify the current remote configuration.")
			.addButton((btn) => {
				btn.setButtonText("Test Connection").setCta().onClick(async () => {
					btn.setButtonText("Testing...");
					btn.setDisabled(true);

					try {
						await this.plugin.logRuntimeEvent(
							"remote-embedding-test-requested",
							"Started a remote embeddings connectivity test.",
							{
								category: "embedding",
								provider: "remote",
								details: [
									`base_url=${normalizeRemoteBaseUrl(this.plugin.settings.remoteBaseUrl) || "(empty)"}`,
									`model=${this.plugin.settings.remoteModel}`,
									`timeout_ms=${this.plugin.settings.remoteTimeoutMs}`,
									`batch_size=${this.plugin.settings.remoteBatchSize}`,
								],
							},
						);

						this.plugin.embeddingService.switchProvider(this.plugin.settings);
						const result = await this.plugin.embeddingService.testConnection();

						testSetting.descEl.querySelector(".sc-api-test-result")?.remove();
						const resultEl = testSetting.descEl.createEl("div", {
							cls: "sc-api-test-result",
						});

						if (result.ok) {
							resultEl.addClass("is-success");
							resultEl.setText(`Remote embeddings test succeeded. Dimension: ${result.dimension}.`);
							await this.plugin.logRuntimeEvent(
								"remote-embedding-test-ok",
								"Remote embeddings test succeeded.",
								{
									category: "embedding",
									provider: "remote",
									details: [
										`base_url=${normalizeRemoteBaseUrl(this.plugin.settings.remoteBaseUrl) || "(empty)"}`,
										`model=${this.plugin.settings.remoteModel}`,
										`dimension=${result.dimension}`,
									],
								},
							);
						} else {
							resultEl.addClass("is-error");
							resultEl.setText(`Remote embeddings test failed: ${result.error}`);
							await this.plugin.logRuntimeEvent(
								"remote-embedding-test-failed",
								`Remote embeddings test failed: ${result.error}`,
								{
									level: "warn",
									category: "embedding",
									provider: "remote",
									details: [
										`base_url=${normalizeRemoteBaseUrl(this.plugin.settings.remoteBaseUrl) || "(empty)"}`,
										`model=${this.plugin.settings.remoteModel}`,
									],
								},
							);
							await this.plugin.logRuntimeError(
								"remote-embedding-test",
								result.diagnostic ?? result.error,
								{
									errorType: "runtime",
									filePath: "__settings__/remote-embedding-test",
									provider: "remote",
								},
							);
						}
					} catch (error) {
						testSetting.descEl.querySelector(".sc-api-test-result")?.remove();
						const resultEl = testSetting.descEl.createEl("div", {
							cls: "sc-api-test-result",
						});
						const message = error instanceof Error ? error.message : String(error);
						resultEl.addClass("is-error");
						resultEl.setText(`Remote embeddings test failed: ${message}`);
						await this.plugin
							.logRuntimeError("remote-embedding-test", error, {
								errorType: "runtime",
								filePath: "__settings__/remote-embedding-test",
								provider: "remote",
							})
							.catch(() => undefined);
					} finally {
						btn.setButtonText("Test Connection");
						btn.setDisabled(false);
					}
				});
			});
	}

	private renderIndexManagement(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Index Management" });

		const rebuildSetting = new Setting(containerEl)
			.setName("Rebuild Index")
			.setDesc("")
			.addButton((btn) => {
				const resetButton = (): void => {
					btn.setButtonText(this.plugin.isRebuilding ? "Rebuilding..." : "Rebuild");
					btn.setDisabled(this.plugin.isRebuilding);
				};

				btn.setCta().onClick(async () => {
					btn.setButtonText("Rebuilding...");
					btn.setDisabled(true);
					updateRebuildProgress({
						stage: "preparing",
						message: "Preparing to rebuild the index...",
						percent: 0,
					});

					try {
						await this.plugin.rebuildIndex({ onProgress: updateRebuildProgress });
					} finally {
						updateIndexSummary();
						resetButton();
					}
				});

				resetButton();
			});

		rebuildSetting.addButton((btn) => {
			btn.setButtonText("Storage Stats").onClick(async () => {
				btn.setDisabled(true);
				try {
					await this.plugin.showIndexStorageSummary();
				} finally {
					btn.setDisabled(false);
				}
			});
		});

		rebuildSetting.descEl.empty();

		const rebuildSummaryEl = rebuildSetting.descEl.createDiv();
		const rebuildErrorHintEl = rebuildSetting.descEl.createDiv({
			cls: "sc-setting-error-hint",
		});
		const rebuildStatusEl = rebuildSetting.descEl.createDiv({
			cls: "sc-rebuild-status",
		});
		const rebuildMessageEl = rebuildStatusEl.createDiv();
		const rebuildProgressEl = rebuildStatusEl.createDiv({
			cls: "sc-rebuild-progress",
		});
		const rebuildProgressBarEl = rebuildProgressEl.createDiv({
			cls: "sc-rebuild-progress-bar",
		});
		const rebuildDetailEl = rebuildStatusEl.createDiv({
			cls: "sc-rebuild-detail",
		});

		const clampPercent = (value?: number): number => {
			if (typeof value !== "number" || Number.isNaN(value)) {
				return 0;
			}
			return Math.max(0, Math.min(100, Math.round(value)));
		};

		const updateIndexSummary = (): void => {
			const noteCount = this.plugin.noteStore.size;
			const chunkCount = this.plugin.chunkStore.size;
			rebuildSummaryEl.setText(
				noteCount > 0
					? `Indexed ${noteCount} notes and ${chunkCount} chunks.`
					: "No index data available.",
			);

			const errorCount = this.plugin.errorLogger.size;
			if (errorCount > 0) {
				rebuildErrorHintEl.setText(`Error log entries: ${errorCount}`);
				rebuildErrorHintEl.style.display = "";
				return;
			}

			rebuildErrorHintEl.empty();
			rebuildErrorHintEl.style.display = "none";
		};

		const updateRebuildProgress = (progress: RebuildIndexProgress): void => {
			rebuildStatusEl.style.display = "block";
			rebuildStatusEl.classList.remove("is-success", "is-error");

			if (progress.stage === "success") {
				rebuildStatusEl.classList.add("is-success");
			} else if (progress.stage === "error") {
				rebuildStatusEl.classList.add("is-error");
			}

			rebuildMessageEl.setText(progress.message);
			rebuildProgressBarEl.style.width = `${clampPercent(progress.percent)}%`;

			const details: string[] = [];
			if (typeof progress.done === "number" && typeof progress.total === "number") {
				details.push(`${progress.done}/${progress.total}`);
			}
			if (progress.file) {
				details.push(progress.file);
			}
			if (typeof progress.indexedNotes === "number") {
				details.push(`indexed=${progress.indexedNotes}`);
			}
			if (typeof progress.failed === "number" && progress.failed > 0) {
				details.push(`failed=${progress.failed}`);
			}

			if (details.length > 0) {
				rebuildDetailEl.setText(details.join(" | "));
				rebuildDetailEl.style.display = "";
			} else {
				rebuildDetailEl.empty();
				rebuildDetailEl.style.display = "none";
			}
		};

		updateIndexSummary();
		rebuildStatusEl.style.display = "none";
		rebuildDetailEl.style.display = "none";
	}

	private renderLogSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Logs" });

		const runtimeSetting = new Setting(containerEl)
			.setName("Runtime log")
			.setDesc("Show the most recent 30 runtime log entries.")
			.addButton((btn) => {
				btn.setButtonText("Refresh").onClick(() => {
					renderRuntimeLog();
				});
			})
			.addButton((btn) => {
				btn.setButtonText("Clear").onClick(async () => {
					btn.setDisabled(true);
					try {
						await this.plugin.clearRuntimeLogs();
						renderRuntimeLog();
					} catch {
						new Notice("Failed to clear runtime logs. Check the error log.", 6000);
					} finally {
						btn.setDisabled(false);
					}
				});
			});

		const runtimeLogOutputEl = runtimeSetting.descEl.createEl("pre", {
			cls: "sc-log-output",
		});

		const errorSetting = new Setting(containerEl)
			.setName("Error log")
			.setDesc("Show the most recent 20 error log entries.")
			.addButton((btn) => {
				btn.setButtonText("Refresh").onClick(() => {
					renderErrorLog();
				});
			})
			.addButton((btn) => {
				btn.setButtonText("Clear").onClick(async () => {
					btn.setDisabled(true);
					try {
						await this.plugin.clearErrorLogs();
						renderErrorLog();
					} catch {
						new Notice("Failed to clear error logs. Check the runtime log.", 6000);
					} finally {
						btn.setDisabled(false);
					}
				});
			});

		const errorLogOutputEl = errorSetting.descEl.createEl("pre", {
			cls: "sc-log-output",
		});

		const renderRuntimeLog = (): void => {
			runtimeLogOutputEl.setText(
				this.formatRuntimeLogEntries(this.plugin.getRecentRuntimeLogs(30)),
			);
		};

		const renderErrorLog = (): void => {
			errorLogOutputEl.setText(
				this.formatErrorLogEntries(this.plugin.errorLogger.getRecent(20)),
			);
		};

		renderRuntimeLog();
		renderErrorLog();
	}

	private invalidateIndex(message: string): void {
		this.plugin.clearIndexData();
		new Notice(message, 8000);
	}

	private async saveSettingsOrRollback(
		context: string,
		rollback: () => void,
		options: {
			failureMessage?: string;
			refresh?: boolean;
		} = {},
	): Promise<boolean> {
		try {
			await this.plugin.saveSettings(context);
			return true;
		} catch {
			rollback();
			new Notice(options.failureMessage ?? "Failed to save settings. Check the error log.", 6000);
			if (options.refresh ?? true) {
				this.display();
			}
			return false;
		}
	}

	private formatRuntimeLogEntries(entries: RuntimeLogEntry[]): string {
		if (entries.length === 0) {
			return "No runtime logs.";
		}

		return entries
			.map((entry) => {
				const header = `[${this.formatLogTimestamp(entry.timestamp)}] ${entry.level.toUpperCase()} ${entry.event}`;
				const lines = [header, `  ${entry.message}`];
				const meta = [entry.category, entry.provider].filter((item): item is string => Boolean(item));
				if (meta.length > 0) {
					lines.push(`  ${meta.join(" | ")}`);
				}
				if (entry.details && entry.details.length > 0) {
					lines.push(...entry.details.map((detail) => `  - ${detail}`));
				}
				return lines.join("\n");
			})
			.join("\n\n");
	}

	private formatErrorLogEntries(entries: IndexErrorEntry[]): string {
		if (entries.length === 0) {
			return "No error logs.";
		}

		return entries
			.map((entry) => {
				const header = `[${this.formatLogTimestamp(entry.timestamp)}] ${entry.errorType} ${entry.filePath}`;
				const lines = [header, `  ${entry.message}`];
				const meta = [
					entry.provider ? `provider=${entry.provider}` : undefined,
					entry.stage ? `stage=${entry.stage}` : undefined,
				].filter((item): item is string => Boolean(item));
				if (meta.length > 0) {
					lines.push(`  ${meta.join(" | ")}`);
				}
				if (entry.details && entry.details.length > 0) {
					lines.push(...entry.details.map((detail) => `  - ${detail}`));
				}
				return lines.join("\n");
			})
			.join("\n\n");
	}

	private formatLogTimestamp(timestamp: number): string {
		return new Date(timestamp).toLocaleString("zh-CN", {
			hour12: false,
		});
	}

	private parsePositiveIntegerInput(
		value: string,
		fallback: number,
		minimum: number = 1,
	): number {
		const parsed = Number.parseInt(value.trim(), 10);
		if (!Number.isInteger(parsed) || parsed < minimum) {
			return fallback;
		}
		return parsed;
	}
}
