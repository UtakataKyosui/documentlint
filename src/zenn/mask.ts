/** Replaces ignored Zenn/Markdown syntax with spaces while preserving every offset and line break. */
export function maskZennSyntax(text: string): string {
	const mask = (value: string) => value.replace(/[^\r\n]/g, " ");
	return text
		.replace(/^---\r?\n[\s\S]*?^---\s*(?:\r?\n|$)/m, mask)
		.replace(/```[^\r\n]*\r?\n[\s\S]*?^```/gm, mask)
		.replace(/`[^`\r\n]*`/g, mask)
		.replace(/!?\[[^\]]*\]\([^)]*\)/g, mask)
		.replace(/\$\$[\s\S]*?\$\$/g, mask)
		.replace(/\$[^$\r\n]+\$/g, mask);
}
