/**
 * Renders a minimal unified-diff-style preview of the line-level changes
 * between `before` and `after`, for `--dry-run` output. Not a general-purpose
 * diff: it trims the common leading/trailing lines and reports everything in
 * between as one replaced hunk, which is sufficient to preview what --fix
 * would write without pulling in a diff dependency.
 */
export function renderDiffPreview(
	filePath: string,
	before: string,
	after: string,
	contextLines = 3,
): string {
	if (before === after) return "";
	const beforeLines = before.split(/\r\n|\r|\n/);
	const afterLines = after.split(/\r\n|\r|\n/);

	const maxPrefix = Math.min(beforeLines.length, afterLines.length);
	let prefix = 0;
	while (prefix < maxPrefix && beforeLines[prefix] === afterLines[prefix])
		prefix += 1;

	const maxSuffix = Math.min(beforeLines.length, afterLines.length) - prefix;
	let suffix = 0;
	while (
		suffix < maxSuffix &&
		beforeLines[beforeLines.length - 1 - suffix] ===
			afterLines[afterLines.length - 1 - suffix]
	)
		suffix += 1;

	const contextStart = Math.max(0, prefix - contextLines);
	const beforeEnd = beforeLines.length - suffix;
	const afterEnd = afterLines.length - suffix;
	const contextEnd = Math.min(beforeLines.length, beforeEnd + contextLines);

	const lines: string[] = [
		`--- a/${filePath}`,
		`+++ b/${filePath}`,
		`@@ -${contextStart + 1},${contextEnd - contextStart} +${contextStart + 1},${
			afterEnd - contextStart + (contextEnd - beforeEnd)
		} @@`,
	];
	for (let i = contextStart; i < prefix; i += 1)
		lines.push(` ${beforeLines[i]}`);
	for (let i = prefix; i < beforeEnd; i += 1) lines.push(`-${beforeLines[i]}`);
	for (let i = prefix; i < afterEnd; i += 1) lines.push(`+${afterLines[i]}`);
	for (let i = beforeEnd; i < contextEnd; i += 1)
		lines.push(` ${beforeLines[i]}`);
	return `${lines.join("\n")}\n`;
}
