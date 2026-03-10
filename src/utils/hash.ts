/**
 * 内容 hash 工具函数
 *
 * 用于判断文件内容是否发生变更，
 * 避免内容未变时重复索引。
 *
 * v1 采用简单的 DJB2 hash 算法，速度快且碰撞率可接受。
 */

/**
 * 对文本内容生成 hash 字符串
 * 采用 DJB2 算法，输出 16 进制字符串
 *
 * @param content - 原始文本内容
 * @returns hash 字符串
 */
export function hashContent(content: string): string {
	let hash = 5381;
	for (let i = 0; i < content.length; i++) {
		// hash * 33 + charCode
		hash = ((hash << 5) + hash + content.charCodeAt(i)) >>> 0;
	}
	return hash.toString(16);
}
