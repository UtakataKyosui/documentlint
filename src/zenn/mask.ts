import type { TextRange } from "../diagnostics/types.js";

export interface ZennMaskResult {
	readonly masked: string;
	readonly ranges: readonly TextRange[];
}

const MASK_PATTERNS = [
	/^---\r?\n[\s\S]*?^---\s*(?:\r?\n|$)/m,
	/```[^\r\n]*\r?\n[\s\S]*?^```/gm,
	/`[^`\r\n]*`/g,
	/!?\[[^\]]*\]\([^)]*\)/g,
	/\$\$[\s\S]*?\$\$/g,
	/\$[^$\r\n]+\$/g,
];

/**
 * Replaces ignored Zenn/Markdown syntax with spaces while preserving every
 * offset and line break, and records the exact `[start, end)` ranges that
 * were masked so callers can tell a real edit apart from one computed
 * against a placeholder (see runner.ts's use of `ranges`).
 */
export function maskZennSyntaxRanges(text: string): ZennMaskResult {
	const ranges: TextRange[] = [];
	const mask = (match: string, offset: number): string => {
		ranges.push({ start: offset, end: offset + match.length });
		return match.replace(/[^\r\n]/g, " ");
	};
	let masked = text;
	for (const pattern of MASK_PATTERNS)
		masked = masked.replace(pattern, (match: string, ...rest: unknown[]) => {
			// None of the patterns above contain capture groups, so the first
			// extra argument the replacer receives is always the match offset.
			const offset = rest[0];
			return mask(match, typeof offset === "number" ? offset : 0);
		});
	ranges.sort((a, b) => a.start - b.start || a.end - b.end);
	return { masked, ranges };
}

/** Replaces ignored Zenn/Markdown syntax with spaces while preserving every offset and line break. */
export function maskZennSyntax(text: string): string {
	return maskZennSyntaxRanges(text).masked;
}

/**
 * True when `range` was computed against masked (fabricated) content rather
 * than the real source: a non-empty range is masked if it overlaps any
 * masked span at all, and a zero-length insertion is masked only if it sits
 * strictly inside one -- landing exactly on a mask boundary means the
 * insertion targets real, untouched content next to the mask, not the mask
 * itself.
 */
export function isRangeMasked(
	range: TextRange,
	maskedRanges: readonly TextRange[],
): boolean {
	return maskedRanges.some((masked) =>
		range.start === range.end
			? masked.start < range.start && range.start < masked.end
			: range.start < masked.end && masked.start < range.end,
	);
}
