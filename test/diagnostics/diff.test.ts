import { describe, expect, it } from "vitest";
import { diffToFixEdit } from "../../src/diagnostics/diff.js";

describe("diffToFixEdit", () => {
	it("returns undefined for identical strings", () => {
		expect(diffToFixEdit("same", "same")).toBeUndefined();
	});

	it("computes the minimal replacement for a middle change", () => {
		expect(diffToFixEdit("hello world", "hello there")).toEqual({
			range: { start: 6, end: 11 },
			text: "there",
		});
	});

	it("computes an insertion at the end", () => {
		expect(diffToFixEdit("abc", "abcdef")).toEqual({
			range: { start: 3, end: 3 },
			text: "def",
		});
	});

	it("computes a deletion", () => {
		expect(diffToFixEdit("abcdef", "abc")).toEqual({
			range: { start: 3, end: 6 },
			text: "",
		});
	});

	it("never splits a surrogate pair even when it sits at the prefix boundary", () => {
		const emoji = "\u{1F600}"; // single astral code point, two UTF-16 units
		const before = `${emoji}abc`;
		const after = `${emoji}xyz`;
		const edit = diffToFixEdit(before, after);
		expect(edit).toBeDefined();
		// The edit must start at or after the emoji, never inside it.
		expect(edit?.range.start).toBeGreaterThanOrEqual(2);
		expect(before.slice(0, edit?.range.start)).not.toMatch(/[\uD800-\uDBFF]$/);
		expect(
			before.slice(0, edit?.range.start) +
				(edit?.text ?? "") +
				before.slice(edit?.range.end ?? 0),
		).toBe(after);
	});

	it("never splits a surrogate pair at the suffix boundary", () => {
		const emoji = "\u{1F600}";
		const before = `abc${emoji}`;
		const after = `xyz${emoji}`;
		const edit = diffToFixEdit(before, after);
		expect(edit).toBeDefined();
		expect(
			before.slice(0, edit?.range.start) +
				(edit?.text ?? "") +
				before.slice(edit?.range.end ?? 0),
		).toBe(after);
	});

	it("keeps combining characters intact when the change is elsewhere", () => {
		const combining = "é"; // "e" + combining acute accent
		const before = `${combining} start`;
		const after = `${combining} end`;
		const edit = diffToFixEdit(before, after);
		expect(edit).toBeDefined();
		expect(
			before.slice(0, edit?.range.start) +
				(edit?.text ?? "") +
				before.slice(edit?.range.end ?? 0),
		).toBe(after);
	});

	it("never splits a CRLF line ending even when the naive prefix/suffix trim would land between the CR and the LF", () => {
		// CRLF is a single extended grapheme cluster. Before this change the
		// boundary check only guarded against surrogate pairs, so trimming the
		// common suffix of "X\r\nY" -> "X\nY" would stop right after the "\r",
		// producing an edit boundary that sits between the "\r" and the "\n"
		// it is paired with.
		const before = "X\r\nY";
		const after = "X\nY";
		const edit = diffToFixEdit(before, after);
		expect(edit).toBeDefined();
		if (edit === undefined) return;
		expect(before.slice(0, edit.range.start).endsWith("\r")).toBe(false);
		expect(before.slice(edit.range.end).startsWith("\n")).toBe(false);
		expect(
			before.slice(0, edit.range.start) +
				edit.text +
				before.slice(edit.range.end),
		).toBe(after);
	});
});
