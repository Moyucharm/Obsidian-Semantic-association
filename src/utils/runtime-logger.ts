import type { DataAdapter } from "obsidian";
import type { RuntimeLogEntry } from "../types";

interface RuntimeLogData {
	version: number;
	lastCleanup: number;
	entries: RuntimeLogEntry[];
}

const CURRENT_VERSION = 1;
const MAX_ENTRIES = 1000;
const EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

export class RuntimeLogger {
	private entries: RuntimeLogEntry[] = [];
	private lastCleanup = 0;
	private dirty = false;

	constructor(
		private adapter: DataAdapter,
		private logPath: string,
	) {}

	async load(): Promise<void> {
		try {
			if (await this.adapter.exists(this.logPath)) {
				const raw = await this.adapter.read(this.logPath);
				const data = JSON.parse(raw) as RuntimeLogData;

				if (data.version === CURRENT_VERSION) {
					this.entries = data.entries || [];
					this.lastCleanup = data.lastCleanup || 0;
				}
			}
		} catch (err) {
			console.warn("RuntimeLogger: failed to load, starting fresh", err);
			this.entries = [];
			this.lastCleanup = 0;
			this.log({
				event: "runtime-log-load-failed",
				level: "warn",
				category: "storage",
				message: "Failed to load persisted runtime log. A fresh log will be created.",
				details: [
					`log_path=${this.logPath}`,
					`cause=${err instanceof Error ? err.message : String(err)}`,
				],
			});
		}
	}

	async save(): Promise<void> {
		if (!this.dirty && this.entries.length === 0) {
			return;
		}

		const data: RuntimeLogData = {
			version: CURRENT_VERSION,
			lastCleanup: this.lastCleanup,
			entries: this.entries,
		};

		try {
			await this.adapter.write(this.logPath, JSON.stringify(data, null, 2));
			this.dirty = false;
		} catch (err) {
			console.error("RuntimeLogger: failed to save", err);
		}
	}

	log(entry: Omit<RuntimeLogEntry, "timestamp">): void {
		this.entries.push({
			...entry,
			timestamp: Date.now(),
		});

		if (this.entries.length > MAX_ENTRIES) {
			const overflow = this.entries.length - MAX_ENTRIES;
			this.entries = this.entries.slice(overflow);
		}

		this.dirty = true;
	}

	async logAndSave(entry: Omit<RuntimeLogEntry, "timestamp">): Promise<void> {
		this.log(entry);
		await this.save();
	}

	async cleanupIfNeeded(): Promise<number> {
		const now = Date.now();
		if (this.lastCleanup > 0 && (now - this.lastCleanup) < EXPIRY_MS) {
			return 0;
		}

		const cutoff = now - EXPIRY_MS;
		const before = this.entries.length;
		this.entries = this.entries.filter((entry) => entry.timestamp >= cutoff);
		const removed = before - this.entries.length;

		this.lastCleanup = now;
		if (removed > 0 || before > 0) {
			this.dirty = true;
			await this.save();
			console.log(
				`RuntimeLogger: cleaned up ${removed} expired entries (${this.entries.length} remaining)`,
			);
		}

		return removed;
	}

	getRecent(count: number = 50): RuntimeLogEntry[] {
		return this.entries.slice(-count);
	}

	get size(): number {
		return this.entries.length;
	}

	get maxEntries(): number {
		return MAX_ENTRIES;
	}

	get isDirty(): boolean {
		return this.dirty;
	}

	async clear(): Promise<void> {
		this.entries = [];
		this.lastCleanup = Date.now();
		this.dirty = true;
		await this.save();
	}
}
