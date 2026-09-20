import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../../src/diagnostics/types.js";
import { mergeEdits } from "../../src/fix/edits.js";

function diagnostic(
	overrides: Partial<Diagnostic> & { ruleId: string },
): Diagnostic {
	return {
		engine: "prh",
		message: "message",
		severity: "error",
		filePath: "fixture.md",
		location: {
			start: { line: 1, column: 1 },
			end: { line: 1, column: 1 },
			range: { start: 0, end: 0 },
		},
		...overrides,
	};
}

describe("mergeEdits", () => {
	it("applies disjoint edits from multiple engines in one pass", () => {
		const base = "foo bar baz";
		const a = diagnostic({
			ruleId: "a",
			engine: "prh",
			fix: { range: { start: 0, end: 3 }, text: "FOO" },
		});
		const b = diagnostic({
			ruleId: "b",
			engine: "textlint",
			fix: { range: { start: 8, end: 11 }, text: "BAZ" },
		});
		const result = mergeEdits(base, [a, b]);
		expect(result.text).toBe("FOO bar BAZ");
		expect(result.applied.map((item) => item.ruleId)).toEqual(["a", "b"]);
		expect(result.conflicts).toEqual([]);
	});

	it("treats adjacent (touching, non-overlapping) edits as independent", () => {
		const base = "abcdef";
		const a = diagnostic({
			ruleId: "a",
			fix: { range: { start: 0, end: 3 }, text: "XXX" },
		});
		const b = diagnostic({
			ruleId: "b",
			fix: { range: { start: 3, end: 6 }, text: "YYY" },
		});
		const result = mergeEdits(base, [a, b]);
		expect(result.text).toBe("XXXYYY");
		expect(result.conflicts).toEqual([]);
	});

	it("defers conflicting edits from different engines and reports both, applying neither", () => {
		const base = "hello world";
		const a = diagnostic({
			ruleId: "prefer-hello-upper",
			engine: "prh",
			fix: { range: { start: 0, end: 5 }, text: "Hello" },
		});
		const b = diagnostic({
			ruleId: "prefer-hello-shout",
			engine: "textlint",
			fix: { range: { start: 0, end: 5 }, text: "HELLO" },
		});
		const result = mergeEdits(base, [a, b]);
		expect(result.text).toBe(base);
		expect(result.applied).toEqual([]);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]?.kind).toBe("conflicting");
		expect(
			result.conflicts[0]?.diagnostics.map((item) => item.ruleId).sort(),
		).toEqual(["prefer-hello-shout", "prefer-hello-upper"]);
	});

	it("applies byte-identical duplicate edits once and reports them as duplicates", () => {
		const base = "hello world";
		const a = diagnostic({
			ruleId: "a",
			engine: "prh",
			fix: { range: { start: 0, end: 5 }, text: "Hello" },
		});
		const b = diagnostic({
			ruleId: "b",
			engine: "textlint",
			fix: { range: { start: 0, end: 5 }, text: "Hello" },
		});
		const result = mergeEdits(base, [a, b]);
		expect(result.text).toBe("Hello world");
		expect(result.applied).toHaveLength(1);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]?.kind).toBe("duplicate");
		expect(result.conflicts[0]?.diagnostics).toHaveLength(2);
	});

	it("never invents an edit for a diagnostic that carries only suggestions", () => {
		const base = "todo item";
		const suggestionOnly = diagnostic({
			ruleId: "no-todo",
			suggestions: [
				{
					id: "s1",
					message: "consider removing todo",
					fix: { range: { start: 0, end: 4 }, text: "" },
				},
			],
		});
		const result = mergeEdits(base, [suggestionOnly]);
		expect(result.text).toBe(base);
		expect(result.applied).toEqual([]);
		expect(result.conflicts).toEqual([]);
	});

	it("leaves the base untouched when there are no fixable diagnostics", () => {
		const result = mergeEdits("unchanged", []);
		expect(result).toEqual({ text: "unchanged", applied: [], conflicts: [] });
	});

	describe("zero-length (insertion) edits", () => {
		it("treats two different insertions at the same point as conflicting instead of applying both", () => {
			// Regression for the major-2 review finding: the old overlap check
			// was `a.start < b.end && b.start < a.end`, which is false whenever
			// both ranges are empty at the same point (0 < 0 is always false), so
			// two unrelated insertions at [1, 1) silently both applied.
			const base = "abc";
			const a = diagnostic({
				ruleId: "a",
				fix: { range: { start: 1, end: 1 }, text: "X" },
			});
			const b = diagnostic({
				ruleId: "b",
				fix: { range: { start: 1, end: 1 }, text: "Y" },
			});
			const result = mergeEdits(base, [a, b]);
			expect(result.text).toBe(base);
			expect(result.applied).toEqual([]);
			expect(result.conflicts).toHaveLength(1);
			expect(result.conflicts[0]?.kind).toBe("conflicting");
		});

		it("applies a same-position, same-content insertion only once instead of doubling it up", () => {
			const base = "abc";
			const a = diagnostic({
				ruleId: "a",
				engine: "prh",
				fix: { range: { start: 1, end: 1 }, text: "X" },
			});
			const b = diagnostic({
				ruleId: "b",
				engine: "textlint",
				fix: { range: { start: 1, end: 1 }, text: "X" },
			});
			const result = mergeEdits(base, [a, b]);
			expect(result.text).toBe("aXbc");
			expect(result.applied).toHaveLength(1);
			expect(result.conflicts).toHaveLength(1);
			expect(result.conflicts[0]?.kind).toBe("duplicate");
		});

		it("treats an insertion at the start of another edit's range as conflicting with it", () => {
			// [0, 0) and [0, 1) used to be judged non-overlapping (0 < 1 is true,
			// but 0 < 0 is false), so both applied and the apply loop's
			// descending-by-start order made the insertion silently replace the
			// character the other edit meant to replace instead of preceding it.
			const base = "abc";
			const insertion = diagnostic({
				ruleId: "insert",
				fix: { range: { start: 0, end: 0 }, text: "X" },
			});
			const replacement = diagnostic({
				ruleId: "replace",
				fix: { range: { start: 0, end: 1 }, text: "Z" },
			});
			const result = mergeEdits(base, [insertion, replacement]);
			expect(result.text).toBe(base);
			expect(result.applied).toEqual([]);
			expect(result.conflicts).toHaveLength(1);
			expect(result.conflicts[0]?.kind).toBe("conflicting");
		});

		it("keeps an insertion exactly at another edit's end independent of it (touching, not overlapping)", () => {
			const base = "abc";
			const replacement = diagnostic({
				ruleId: "replace",
				fix: { range: { start: 0, end: 1 }, text: "Z" },
			});
			const insertion = diagnostic({
				ruleId: "insert",
				fix: { range: { start: 1, end: 1 }, text: "X" },
			});
			const result = mergeEdits(base, [replacement, insertion]);
			expect(result.text).toBe("ZXbc");
			expect(result.conflicts).toEqual([]);
		});
	});

	describe("grapheme-cluster protection", () => {
		it("treats fixes on the two code units of one decomposed grapheme cluster as conflicting instead of composing a character neither engine proposed", () => {
			// Regression for the major-4 review finding: "e" + combining acute
			// accent (U+0301) is one extended grapheme cluster spanning both
			// UTF-16 units. A fix that only touches the base character and
			// another that only touches the combining mark used to be judged
			// non-overlapping ([0, 1) and [1, 2) merely touch), so both applied
			// and produced "a" + combining grave -- a character neither engine
			// ever proposed.
			const base = "é rest";
			const swapBase = diagnostic({
				ruleId: "swap-base",
				engine: "textlint",
				fix: { range: { start: 0, end: 1 }, text: "a" },
			});
			const swapAccent = diagnostic({
				ruleId: "swap-accent",
				engine: "markdownlint",
				fix: { range: { start: 1, end: 2 }, text: "̀" },
			});
			const result = mergeEdits(base, [swapBase, swapAccent]);
			expect(result.text).toBe(base);
			expect(result.applied).toEqual([]);
			expect(result.conflicts).toHaveLength(1);
			expect(result.conflicts[0]?.kind).toBe("conflicting");
		});

		it("refuses a solitary fix whose own range splits a grapheme cluster", () => {
			const base = "é rest";
			const swapBase = diagnostic({
				ruleId: "swap-base",
				fix: { range: { start: 0, end: 1 }, text: "a" },
			});
			const result = mergeEdits(base, [swapBase]);
			expect(result.text).toBe(base);
			expect(result.applied).toEqual([]);
			expect(result.conflicts).toHaveLength(1);
			expect(result.conflicts[0]?.kind).toBe("conflicting");
		});

		it("still applies a fix whose range lands cleanly on grapheme-cluster boundaries", () => {
			const base = "é rest";
			const swapWholeCluster = diagnostic({
				ruleId: "swap-cluster",
				fix: { range: { start: 0, end: 2 }, text: "à" },
			});
			const result = mergeEdits(base, [swapWholeCluster]);
			expect(result.text).toBe("à rest");
			expect(result.applied).toHaveLength(1);
			expect(result.conflicts).toEqual([]);
		});
	});
});
