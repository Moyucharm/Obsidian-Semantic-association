/**
 * FailedTaskManager - 持久化记录可重试的索引失败文件
 *
 * 用途：
 * - 记录因为网络中断或 API 限流（429）导致索引失败的文件路径
 * - 提供一个持久化列表，允许用户在设置页手动“重试失败项”
 *
 * 存储位置（由 main.ts 注入）：
 * `{vault}/.obsidian/plugins/{pluginId}/failed-tasks.json`
 */

import type { DataAdapter } from "obsidian";
import { normalizeErrorDiagnostic } from "../utils/error-utils";

export type FailedTaskEntry = {
	path: string;
	attempts: number;
	firstFailedAt: number;
	lastFailedAt: number;
	lastErrorCode?: string;
	lastErrorStage?: string;
	lastErrorMessage?: string;
};

interface FailedTaskData {
	version: number;
	tasks: Record<string, FailedTaskEntry>;
}

const CURRENT_VERSION = 1;

export class FailedTaskManager {
	private tasks: Map<string, FailedTaskEntry> = new Map();
	private dirty = false;

	constructor(
		private adapter: DataAdapter,
		private taskPath: string,
	) {}

	async load(): Promise<void> {
		this.tasks.clear();
		this.dirty = false;

		try {
			if (!(await this.adapter.exists(this.taskPath))) {
				return;
			}

			const raw = await this.adapter.read(this.taskPath);
			const data = JSON.parse(raw) as FailedTaskData;
			if (data.version !== CURRENT_VERSION || !data.tasks) {
				return;
			}

			for (const [path, entry] of Object.entries(data.tasks)) {
				if (typeof path !== "string" || path.trim().length === 0) {
					continue;
				}
				if (!entry || typeof entry !== "object") {
					continue;
				}

				this.tasks.set(path, {
					path,
					attempts:
						typeof entry.attempts === "number" && Number.isInteger(entry.attempts) && entry.attempts > 0
							? entry.attempts
							: 1,
					firstFailedAt:
						typeof entry.firstFailedAt === "number" && Number.isFinite(entry.firstFailedAt) && entry.firstFailedAt > 0
							? entry.firstFailedAt
							: Date.now(),
					lastFailedAt:
						typeof entry.lastFailedAt === "number" && Number.isFinite(entry.lastFailedAt) && entry.lastFailedAt > 0
							? entry.lastFailedAt
							: Date.now(),
					lastErrorCode: typeof entry.lastErrorCode === "string" ? entry.lastErrorCode : undefined,
					lastErrorStage: typeof entry.lastErrorStage === "string" ? entry.lastErrorStage : undefined,
					lastErrorMessage: typeof entry.lastErrorMessage === "string" ? entry.lastErrorMessage : undefined,
				});
			}
		} catch (error) {
			console.warn("FailedTaskManager: failed to load, starting fresh", error);
			this.tasks.clear();
			this.dirty = false;
		}
	}

	async save(): Promise<void> {
		if (!this.dirty) {
			return;
		}

		const tasks: Record<string, FailedTaskEntry> = {};
		for (const [path, entry] of this.tasks) {
			tasks[path] = entry;
		}

		const data: FailedTaskData = {
			version: CURRENT_VERSION,
			tasks,
		};

		try {
			await this.adapter.write(this.taskPath, JSON.stringify(data, null, 2));
			this.dirty = false;
		} catch (error) {
			console.error("FailedTaskManager: failed to save", error);
		}
	}

	markFailed(path: string, error: unknown): boolean {
		const normalized = path.trim();
		if (!normalized) {
			return false;
		}

		const now = Date.now();
		const diagnostic = normalizeErrorDiagnostic(error);
		const existing = this.tasks.get(normalized);

		if (existing) {
			existing.attempts += 1;
			existing.lastFailedAt = now;
			existing.lastErrorCode = diagnostic.code;
			existing.lastErrorStage = diagnostic.stage;
			existing.lastErrorMessage = diagnostic.message;
			this.dirty = true;
			return true;
		}

		this.tasks.set(normalized, {
			path: normalized,
			attempts: 1,
			firstFailedAt: now,
			lastFailedAt: now,
			lastErrorCode: diagnostic.code,
			lastErrorStage: diagnostic.stage,
			lastErrorMessage: diagnostic.message,
		});
		this.dirty = true;
		return true;
	}

	resolve(path: string): boolean {
		const normalized = path.trim();
		if (!normalized) {
			return false;
		}

		const deleted = this.tasks.delete(normalized);
		if (deleted) {
			this.dirty = true;
		}
		return deleted;
	}

	rename(oldPath: string, newPath: string): boolean {
		const oldKey = oldPath.trim();
		const newKey = newPath.trim();
		if (!oldKey || !newKey || oldKey === newKey) {
			return false;
		}

		const entry = this.tasks.get(oldKey);
		if (!entry) {
			return false;
		}

		this.tasks.delete(oldKey);
		entry.path = newKey;
		this.tasks.set(newKey, entry);
		this.dirty = true;
		return true;
	}

	getAllPaths(): string[] {
		return Array.from(this.tasks.keys());
	}

	get size(): number {
		return this.tasks.size;
	}

	get isDirty(): boolean {
		return this.dirty;
	}

	async clear(): Promise<void> {
		this.tasks.clear();
		this.dirty = true;
		await this.save();
	}
}

