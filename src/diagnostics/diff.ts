import type { FixEdit } from "./types.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});

/** Every UTF-16 offset that starts a grapheme cluster in `text` (always includes 0 and `text.length`). */
function graphemeBoundaries(text: string): Set<number> {
	const boundaries = new Set<number>([0, text.length]);
	for (const segment of graphemeSegmenter.segment(text))
		boundaries.add(segment.index);
	return boundaries;
}

/**
 * True unless `index` sits inside a grapheme cluster in `text` -- either
 * between the two UTF-16 code units of a surrogate pair, between a base
 * character and a combining mark, or between the `\r` and `\n` of a CRLF
 * line ending. Grapheme-cluster boundaries are a subset of surrogate-pair
 * boundaries, so this subsumes the old surrogate-only check.
 */
function isSafeBoundary(text: string, index: number): boolean {
	if (index <= 0 || index >= text.length) return true;
	return graphemeBoundaries(text).has(index);
}

/**
 * Computes the smallest replacement edit that turns `before` into `after` by
 * trimming their common prefix and suffix. Returns undefined when the two
 * strings are identical. The boundary never lands inside a grapheme cluster
 * (surrogate pair, combining mark, or CRLF), in either string, even when the
 * cluster itself is outside the changed region.
 */
export function diffToFixEdit(
	before: string,
	after: string,
): FixEdit | undefined {
	if (before === after) return undefined;

	const maxPrefix = Math.min(before.length, after.length);
	let prefix = 0;
	while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;
	while (
		prefix > 0 &&
		(!isSafeBoundary(before, prefix) || !isSafeBoundary(after, prefix))
	)
		prefix -= 1;

	const maxSuffix = Math.min(before.length, after.length) - prefix;
	let suffix = 0;
	while (
		suffix < maxSuffix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	)
		suffix += 1;
	while (
		suffix > 0 &&
		(!isSafeBoundary(before, before.length - suffix) ||
			!isSafeBoundary(after, after.length - suffix))
	)
		suffix -= 1;

	return {
		range: { start: prefix, end: before.length - suffix },
		text: after.slice(prefix, after.length - suffix),
	};
}
