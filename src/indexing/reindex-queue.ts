/**
 * ReindexQueue - 索引任务防抖去重队列
 *
 * 职责：
 * - 接收文件变更事件，将其转化为索引任务
 * - 对同一文件的多次变更进行去重（只保留最新一次）
 * - 防抖处理：短时间内的连续变更合并为一次索引
 * - 串行执行：同一时刻只运行一个索引任务，避免并发冲突
 *
 * 设计要点：
 * - 队列只负责"调度"，实际索引逻辑由 ReindexService 执行
 * - 外部通过 enqueue() 提交任务，队列自动处理时序
 */

/** 索引任务类型 */
export type IndexTaskType = "create" | "modify" | "delete" | "rename";

/** 单个索引任务 */
export interface IndexTask {
	type: IndexTaskType;
	/** 文件路径（rename 时为新路径） */
	path: string;
	/** rename 时的旧路径 */
	oldPath?: string;
}

/** 任务执行回调函数签名 */
type TaskExecutor = (task: IndexTask) => Promise<void>;

/** 防抖默认延迟（ms） */
const DEBOUNCE_DELAY = 1000;

export class ReindexQueue {
	/** 待执行任务池，按 path 去重 */
	private pending: Map<string, IndexTask> = new Map();
	/** 是否正在执行任务 */
	private processing = false;
	/** 防抖定时器 */
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	/** 任务执行器（由 ReindexService 注入） */
	private executor: TaskExecutor | null = null;

	constructor(private debounceDelay: number = DEBOUNCE_DELAY) {}

	/**
	 * 注册任务执行器
	 * 遵循 DIP 原则：队列不直接依赖 ReindexService
	 */
	setExecutor(executor: TaskExecutor): void {
		this.executor = executor;
	}

	/**
	 * 提交一个索引任务
	 * 同一 path 的任务会被后来的覆盖（去重）
	 */
	enqueue(task: IndexTask): void {
		// 去重：同一路径只保留最新任务
		this.pending.set(task.path, task);

		// 重置防抖计时器
		this.resetDebounce();
	}

	/** 获取当前待执行任务数 */
	get pendingCount(): number {
		return this.pending.size;
	}

	/** 是否正在处理任务 */
	get isProcessing(): boolean {
		return this.processing;
	}

	/** 清空队列 */
	clear(): void {
		this.pending.clear();
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}

	/**
	 * 重置防抖计时器
	 * 每次有新任务入队时重新计时，到期后执行所有累积任务
	 */
	private resetDebounce(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			this.flush();
		}, this.debounceDelay);
	}

	/**
	 * 执行所有累积的任务
	 * 串行逐个执行，避免并发冲突
	 */
	private async flush(): Promise<void> {
		if (this.processing || this.pending.size === 0) return;
		if (!this.executor) {
			console.warn("ReindexQueue: no executor registered");
			return;
		}

		this.processing = true;

		try {
			// 取出当前所有待执行任务并清空队列
			const tasks = Array.from(this.pending.values());
			this.pending.clear();

			// 串行执行每个任务
			for (const task of tasks) {
				try {
					await this.executor(task);
				} catch (err) {
					console.error(`ReindexQueue: failed to process task [${task.type}] ${task.path}`, err);
				}
			}
		} finally {
			this.processing = false;

			// 执行期间可能有新任务入队，需要再次检查
			if (this.pending.size > 0) {
				this.resetDebounce();
			}
		}
	}
}
