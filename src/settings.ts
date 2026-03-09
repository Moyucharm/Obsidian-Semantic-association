/**
 * 插件设置页
 *
 * 提供用户可配置项：
 * - 最大关联数
 * - 排除文件夹
 * - Embedding Provider 选择
 * - 自动索引开关
 */

import {
	App,
	ButtonComponent,
	Notice,
	PluginSettingTab,
	Setting,
	TextComponent,
} from "obsidian";
import type SemanticConnectionsPlugin from "./main";
import type {
	IndexErrorEntry,
	LocalDtype,
	RebuildIndexProgress,
	RemoteModelInfo,
	RuntimeLogEntry,
} from "./types";
import { SUPPORTED_LOCAL_MODELS } from "./embeddings/local-provider";
import type { LocalModelProgress } from "./embeddings/local-model-shared";

/** 手动输入模型的特殊标记值 */
const MANUAL_MODEL_VALUE = "__manual__";

/** dtype 下拉选项（按推荐度排序） */
const DTYPE_OPTIONS: { value: string; label: string }[] = [
	{ value: "q8", label: "Q8（8-bit 量化，推荐）" },
	{ value: "q4", label: "Q4（4-bit 量化，最小）" },
	{ value: "fp16", label: "FP16（半精度）" },
	{ value: "fp32", label: "FP32（全精度，最大）" },
];

export class SettingTab extends PluginSettingTab {
	private plugin: SemanticConnectionsPlugin;

	/** 缓存的远程模型列表（避免每次 display() 都拉取） */
	private cachedModels: RemoteModelInfo[] | null = null;

	constructor(app: App, plugin: SemanticConnectionsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Semantic Connections 设置" });

		// 最大关联数
		new Setting(containerEl)
			.setName("最大关联数")
			.setDesc("右侧视图展示的最大相关笔记数量")
			.addSlider((slider) =>
				slider
					.setLimits(5, 50, 5)
					.setValue(this.plugin.settings.maxConnections)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxConnections = value;
						await this.plugin.saveSettings();
					})
			);

		// 自动索引开关
		new Setting(containerEl)
			.setName("自动索引")
			.setDesc("文件变更时自动更新索引")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoIndex)
					.onChange(async (value) => {
						this.plugin.settings.autoIndex = value;
						await this.plugin.saveSettings();
					})
			);

		// Embedding Provider
		new Setting(containerEl)
			.setName("Embedding 模型")
			.setDesc("选择向量生成方式")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("mock", "Mock（开发测试）")
					.addOption("local", "本地模型（Transformers.js）")
					.addOption("remote", "远程 API（OpenAI 兼容）")
					.setValue(this.plugin.settings.embeddingProvider)
					.onChange(async (value) => {
						const prevProvider = this.plugin.settings.embeddingProvider;
						this.plugin.settings.embeddingProvider = value as "mock" | "local" | "remote";
						await this.plugin.saveSettings();

						// 运行时切换 provider（否则需要重启插件才生效）
						this.plugin.embeddingService.switchProvider(this.plugin.settings);

						// provider 变化时，旧索引向量维度/语义不再兼容，必须重建
						if (prevProvider !== this.plugin.settings.embeddingProvider) {
							this.plugin.noteStore.clear();
							this.plugin.chunkStore.clear();
							this.plugin.vectorStore.clear();
							new Notice("Embedding 模型已切换，索引已清空。请执行「重建索引」重新生成向量。", 8000);
						}

						// 切换 provider 后清空模型缓存（不同 provider 的模型列表不同）
						this.cachedModels = null;

						// 重新渲染设置页以显示/隐藏对应配置项
						this.display();
					})
			);

		// 仅在选择 remote 时显示 API 配置项
		if (this.plugin.settings.embeddingProvider === "remote") {
			new Setting(containerEl)
				.setName("API Key")
				.setDesc("OpenAI 或兼容服务的 API Key")
				.addText((text) =>
					text
						.setPlaceholder("sk-...")
						.setValue(this.plugin.settings.remoteApiKey)
						.onChange(async (value) => {
							this.plugin.settings.remoteApiKey = value.trim();
							await this.plugin.saveSettings();
							this.plugin.embeddingService.switchProvider(this.plugin.settings);
							// API Key 变更后清空模型缓存（不同 Key 可用的模型可能不同）
							this.cachedModels = null;
						})
				);

			new Setting(containerEl)
				.setName("API Base URL")
				.setDesc("兼容 OpenAI 格式的 API 地址（无需以 /embeddings 结尾）")
				.addText((text) =>
					text
						.setPlaceholder("https://api.openai.com/v1")
						.setValue(this.plugin.settings.remoteApiUrl)
						.onChange(async (value) => {
							this.plugin.settings.remoteApiUrl = value.trim();
							await this.plugin.saveSettings();
							this.plugin.embeddingService.switchProvider(this.plugin.settings);
							// URL 变更后清空模型缓存
							this.cachedModels = null;
							new Notice("API Base URL 已更新；如切换了服务商/部署，建议执行「重建索引」。", 6000);
						})
				);

			// ── 模型选择（dropdown + 刷新按钮 + 手动输入 fallback） ──
			this.renderModelSetting(containerEl);

			new Setting(containerEl)
				.setName("批量大小")
				.setDesc("单次 API 请求最大文本数（建议 50-100）")
				.addSlider((slider) =>
					slider
						.setLimits(10, 200, 10)
						.setValue(this.plugin.settings.remoteBatchSize)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.remoteBatchSize = value;
							await this.plugin.saveSettings();
							this.plugin.embeddingService.switchProvider(this.plugin.settings);
						})
				);

			// 测试 API 连接
			const testSetting = new Setting(containerEl)
				.setName("测试连接")
				.setDesc("发送一条测试请求，验证 API 配置是否有效")
				.addButton((btn) => {
					btn
						.setButtonText("测试")
						.onClick(async () => {
							btn.setButtonText("测试中...");
							btn.setDisabled(true);

							// 确保使用最新配置
							this.plugin.embeddingService.switchProvider(this.plugin.settings);
							const result = await this.plugin.embeddingService.testConnection();

							// 移除旧的测试结果
							testSetting.descEl.querySelector(".sc-api-test-result")?.remove();

							const resultEl = testSetting.descEl.createEl("div", {
								cls: "sc-api-test-result",
							});

							if (result.ok) {
								resultEl.addClass("is-success");
								resultEl.setText(`连接成功（向量维度：${result.dimension}）`);
								await this.plugin.logRuntimeEvent(
									"remote-connection-test-ok",
									"Remote embedding connection test succeeded.",
									{
										category: "embedding",
										provider: "remote",
										details: [
											`model=${this.plugin.settings.remoteModel}`,
											`dimension=${result.dimension}`,
										],
									},
								);
							} else {
								resultEl.addClass("is-error");
								resultEl.setText(`连接失败：${result.error}`);
								await this.plugin.logRuntimeError(
									"remote-connection-test",
									result.diagnostic ?? result.error,
									{
										errorType: "configuration",
										filePath: "__settings__/remote-connection-test",
										provider: "remote",
									},
								);
							}

							btn.setButtonText("测试");
							btn.setDisabled(false);
						});
				});
		}

		// 仅在选择 local 时显示本地模型配置项
		if (this.plugin.settings.embeddingProvider === "local") {
			this.renderLocalModelSettings(containerEl);
		}

		// 排除文件夹
		new Setting(containerEl)
			.setName("排除文件夹")
			.setDesc("不参与索引的文件夹路径，每行一个")
			.addTextArea((text) =>
				text
					.setPlaceholder("templates\narchive")
					.setValue(this.plugin.settings.excludedFolders.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
						new Notice("排除文件夹设置已更新；建议执行「重建索引」以清理/重建索引结果。", 6000);
					})
			);

		// ── 索引管理 ──
		containerEl.createEl("h2", { text: "索引管理" });

		const rebuildSetting = new Setting(containerEl)
			.setName("重建索引")
			.setDesc("")
			.addButton((btn) => {
				const resetButton = (): void => {
					btn.setButtonText(this.plugin.isRebuilding ? "正在重建..." : "重建索引");
					btn.setDisabled(this.plugin.isRebuilding);
				};

				btn
					.setCta()
					.onClick(async () => {
						btn.setButtonText("正在重建...");
						btn.setDisabled(true);

						updateRebuildProgress({
							stage: "checking-local-model",
							message: "正在准备重建索引...",
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
					: "当前无索引数据",
			);

			const errorCount = this.plugin.errorLogger.size;
			if (errorCount > 0) {
				rebuildErrorHintEl.setText(`错误日志：${errorCount} 条`);
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

	/**
	 * 渲染模型选择控件
	 *
	 * 组合 UI：dropdown + 刷新按钮 + 手动输入 fallback
	 *
	 * 交互流程：
	 * 1. 设置页打开时，如果 API Key 和 URL 已配置，异步拉取模型列表
	 * 2. 拉取成功后填充 dropdown（过滤后只展示 embedding 模型）
	 * 3. 拉取失败或用户选择「手动输入」时，显示文本输入框
	 * 4. 刷新按钮清空缓存并重新拉取
	 *
	 * 为什么将此逻辑独立为方法？
	 * - 模型选择的 UI 和状态管理比其他设置项复杂
	 * - 涉及异步拉取、缓存、条件渲染等逻辑
	 * - 独立方法便于维护，不污染 display() 主流程
	 */
	private renderModelSetting(containerEl: HTMLElement): void {
		const modelSetting = new Setting(containerEl)
			.setName("Embedding 模型")
			.setDesc("选择或输入 Embedding 模型 ID");

		// 手动输入文本框的容器（条件显示）
		let manualInputEl: HTMLElement | null = null;

		// 当前是否处于手动输入模式
		const currentModel = this.plugin.settings.remoteModel;
		let isManualMode = false;
		let manualInputValue = this.plugin.settings.remoteModel;
		let manualText: TextComponent | null = null;

		/**
		 * 应用模型变更
		 * 抽取公共逻辑：更新设置、切换 provider、清空索引
		 */
		const applyModelChange = async (newModel: string): Promise<void> => {
			const prevModel = this.plugin.settings.remoteModel;
			this.plugin.settings.remoteModel = newModel;
			await this.plugin.saveSettings();
			this.plugin.embeddingService.switchProvider(this.plugin.settings);

			if (prevModel !== newModel && prevModel !== "" && newModel !== "") {
				this.plugin.noteStore.clear();
				this.plugin.chunkStore.clear();
				this.plugin.vectorStore.clear();
				new Notice("Embedding 模型名称已变更，索引已清空。请执行「重建索引」。", 8000);
			}
		};

		const applyManualModel = async (): Promise<void> => {
			const trimmed = manualInputValue.trim();
			if (!trimmed) return;
			manualInputValue = trimmed;
			await applyModelChange(trimmed);
		};

		// ── 添加 dropdown ──
		modelSetting.addDropdown((dropdown) => {
			const selectEl = dropdown.selectEl;

			// 初始状态：先放入当前值 + 手动输入选项
			if (currentModel) {
				selectEl.createEl("option", {
					value: currentModel,
					text: currentModel,
				});
			}
			selectEl.createEl("option", {
				value: MANUAL_MODEL_VALUE,
				text: "✎ 手动输入...",
			});
			dropdown.setValue(currentModel || MANUAL_MODEL_VALUE);

			// 选择变更处理
			dropdown.onChange(async (value) => {
				if (value === MANUAL_MODEL_VALUE) {
					isManualMode = true;
					if (manualInputEl) manualInputEl.show();
					if (manualText) {
						const current = this.plugin.settings.remoteModel;
						manualInputValue = current || "";
						manualText.setValue(current || manualInputValue || "");
					}
				} else {
					isManualMode = false;
					if (manualInputEl) manualInputEl.hide();
					await applyModelChange(value);
				}
			});

			// 异步加载模型列表
			// 只要求 URL 非空即可发起模型拉取（部分本地/免费服务不需要 API Key）
			const canFetch = !!this.plugin.settings.remoteApiUrl;

			if (canFetch) {
				if (this.cachedModels) {
					// 有缓存：直接填充
					this.populateModelDropdown(selectEl, this.cachedModels);
					dropdown.setValue(currentModel || MANUAL_MODEL_VALUE);
				} else {
					// 无缓存：异步拉取
					this.fetchAndPopulateModels(selectEl, dropdown, modelSetting);
				}
			}
		});

		// ── 添加刷新按钮 ──
		modelSetting.addExtraButton((btn) => {
			btn
				.setIcon("refresh-cw")
				.setTooltip("刷新模型列表")
				.onClick(async () => {
					this.cachedModels = null;
					this.display();
				});
		});

		// ── 添加手动输入文本框（默认隐藏） ──
		manualInputEl = modelSetting.controlEl.createEl("div", {
			cls: "sc-manual-model-input",
		});
		const manualInput = new Setting(manualInputEl)
			.addText((text) => {
				manualText = text;
				text
					.setPlaceholder("text-embedding-3-small")
					.setValue(this.plugin.settings.remoteModel || "")
					.onChange((value) => {
						manualInputValue = value;
					});

				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void applyManualModel();
					}
				});
			})
			.addButton((btn) => {
				btn
					.setButtonText("应用")
					.onClick(async () => {
						await applyManualModel();
					});
			});
		// 去掉嵌套 Setting 的默认边距
		manualInput.settingEl.style.border = "none";
		manualInput.settingEl.style.padding = "0";

		if (!isManualMode) {
			manualInputEl.hide();
		}
	}

	/**
	 * 渲染本地模型配置区块
	 *
	 * 仅在 embeddingProvider === "local" 时显示。
	 * 包含模型选择 dropdown 和测试按钮。
	 */
	private renderLocalModelSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("本地模型")
			.setDesc("选择用于本地 Embedding 的模型")
			.addDropdown((dropdown) => {
				for (const model of SUPPORTED_LOCAL_MODELS) {
					dropdown.addOption(model.id, model.name);
				}
				dropdown.setValue(this.plugin.settings.localModelId);
				dropdown.onChange(async (value) => {
					const prevModel = this.plugin.settings.localModelId;
					this.plugin.settings.localModelId = value;
					await this.plugin.saveSettings();
					this.plugin.embeddingService.switchProvider(this.plugin.settings);

					if (prevModel !== value) {
						this.plugin.noteStore.clear();
						this.plugin.chunkStore.clear();
						this.plugin.vectorStore.clear();
						new Notice("本地模型已切换，索引已清空。请执行“重建索引”。", 8000);
					}

					this.display();
				});
			});

		new Setting(containerEl)
			.setName("量化精度")
			.setDesc("模型量化等级，影响下载体积和推理精度")
			.addDropdown((dropdown) => {
				for (const opt of DTYPE_OPTIONS) {
					dropdown.addOption(opt.value, opt.label);
				}
				dropdown.setValue(this.plugin.settings.localDtype);
				dropdown.onChange(async (value) => {
					const prevDtype = this.plugin.settings.localDtype;
					this.plugin.settings.localDtype = value as LocalDtype;
					await this.plugin.saveSettings();
					this.plugin.embeddingService.switchProvider(this.plugin.settings);

					if (prevDtype !== value) {
						this.plugin.noteStore.clear();
						this.plugin.chunkStore.clear();
						this.plugin.vectorStore.clear();
						new Notice("量化精度已切换，索引已清空。请执行“重建索引”。", 8000);
					}

					this.display();
				});
			});

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
			.setDesc("点击下载并预热当前本地模型。若缓存已存在，会直接从本地加载。")
			.addButton((btn) => {
				downloadButton = btn;
				btn
					.setButtonText("下载")
					.setCta()
					.onClick(async () => {
						await runLocalModelDownload();
					});
			})
			.addButton((btn) => {
				redownloadButton = btn;
				btn
					.setButtonText("清理缓存并重下")
					.onClick(async () => {
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
						message: "正在清理当前本地模型缓存...",
						percent: 0,
					});

					const clearResult = await this.clearCurrentLocalModelCache();
					await this.plugin.logRuntimeEvent(
						"local-model-cache-cleared",
						clearResult.removed
							? "已清理当前本地模型缓存，准备重新下载。"
							: "未发现当前本地模型缓存，直接开始下载。",
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
					detail: `模型：${modelId} · 精度：${dtype}`,
				});

				await this.plugin.logRuntimeEvent(
					"local-model-download-requested",
					"用户在设置页触发了本地模型下载。",
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
									"Local model download entered file transfer stage.",
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
								"已开始接收本地模型文件数据。",
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
									? `正在下载本地模型：${progress.file} (${Math.round(progressValue)}%)`
									: `正在下载本地模型：${progress.file}`;
						} else if (progress.status === "ready") {
							if (!sawReady) {
								sawReady = true;
								void this.plugin.logRuntimeEvent(
									"local-model-download-ready",
									"Local model files are ready; runtime initialization is starting.",
									{
										category: "embedding",
										provider: "local",
										details: [`model=${modelId}`, `dtype=${dtype}`],
									},
								);
							}
							message = "本地模型文件已就绪，正在完成加载...";
						} else if (progress.status === "done") {
							message = progress.file
								? `模型文件已完成：${progress.file}`
								: "模型文件下载完成，等待继续初始化...";
						} else if (progress.status === "warmup") {
							if (!sawReady) {
								sawReady = true;
								void this.plugin.logRuntimeEvent(
									"local-model-download-ready",
									"Local model files are ready; runtime initialization is starting.",
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
									"Local model entered warmup stage.",
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
							`模型：${modelId}`,
							`精度：${dtype}`,
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
						message: `模型已就绪（向量维度：${result.dimension}）`,
						percent: 100,
						detail: `模型：${modelId} · 精度：${dtype}`,
						tone: "success",
					});
					await this.plugin.logRuntimeEvent(
						"local-model-ready",
						"本地模型已完成下载并预热。",
						{
							category: "embedding",
							provider: "local",
							details: [
								`model=${modelId}`,
								`dtype=${dtype}`,
								`dimension=${result.dimension}`,
							],
						},
					);
				} else {
					updateDownloadStatus({
						message: `模型下载失败：${result.error}`,
						percent: 0,
						detail: `模型：${modelId} · 精度：${dtype}`,
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
					detail: `模型：${modelId} · 精度：${dtype}`,
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
			.setDesc("加载模型并执行一次测试推理（不会主动重新下载）")
			.addButton((btn) => {
				btn
					.setButtonText("测试")
					.onClick(async () => {
						btn.setButtonText("测试中...");
						btn.setDisabled(true);

						await this.plugin.logRuntimeEvent(
							"local-model-test-requested",
							"用户在设置页触发了本地模型测试。",
							{
								category: "embedding",
								provider: "local",
								details: [`model=${this.plugin.settings.localModelId}`, `dtype=${this.plugin.settings.localDtype}`],
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
							resultEl.setText(`模型测试成功（向量维度：${result.dimension}）`);
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
							resultEl.setText(`模型测试失败：${result.error}`);
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
			.setDesc("显示最近 30 条本地模型运行日志")
			.addButton((btn) => {
				btn.setButtonText("刷新").onClick(() => {
					renderRuntimeLog();
				});
			})
			.addButton((btn) => {
				btn.setButtonText("清空").onClick(async () => {
					btn.setDisabled(true);
					await this.plugin.clearRuntimeLogs();
					renderRuntimeLog();
					btn.setDisabled(false);
				});
			});

		runtimeLogOutputEl = runtimeLogSetting.descEl.createEl("pre", {
			cls: "sc-log-output",
		});

		const errorLogSetting = new Setting(containerEl)
			.setName("错误日志")
			.setDesc("显示最近 20 条索引和运行错误")
			.addButton((btn) => {
				btn.setButtonText("刷新").onClick(() => {
					renderErrorLog();
				});
			})
			.addButton((btn) => {
				btn.setButtonText("清空").onClick(async () => {
					btn.setDisabled(true);
					await this.plugin.errorLogger.clear();
					renderErrorLog();
					btn.setDisabled(false);
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

	/**
	 * 异步拉取模型列表并填充 dropdown
	 *
	 * 拉取期间在 Setting 描述区域显示加载提示。
	 * 成功后缓存结果，失败后显示错误提示。
	 *
	 * @param selectEl - dropdown 的原生 select 元素
	 * @param dropdown - Obsidian Dropdown 组件实例
	 * @param setting - 所属的 Setting 组件（用于显示状态提示）
	 */
	private async fetchAndPopulateModels(
		selectEl: HTMLSelectElement,
		dropdown: { setValue: (value: string) => void },
		setting: Setting,
	): Promise<void> {
		// 显示加载状态
		const hintEl = setting.descEl.createEl("div", {
			cls: "sc-model-fetch-hint",
			text: "正在获取可用模型...",
		});

		const result = await this.plugin.embeddingService.fetchAvailableModels();

		hintEl.remove();

		if (result.ok && result.models.length > 0) {
			this.cachedModels = result.models;
			this.populateModelDropdown(selectEl, result.models);
			dropdown.setValue(this.plugin.settings.remoteModel || MANUAL_MODEL_VALUE);
			await this.plugin.logRuntimeEvent(
				"remote-model-list-fetched",
				"Fetched remote embedding model list.",
				{
					category: "embedding",
					provider: "remote",
					details: [`count=${result.models.length}`],
				},
			);
		} else {
			// 拉取失败或列表为空：显示提示
			const errorText = result.ok
				? "未检测到可用模型"
				: `获取模型列表失败：${result.error}`;
			setting.descEl.createEl("div", {
				cls: "sc-model-fetch-hint is-error",
				text: errorText,
			});
			if (!result.ok) {
				await this.plugin.logRuntimeError(
					"remote-model-list-fetch",
					result.diagnostic ?? result.error,
					{
						errorType: "configuration",
						filePath: "__settings__/remote-model-list-fetch",
						provider: "remote",
					},
				);
			}
		}
	}

	/**
	 * 填充远程模型 dropdown 选项（统一入口，避免重复代码）
	 *
	 * 1. 清空现有选项
	 * 2. 添加从 API 获取的模型
	 * 3. 如果当前选中的模型不在列表中，追加为额外选项
	 * 4. 追加「手动输入」选项
	 */
	private populateModelDropdown(
		selectEl: HTMLSelectElement,
		models: RemoteModelInfo[],
	): void {
		const currentModel = this.plugin.settings.remoteModel;

		selectEl.empty();

		for (const model of models) {
			const option = selectEl.createEl("option", {
				value: model.id,
				text: model.id,
			});
			if (model.id === currentModel) {
				option.selected = true;
			}
		}

		// 当前模型不在列表中时，添加额外选项确保不丢失
		const inList = models.some((m) => m.id === currentModel);
		if (currentModel && !inList) {
			const option = selectEl.createEl("option", {
				value: currentModel,
				text: `${currentModel}（当前）`,
			});
			option.selected = true;
		}

		selectEl.createEl("option", {
			value: MANUAL_MODEL_VALUE,
			text: "✎ 手动输入...",
		});
	}
}
