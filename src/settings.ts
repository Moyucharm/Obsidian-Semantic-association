/**
 * Plugin settings UI.
 */

import { App, ButtonComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import type SemanticConnectionsPlugin from "./main";
import {
	DEFAULT_SETTINGS,
	type IndexErrorEntry,
	type LocalDtype,
	type RebuildIndexProgress,
	type RuntimeLogEntry,
} from "./types";
import { SUPPORTED_LOCAL_MODELS } from "./embeddings/local-provider";
import { normalizeRemoteBaseUrl } from "./embeddings/remote-provider";
import type { LocalModelProgress } from "./embeddings/local-model-shared";

const DTYPE_OPTIONS: { value: LocalDtype; label: string }[] = [
	{ value: "q8", label: "Q8（推荐）" },
	{ value: "q4", label: "Q4（最小）" },
	{ value: "fp16", label: "FP16" },
	{ value: "fp32", label: "FP32" },
];

export class SettingTab extends PluginSettingTab {
	private plugin: SemanticConnectionsPlugin;

	constructor(app: App, plugin: SemanticConnectionsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
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
			new Notice(options.failureMessage ?? "设置保存失败，请查看错误日志。", 6000);
			if (options.refresh ?? true) {
				this.display();
			}
			return false;
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "语义关联设置" });

		new Setting(containerEl)
			.setName("最大关联数")
			.setDesc("侧边栏中显示的最大相关笔记数量。")
			.addSlider((slider) =>
				slider
					.setLimits(5, 50, 5)
					.setValue(this.plugin.settings.maxConnections)
					.setDynamicTooltip()
					.onChange(async (value) => {
						const previousValue = this.plugin.settings.maxConnections;
						this.plugin.settings.maxConnections = value;
						await this.saveSettingsOrRollback("max-connections", () => {
							this.plugin.settings.maxConnections = previousValue;
						});
					}),
			);

		new Setting(containerEl)
			.setName("自动索引")
			.setDesc("Markdown 文件变化时自动更新索引。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoIndex).onChange(async (value) => {
					const previousValue = this.plugin.settings.autoIndex;
					this.plugin.settings.autoIndex = value;
					await this.saveSettingsOrRollback("auto-index", () => {
						this.plugin.settings.autoIndex = previousValue;
					});
				}),
			);

		new Setting(containerEl)
			.setName("启动时自动打开关联视图")
			.setDesc("插件启动时自动打开关联侧栏。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoOpenConnectionsView)
					.onChange(async (value) => {
						const previousValue = this.plugin.settings.autoOpenConnectionsView;
						this.plugin.settings.autoOpenConnectionsView = value;
						await this.saveSettingsOrRollback("auto-open-connections-view", () => {
							this.plugin.settings.autoOpenConnectionsView = previousValue;
						});
					}),
			);

		new Setting(containerEl)
			.setName("向量提供方式")
			.setDesc("选择生成向量的方式。")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("mock", "模拟")
					.addOption("local", "本地模型")
					.addOption("remote", "远程 API")
					.setValue(this.plugin.settings.embeddingProvider)
					.onChange(async (value) => {
						const nextProvider = value as "mock" | "local" | "remote";
						const prevProvider = this.plugin.settings.embeddingProvider;
						this.plugin.settings.embeddingProvider = nextProvider;
						const saved = await this.saveSettingsOrRollback("embedding-provider", () => {
							this.plugin.settings.embeddingProvider = prevProvider;
						});
						if (!saved) {
							return;
						}
						this.plugin.embeddingService.switchProvider(this.plugin.settings);

						if (prevProvider !== nextProvider) {
							this.plugin.noteStore.clear();
							this.plugin.chunkStore.clear();
							this.plugin.vectorStore.clear();
							new Notice(
								"向量提供方式已更改。索引数据已清空，请重新执行“重建索引”。",
								8000,
							);
						}

						this.display();
					}),
			);

		if (this.plugin.settings.embeddingProvider === "local") {
			this.renderLocalModelSettings(containerEl);
		}

		if (this.plugin.settings.embeddingProvider === "remote") {
			this.renderRemoteModelSettings(containerEl);
		}

		new Setting(containerEl)
			.setName("排除文件夹")
			.setDesc("索引时需要跳过的文件夹，每行一个路径。")
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
						if (!saved) {
							return;
						}
						new Notice(
							"排除文件夹已更新。如需清理已有索引数据，请重新执行“重建索引”。",
							6000,
						);
					}),
			);

		containerEl.createEl("h2", { text: "索引管理" });

		const rebuildSetting = new Setting(containerEl)
			.setName("重建索引")
			.setDesc("")
			.addButton((btn) => {
				const resetButton = (): void => {
					btn.setButtonText(this.plugin.isRebuilding ? "重建中..." : "重建");
					btn.setDisabled(this.plugin.isRebuilding);
				};

				btn.setCta().onClick(async () => {
					btn.setButtonText("重建中...");
					btn.setDisabled(true);

					updateRebuildProgress({
						stage: "checking-local-model",
						message: "正在准备重建...",
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
			btn.setButtonText("存储统计").onClick(async () => {
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
					? `当前索引：${noteCount} 篇笔记，${chunkCount} 个语义块`
					: "暂无索引数据",
			);

			const errorCount = this.plugin.errorLogger.size;
			if (errorCount > 0) {
				rebuildErrorHintEl.setText(`错误日志条目：${errorCount}`);
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
				details.push(`已索引 ${progress.indexedNotes} 篇笔记`);
			}
			if (typeof progress.failed === "number" && progress.failed > 0) {
				details.push(`失败 ${progress.failed} 篇`);
			}

			if (details.length > 0) {
				rebuildDetailEl.setText(details.join(" · "));
				rebuildDetailEl.style.display = "";
				return;
			}

			rebuildDetailEl.empty();
			rebuildDetailEl.style.display = "none";
		};

		updateIndexSummary();
		rebuildStatusEl.style.display = "none";
		rebuildDetailEl.style.display = "none";
	}

	private renderRemoteModelSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("API Base URL")
			.setDesc("远程 embeddings 服务根地址。插件会自动请求 {baseUrl}/v1/embeddings。")
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
					if (this.plugin.settings.embeddingProvider === "remote") {
						this.plugin.embeddingService.switchProvider(this.plugin.settings);
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
			.setDesc("用于请求远程 embeddings API 的 Bearer Token。")
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
					if (this.plugin.settings.embeddingProvider === "remote") {
						this.plugin.embeddingService.switchProvider(this.plugin.settings);
					}
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
			.setDesc("默认使用 BAAI/bge-m3，仅接入 dense embedding，实际维度以接口返回为准。")
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
					if (this.plugin.settings.embeddingProvider === "remote") {
						this.plugin.embeddingService.switchProvider(this.plugin.settings);
						if (previousValue !== nextValue) {
							this.plugin.noteStore.clear();
							this.plugin.chunkStore.clear();
							this.plugin.vectorStore.clear();
							new Notice("远程模型已更改。索引数据已清空，请重新执行“重建索引”。", 8000);
						}
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
			.setDesc("远程 embeddings 请求超时时间，单位毫秒。")
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
					if (this.plugin.settings.embeddingProvider === "remote") {
						this.plugin.embeddingService.switchProvider(this.plugin.settings);
					}
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
			.setDesc("批量 embedding 时单次请求携带的文本条数。")
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
					if (this.plugin.settings.embeddingProvider === "remote") {
						this.plugin.embeddingService.switchProvider(this.plugin.settings);
					}
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
			.setDesc("发送一次真实的 embeddings 请求，验证 Base URL、API Key、Model 是否可用。")
			.addButton((btn) => {
				btn.setButtonText("Test Connection").setCta().onClick(async () => {
					btn.setButtonText("Testing...");
					btn.setDisabled(true);

					try {
						await this.plugin.logRuntimeEvent(
							"remote-embedding-test-requested",
							"已开始测试远程 embeddings 接口。",
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
							resultEl.setText(`远程 embeddings 测试成功（维度：${result.dimension}）。`);
							await this.plugin.logRuntimeEvent(
								"remote-embedding-test-ok",
								"远程 embeddings 接口测试成功。",
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
							resultEl.setText(`远程 embeddings 测试失败：${result.error}`);
							await this.plugin.logRuntimeEvent(
								"remote-embedding-test-failed",
								`远程 embeddings 接口测试失败：${result.error}`,
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
						resultEl.setText(`远程 embeddings 测试失败：${message}`);
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

	private renderLocalModelSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("本地模型")
			.setDesc("用于生成本地向量的模型。")
			.addDropdown((dropdown) => {
				for (const model of SUPPORTED_LOCAL_MODELS) {
					dropdown.addOption(model.id, model.name);
				}
				dropdown.setValue(this.plugin.settings.localModelId);
				dropdown.onChange(async (value) => {
					const prevModel = this.plugin.settings.localModelId;
					this.plugin.settings.localModelId = value;
					const saved = await this.saveSettingsOrRollback("local-model-id", () => {
						this.plugin.settings.localModelId = prevModel;
					});
					if (!saved) {
						return;
					}
					this.plugin.embeddingService.switchProvider(this.plugin.settings);

					if (prevModel !== value) {
						this.plugin.noteStore.clear();
						this.plugin.chunkStore.clear();
						this.plugin.vectorStore.clear();
						new Notice(
							"本地模型已更改。索引数据已清空，请重新执行“重建索引”。",
							8000,
						);
					}

					this.display();
				});
			});

		new Setting(containerEl)
			.setName("量化精度")
			.setDesc("控制模型体积和推理质量。")
			.addDropdown((dropdown) => {
				for (const option of DTYPE_OPTIONS) {
					dropdown.addOption(option.value, option.label);
				}
				dropdown.setValue(this.plugin.settings.localDtype);
				dropdown.onChange(async (value) => {
					const nextDtype = value as LocalDtype;
					const prevDtype = this.plugin.settings.localDtype;
					this.plugin.settings.localDtype = nextDtype;
					const saved = await this.saveSettingsOrRollback("local-dtype", () => {
						this.plugin.settings.localDtype = prevDtype;
					});
					if (!saved) {
						return;
					}
					this.plugin.embeddingService.switchProvider(this.plugin.settings);

					if (prevDtype !== nextDtype) {
						this.plugin.noteStore.clear();
						this.plugin.chunkStore.clear();
						this.plugin.vectorStore.clear();
						new Notice(
							"量化精度已更改。索引数据已清空，请重新执行“重建索引”。",
							8000,
						);
					}

					this.display();
				});
			});

		new Setting(containerEl)
			.setName("优先使用插件目录存储")
			.setDesc(
				"尽量将模型文件保存在插件目录中。这样缓存路径更稳定，也更适合手动预下载文件。",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.forcePluginLocalModelStorage)
					.onChange(async (value) => {
						const previousValue = this.plugin.settings.forcePluginLocalModelStorage;
						this.plugin.settings.forcePluginLocalModelStorage = value;
						const saved = await this.saveSettingsOrRollback(
							"force-plugin-local-model-storage",
							() => {
								this.plugin.settings.forcePluginLocalModelStorage = previousValue;
							},
						);
						if (!saved) {
							return;
						}
						this.plugin.embeddingService.switchProvider(this.plugin.settings);
						this.display();
					}),
			);

		const relativeCachePath = this.plugin.embeddingService.getLocalModelCachePath();
		const absoluteCachePath = this.plugin.embeddingService.getAbsoluteLocalModelCachePath();
		const cacheSetting = new Setting(containerEl)
			.setName("模型缓存路径")
			.setDesc(
				"桌面版通常会写入插件目录。如果运行时回退到浏览器 Worker 且上方开关关闭，文件可能会进入浏览器缓存。",
			);
		cacheSetting.descEl.createEl("div", { text: `相对路径：${relativeCachePath}` });
		cacheSetting.descEl.createEl("div", { text: `绝对路径：${absoluteCachePath}` });

		const selectedModel = SUPPORTED_LOCAL_MODELS.find(
			(model) => model.id === this.plugin.settings.localModelId,
		);
		if (selectedModel) {
			const currentDtype = this.plugin.settings.localDtype;
			const sizeHint = selectedModel.sizeHints[currentDtype] ?? selectedModel.sizeHints.q8;
			new Setting(containerEl)
				.setName("模型信息")
				.setDesc(
					`${selectedModel.description}（维度：${selectedModel.dimension}，预计下载：${sizeHint}）`,
				);
		}

		let downloadButton: ButtonComponent | null = null;
		let redownloadButton: ButtonComponent | null = null;
		let runtimeLogOutputEl!: HTMLPreElement;
		let errorLogOutputEl!: HTMLPreElement;

		const downloadSetting = new Setting(containerEl)
			.setName("下载本地模型")
			.setDesc("下载并预热当前本地模型。如果缓存文件已存在，会直接从本地文件加载。")
			.addButton((btn) => {
				downloadButton = btn;
				btn.setButtonText("下载").setCta().onClick(async () => {
					await runLocalModelDownload();
				});
			})
			.addButton((btn) => {
				redownloadButton = btn;
				btn.setButtonText("清空缓存并重新下载").onClick(async () => {
					await runLocalModelDownload({ clearCacheFirst: true });
				});
			});

		const downloadStatusEl = downloadSetting.descEl.createDiv({
			cls: "sc-local-download-status",
		});
		const downloadMessageEl = downloadStatusEl.createDiv();
		const downloadProgressEl = downloadStatusEl.createDiv({
			cls: "sc-local-download-progress",
		});
		const downloadProgressBarEl = downloadProgressEl.createDiv({
			cls: "sc-local-download-progress-bar",
		});
		const downloadDetailEl = downloadStatusEl.createDiv({
			cls: "sc-local-download-detail",
		});

		const setDownloadButtonsDisabled = (disabled: boolean): void => {
			downloadButton?.setDisabled(disabled);
			redownloadButton?.setDisabled(disabled);
		};

		const updateDownloadStatus = (state: {
			message: string;
			percent?: number;
			detail?: string;
			tone?: "success" | "error";
		}): void => {
			downloadStatusEl.style.display = "block";
			downloadStatusEl.classList.remove("is-success", "is-error");
			if (state.tone === "success") {
				downloadStatusEl.classList.add("is-success");
			} else if (state.tone === "error") {
				downloadStatusEl.classList.add("is-error");
			}

			downloadMessageEl.setText(state.message);
			downloadProgressBarEl.style.width = `${Math.max(
				0,
				Math.min(100, Math.round(state.percent ?? 0)),
			)}%`;

			if (state.detail) {
				downloadDetailEl.setText(state.detail);
				downloadDetailEl.style.display = "";
				return;
			}

			downloadDetailEl.empty();
			downloadDetailEl.style.display = "none";
		};

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

		const runLocalModelDownload = async (
			options: { clearCacheFirst?: boolean } = {},
		): Promise<void> => {
			setDownloadButtonsDisabled(true);
			const modelId = this.plugin.settings.localModelId;
			const dtype = this.plugin.settings.localDtype;
			let sawFirstByte = false;
			let sawDownloadStarted = false;
			let sawReady = false;
			let sawWarmup = false;
			let latestDownloadPercent = 0;

			try {
				if (options.clearCacheFirst) {
					updateDownloadStatus({
						message: "正在清理本地模型缓存...",
						percent: 0,
					});

					const clearResult = await this.clearCurrentLocalModelCache();
					await this.plugin.logRuntimeEvent(
						"local-model-cache-cleared",
						clearResult.removed
							? "重新下载前已删除当前本地模型缓存。"
							: "重新下载前未发现当前本地模型缓存。",
						{
							category: "storage",
							provider: "local",
							details: [`cache_path=${clearResult.cachePath}`],
						},
					);
				}

				updateDownloadStatus({
					message: "正在准备本地模型...",
					percent: 0,
					detail: `model=${modelId} · dtype=${dtype}`,
				});

				await this.plugin.logRuntimeEvent(
					"local-model-download-requested",
					"已在设置页请求下载本地模型。",
					{
						category: "embedding",
						provider: "local",
						details: [`model=${modelId}`, `dtype=${dtype}`],
					},
				);

				const result = await this.plugin.embeddingService.prepareLocalModel({
					progressListener: (progress: LocalModelProgress) => {
						const progressValue =
							typeof progress.progress === "number"
								? progress.progress
								: typeof progress.loaded === "number" &&
									  typeof progress.total === "number" &&
									  progress.total > 0
									? (progress.loaded / progress.total) * 100
									: 0;

						if (progress.status === "download" || progress.status === "progress") {
							latestDownloadPercent = progressValue;
							if (!sawDownloadStarted) {
								sawDownloadStarted = true;
								void this.plugin.logRuntimeEvent(
									"local-model-download-started",
									"本地模型下载已进入文件传输阶段。",
									{
										category: "embedding",
										provider: "local",
										details: [
											`model=${modelId}`,
											`dtype=${dtype}`,
											progress.file ? `file=${progress.file}` : undefined,
										].filter((item): item is string => Boolean(item)),
									},
								);
							}
						}

						if (
							!sawFirstByte &&
							((typeof progress.loaded === "number" && progress.loaded > 0) ||
								progressValue > 0)
						) {
							sawFirstByte = true;
							void this.plugin.logRuntimeEvent(
								"local-model-download-first-byte",
								"本地模型下载已收到首批数据。",
								{
									category: "embedding",
									provider: "local",
									details: [
										progress.file ? `file=${progress.file}` : undefined,
										typeof progress.loaded === "number"
											? `loaded=${progress.loaded}`
											: undefined,
										typeof progress.total === "number"
											? `total=${progress.total}`
											: undefined,
									].filter((item): item is string => Boolean(item)),
								},
							);
						}

						let message = "正在准备本地模型...";
						if ((progress.status === "download" || progress.status === "progress") && progress.file) {
							message =
								progress.status === "progress"
									? `正在下载本地模型：${progress.file}（${Math.round(progressValue)}%）`
									: `正在下载本地模型：${progress.file}`;
						} else if (progress.status === "ready") {
							if (!sawReady) {
								sawReady = true;
								void this.plugin.logRuntimeEvent(
									"local-model-download-ready",
									"本地模型文件已就绪，开始初始化运行时。",
									{
										category: "embedding",
										provider: "local",
										details: [`model=${modelId}`, `dtype=${dtype}`],
									},
								);
							}
							message = "本地模型文件已就绪，正在完成初始化...";
						} else if (progress.status === "done") {
							message = progress.file
								? `已完成文件：${progress.file}`
								: "模型下载完成，正在等待运行时初始化...";
						} else if (progress.status === "warmup") {
							if (!sawReady) {
								sawReady = true;
								void this.plugin.logRuntimeEvent(
									"local-model-download-ready",
									"本地模型文件已就绪，开始初始化运行时。",
									{
										category: "embedding",
										provider: "local",
										details: [`model=${modelId}`, `dtype=${dtype}`],
									},
								);
							}
							if (!sawWarmup) {
								sawWarmup = true;
								void this.plugin.logRuntimeEvent(
									"local-model-download-warmup",
									"本地模型已进入预热阶段。",
									{
										category: "embedding",
										provider: "local",
										details: [`model=${modelId}`, `dtype=${dtype}`],
									},
								);
							}
							message = "正在预热本地模型...";
						}

						const detailParts = [
							progress.file,
							typeof progress.loaded === "number" && typeof progress.total === "number"
								? `${progress.loaded}/${progress.total} bytes`
								: undefined,
							`model=${modelId}`,
							`dtype=${dtype}`,
						].filter((item): item is string => Boolean(item));

						updateDownloadStatus({
							message,
							percent:
								progress.status === "download" || progress.status === "progress"
									? progressValue
									: latestDownloadPercent,
							detail: detailParts.join(" · "),
						});
					},
				});

				if (result.ok) {
					updateDownloadStatus({
						message: `模型已就绪（维度：${result.dimension}）`,
						percent: 100,
						detail: `model=${modelId} · dtype=${dtype}`,
						tone: "success",
					});
					await this.plugin.logRuntimeEvent(
						"local-model-ready",
						"本地模型已完成下载并预热。",
						{
							category: "embedding",
							provider: "local",
							details: [`model=${modelId}`, `dtype=${dtype}`, `dimension=${result.dimension}`],
						},
					);
				} else {
					updateDownloadStatus({
						message: `模型下载失败：${result.error}`,
						percent: 0,
						detail: `model=${modelId} · dtype=${dtype}`,
						tone: "error",
					});
					await this.plugin.logRuntimeEvent(
						"local-model-download-failed",
						`本地模型下载失败：${result.error}`,
						{
							level: "warn",
							category: "embedding",
							provider: "local",
							details: [`model=${modelId}`, `dtype=${dtype}`],
						},
					);
					await this.plugin.logRuntimeError("local-model-download", result.diagnostic ?? result.error, {
						errorType: "runtime",
						filePath: "__settings__/local-model-download",
						provider: "local",
					});
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				updateDownloadStatus({
					message: `模型下载失败：${message}`,
					percent: 0,
					detail: `model=${modelId} · dtype=${dtype}`,
					tone: "error",
				});
				await this.plugin.logRuntimeEvent(
					"local-model-download-failed",
					`本地模型下载失败：${message}`,
					{
						level: "warn",
						category: "embedding",
						provider: "local",
						details: [`model=${modelId}`, `dtype=${dtype}`],
					},
				);
				await this.plugin.logRuntimeError("local-model-download", error, {
					errorType: "runtime",
					filePath: "__settings__/local-model-download",
					provider: "local",
				});
			} finally {
				setDownloadButtonsDisabled(false);
				renderRuntimeLog();
				renderErrorLog();
			}
		};

		const testSetting = new Setting(containerEl)
			.setName("测试本地模型")
			.setDesc("加载当前本地模型并执行一次推理，不强制重新下载。")
			.addButton((btn) => {
				btn.setButtonText("测试").onClick(async () => {
					btn.setButtonText("测试中...");
					btn.setDisabled(true);

					await this.plugin.logRuntimeEvent(
						"local-model-test-requested",
						"已在设置页请求测试本地模型。",
						{
							category: "embedding",
							provider: "local",
							details: [
								`model=${this.plugin.settings.localModelId}`,
								`dtype=${this.plugin.settings.localDtype}`,
							],
						},
					);

					this.plugin.embeddingService.switchProvider(this.plugin.settings);
					const result = await this.plugin.embeddingService.testConnection();

					testSetting.descEl.querySelector(".sc-local-test-result")?.remove();

					const resultEl = testSetting.descEl.createEl("div", {
						cls: "sc-local-test-result",
					});

					if (result.ok) {
						resultEl.addClass("is-success");
						resultEl.setText(`本地模型测试成功（维度：${result.dimension}）`);
						await this.plugin.logRuntimeEvent(
							"local-model-test-ok",
							"本地模型测试成功。",
							{
								category: "embedding",
								provider: "local",
								details: [
									`model=${this.plugin.settings.localModelId}`,
									`dtype=${this.plugin.settings.localDtype}`,
									`dimension=${result.dimension}`,
								],
							},
						);
					} else {
						resultEl.addClass("is-error");
						resultEl.setText(`本地模型测试失败：${result.error}`);
						await this.plugin.logRuntimeEvent(
							"local-model-test-failed",
							`本地模型测试失败：${result.error}`,
							{
								level: "warn",
								category: "embedding",
								provider: "local",
								details: [
									`model=${this.plugin.settings.localModelId}`,
									`dtype=${this.plugin.settings.localDtype}`,
								],
							},
						);
						await this.plugin.logRuntimeError(
							"local-model-test",
							result.diagnostic ?? result.error,
							{
								errorType: "runtime",
								filePath: "__settings__/local-model-test",
								provider: "local",
							},
						);
					}

					renderRuntimeLog();
					renderErrorLog();
					btn.setButtonText("测试");
					btn.setDisabled(false);
				});
			});

		const runtimeLogSetting = new Setting(containerEl)
			.setName("运行日志")
			.setDesc("显示最近 30 条本地模型运行日志。")
			.addButton((btn) => {
				btn.setButtonText("刷新").onClick(() => {
					renderRuntimeLog();
				});
			})
			.addButton((btn) => {
				btn.setButtonText("清空").onClick(async () => {
					btn.setDisabled(true);
					try {
						await this.plugin.clearRuntimeLogs();
						renderRuntimeLog();
					} catch {
						new Notice("清空运行日志失败，请查看错误日志。", 6000);
					} finally {
						btn.setDisabled(false);
					}
				});
			});

		runtimeLogOutputEl = runtimeLogSetting.descEl.createEl("pre", {
			cls: "sc-log-output",
		});

		const errorLogSetting = new Setting(containerEl)
			.setName("错误日志")
			.setDesc("显示最近 20 条索引和运行时错误。")
			.addButton((btn) => {
				btn.setButtonText("刷新").onClick(() => {
					renderErrorLog();
				});
			})
			.addButton((btn) => {
				btn.setButtonText("清空").onClick(async () => {
					btn.setDisabled(true);
					try {
						await this.plugin.clearErrorLogs();
						renderErrorLog();
					} catch {
						new Notice("清空错误日志失败，请查看运行日志。", 6000);
					} finally {
						btn.setDisabled(false);
					}
				});
			});

		errorLogOutputEl = errorLogSetting.descEl.createEl("pre", {
			cls: "sc-log-output",
		});

		downloadStatusEl.style.display = "none";
		downloadDetailEl.style.display = "none";
		renderRuntimeLog();
		renderErrorLog();
	}

	private formatRuntimeLogEntries(entries: RuntimeLogEntry[]): string {
		if (entries.length === 0) {
			return "暂无运行日志。";
		}

		return entries
			.map((entry) => {
				const header = `[${this.formatLogTimestamp(entry.timestamp)}] ${entry.level.toUpperCase()} ${entry.event}`;
				const lines = [header, `  ${entry.message}`];
				const meta = [entry.category, entry.provider].filter((item): item is string => Boolean(item));
				if (meta.length > 0) {
					lines.push(`  ${meta.join(" · ")}`);
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
			return "暂无错误日志。";
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
					lines.push(`  ${meta.join(" · ")}`);
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

	private async clearCurrentLocalModelCache(): Promise<{ removed: boolean; cachePath: string }> {
		const adapter = this.app.vault.adapter;
		const cachePath = this.plugin.embeddingService.getLocalModelCachePath();

		await this.plugin.embeddingService.disposeCurrentProvider().catch(() => undefined);

		if (!(await adapter.exists(cachePath))) {
			this.plugin.embeddingService.switchProvider(this.plugin.settings);
			return { removed: false, cachePath };
		}

		await adapter.rmdir(cachePath, true);
		this.plugin.embeddingService.switchProvider(this.plugin.settings);
		return { removed: true, cachePath };
	}
}
