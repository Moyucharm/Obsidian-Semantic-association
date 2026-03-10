/**
 * 防抖函数
 *
 * 在最后一次调用后等待指定延迟，才执行目标函数。
 * 用于搜索输入、文件变更等高频事件的节流。
 *
 * @param fn    - 目标函数
 * @param delay - 延迟毫秒数
 * @returns 防抖包装后的函数
 */
export function debounce<T extends (...args: unknown[]) => void>(
	fn: T,
	delay: number,
): (...args: Parameters<T>) => void {
	let timer: ReturnType<typeof setTimeout> | null = null;

	return (...args: Parameters<T>) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			fn(...args);
			timer = null;
		}, delay);
	};
}
