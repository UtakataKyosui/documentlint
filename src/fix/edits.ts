import type {
	Diagnostic,
	FixConflict,
	TextRange,
} from "../diagnostics/types.js";

export interface MergeEditsResult {
	readonly text: string;
	readonly applied: readonly Diagnostic[];
	readonly conflicts: readonly FixConflict[];
}

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

function floorBoundary(
	boundaries: ReadonlySet<number>,
	offset: number,
): number {
	let index = offset;
	while (index > 0 && !boundaries.has(index)) index -= 1;
	return index;
}

function ceilBoundary(
	boundaries: ReadonlySet<number>,
	offset: number,
	length: number,
): number {
	let index = offset;
	while (index < length && !boundaries.has(index)) index += 1;
	return index;
}

/** Widens `range` outward to the nearest grapheme-cluster boundaries of `base`. */
function toClusterRange(
	boundaries: ReadonlySet<number>,
	base: string,
	range: TextRange,
): TextRange {
	return {
		start: floorBoundary(boundaries, range.start),
		end: ceilBoundary(boundaries, range.end, base.length),
	};
}

/**
 * True when a zero-length insertion at `point` targets the same text as
 * `interval`: strictly inside it, or exactly at its start (applying both
 * would otherwise depend on apply order: inserting first shifts the
 * replacement, replacing first discards the insertion point). An insertion
 * at `interval.end` is independent -- the same "touching, non-overlapping"
 * case as two adjacent replacements.
 */
function insertionConflictsWithInterval(
	point: number,
	interval: TextRange,
): boolean {
	return interval.start <= point && point < interval.end;
}

/** Half-open range overlap, generalized so a zero-length range is treated as an insertion point rather than an empty interval. */
function rangesConflict(a: TextRange, b: TextRange): boolean {
	const aEmpty = a.start === a.end;
	const bEmpty = b.start === b.end;
	if (!aEmpty && !bEmpty) return a.start < b.end && b.start < a.end;
	if (aEmpty && bEmpty) return a.start === b.start;
	return aEmpty
		? insertionConflictsWithInterval(a.start, b)
		: insertionConflictsWithInterval(b.start, a);
}

function isIdenticalEdit(a: Diagnostic, b: Diagnostic): boolean {
	return (
		a.fix !== undefined &&
		b.fix !== undefined &&
		a.fix.range.start === b.fix.range.start &&
		a.fix.range.end === b.fix.range.end &&
		a.fix.text === b.fix.text
	);
}

function groupRange(group: readonly Diagnostic[]): TextRange {
	return {
		start: Math.min(...group.map((item) => item.fix?.range.start ?? 0)),
		end: Math.max(...group.map((item) => item.fix?.range.end ?? 0)),
	};
}

function find(parent: number[], index: number): number {
	let root = index;
	for (;;) {
		const next = parent[root];
		if (next === undefined || next === root) return root;
		root = next;
	}
}

function union(parent: number[], a: number, b: number): void {
	const rootA = find(parent, a);
	const rootB = find(parent, b);
	if (rootA !== rootB) parent[rootA] = rootB;
}

/**
 * Groups diagnostics whose (cluster-widened) fix ranges transitively overlap,
 * via connected components rather than a single sorted-window scan: once
 * zero-length insertions are in the mix, overlap isn't limited to adjacent
 * pairs in start order (an insertion at the shared boundary of two otherwise
 * disjoint replacements links them both into one group).
 */
function groupByConflict(
	items: readonly (Diagnostic & {
		readonly fix: NonNullable<Diagnostic["fix"]>;
	})[],
	clusterRangeOf: (range: TextRange) => TextRange,
): Diagnostic[][] {
	const parent = items.map((_, index) => index);
	for (let i = 0; i < items.length; i += 1) {
		const itemI = items[i];
		if (itemI === undefined) continue;
		for (let j = i + 1; j < items.length; j += 1) {
			const itemJ = items[j];
			if (itemJ === undefined) continue;
			if (
				rangesConflict(
					clusterRangeOf(itemI.fix.range),
					clusterRangeOf(itemJ.fix.range),
				)
			)
				union(parent, i, j);
		}
	}
	const groups = new Map<number, Diagnostic[]>();
	items.forEach((item, index) => {
		const root = find(parent, index);
		const group = groups.get(root) ?? [];
		group.push(item);
		groups.set(root, group);
	});
	return [...groups.values()].sort(
		(a, b) =>
			groupRange(a).start - groupRange(b).start ||
			groupRange(a).end - groupRange(b).end,
	);
}

/**
 * Merges fix edits proposed by (possibly several) engines against the same
 * `base` text. Edits with disjoint ranges are always applied. Edits whose
 * ranges overlap -- including a zero-length insertion landing inside or at
 * the start of another edit's range -- are grouped by transitive overlap: a
 * group where every edit is byte-identical is applied once and reported as
 * a "duplicate" conflict; any other overlapping group, or a single edit
 * whose own range splits a grapheme cluster (e.g. it touches only the base
 * character or only the combining mark of an accented letter), is left
 * entirely unapplied and reported as a "conflicting" conflict, so no
 * engine's fix ever silently overwrites another's or composes a character
 * neither engine proposed.
 */
export function mergeEdits(
	base: string,
	diagnostics: readonly Diagnostic[],
): MergeEditsResult {
	const fixable = diagnostics.filter(
		(item): item is Diagnostic & { fix: NonNullable<Diagnostic["fix"]> } =>
			item.fix !== undefined,
	);

	const boundaries = graphemeBoundaries(base);
	const clusterRangeOf = (range: TextRange) =>
		toClusterRange(boundaries, base, range);

	const groups = groupByConflict(fixable, clusterRangeOf);

	const accepted: Diagnostic[] = [];
	const conflicts: FixConflict[] = [];
	for (const group of groups) {
		if (group.length === 1) {
			const only = group[0];
			if (only === undefined) continue;
			const fix = only.fix;
			if (fix === undefined) continue;
			const widened = clusterRangeOf(fix.range);
			if (widened.start === fix.range.start && widened.end === fix.range.end) {
				accepted.push(only);
			} else {
				conflicts.push({
					range: groupRange(group),
					kind: "conflicting",
					diagnostics: group,
				});
			}
			continue;
		}
		const allIdentical = group.every(
			(item, i) => i === 0 || isIdenticalEdit(item, group[0] as Diagnostic),
		);
		if (allIdentical) {
			const representative = group[0];
			if (representative !== undefined) accepted.push(representative);
			conflicts.push({
				range: groupRange(group),
				kind: "duplicate",
				diagnostics: group,
			});
		} else {
			conflicts.push({
				range: groupRange(group),
				kind: "conflicting",
				diagnostics: group,
			});
		}
	}

	let text = base;
	for (const item of [...accepted].sort(
		(a, b) =>
			(b.fix?.range.start ?? 0) - (a.fix?.range.start ?? 0) ||
			(b.fix?.range.end ?? 0) - (a.fix?.range.end ?? 0),
	)) {
		const fix = item.fix;
		if (fix === undefined) continue;
		text =
			text.slice(0, fix.range.start) + fix.text + text.slice(fix.range.end);
	}

	return { text, applied: accepted, conflicts };
}
