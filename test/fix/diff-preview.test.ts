import { describe, expect, it } from "vitest";
import { renderDiffPreview } from "../../src/fix/diff-preview.js";

describe("renderDiffPreview", () => {
	it("returns an empty string when nothing changed", () => {
		expect(renderDiffPreview("f.md", "same\n", "same\n")).toBe("");
	});

	it("renders a hunk that reconstructs both sides from the header and body", () => {
		const before = "line1\nline2\nline3\nline4\nline5\n";
		const after = "line1\nline2\nCHANGED\nline4\nline5\n";
		const diff = renderDiffPreview("f.md", before, after, 1);

		expect(diff).toContain("--- a/f.md");
		expect(diff).toContain("+++ b/f.md");
		expect(diff).toContain("-line3");
		expect(diff).toContain("+CHANGED");
		// Context lines immediately surrounding the change are included.
		expect(diff).toContain(" line2");
		expect(diff).toContain(" line4");

		const body = diff.split("\n").slice(3);
		const removed = body
			.filter((line) => line.startsWith("-"))
			.map((line) => line.slice(1));
		const added = body
			.filter((line) => line.startsWith("+"))
			.map((line) => line.slice(1));
		expect(removed).toEqual(["line3"]);
		expect(added).toEqual(["CHANGED"]);
	});

	it("hunk header line counts match the number of context/-/+ lines actually printed", () => {
		const before = "a\nb\nc\nd\ne\nf\ng\n";
		const after = "a\nb\nX\nY\nd\ne\nf\ng\n";
		const diff = renderDiffPreview("f.md", before, after, 2);
		const header = diff.split("\n")[2] ?? "";
		const match = header.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/);
		expect(match).not.toBeNull();
		const [, , beforeCount, , afterCount] = match as unknown as string[];

		const bodyLines = diff.split("\n").slice(3, -1);
		const beforeLines = bodyLines.filter(
			(line) => line.startsWith("-") || line.startsWith(" "),
		);
		const afterLines = bodyLines.filter(
			(line) => line.startsWith("+") || line.startsWith(" "),
		);
		expect(beforeLines).toHaveLength(Number(beforeCount));
		expect(afterLines).toHaveLength(Number(afterCount));
	});
});
