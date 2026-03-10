import { App, Modal } from "obsidian";

export class SyncChangedNotesModal extends Modal {
	constructor(
		app: App,
		private options: {
			changedCount: number;
			tokenEstimate: number;
			onConfirm: () => Promise<void> | void;
		},
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "同步变动笔记" });

		const tokenText = Number.isFinite(this.options.tokenEstimate)
			? this.options.tokenEstimate.toLocaleString()
			: "未知";
		contentEl.createEl("p", {
			text: `发现 ${this.options.changedCount} 篇笔记有变动，预计消耗约 ${tokenText} Token，是否开始同步？`,
		});

		const buttons = contentEl.createEl("div", { cls: "sc-modal-buttons" });

		const cancelBtn = buttons.createEl("button", { text: "取消" });
		cancelBtn.addClass("mod-muted");
		cancelBtn.addEventListener("click", () => this.close());

		const confirmBtn = buttons.createEl("button", { text: "开始同步" });
		confirmBtn.addClass("mod-cta");
		confirmBtn.addEventListener("click", () => {
			confirmBtn.disabled = true;
			this.close();
			void this.options.onConfirm();
		});
	}
}

