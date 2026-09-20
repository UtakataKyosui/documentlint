import { describe, expect, it } from "vitest";
import { createMarkdownlintAdapter } from "../../src/adapters/markdownlint/adapter.js";

describe("markdownlint adapter", () => {
	const adapter = createMarkdownlintAdapter({
		config: {
			MD012: true,
			MD022: true,
			MD032: true,
			MD013: { line_length: 20 },
		},
	});

	it("preserves markdownlint rule IDs and locations", async () => {
		const result = await adapter.lintText(
			"# Heading\ntext\n- item\n- item\n\nThis is a deliberately long line.\n",
			"fixture.md",
		);
		expect(result.diagnostics.some((item) => item.ruleId === "MD022")).toBe(
			true,
		);
		expect(result.diagnostics.some((item) => item.ruleId === "MD032")).toBe(
			true,
		);
		expect(result.diagnostics.some((item) => item.ruleId === "MD013")).toBe(
			true,
		);
		expect(
			result.diagnostics.every(
				(item) =>
					item.engine === "markdownlint" && item.location.start.line > 0,
			),
		).toBe(true);
	});

	it("returns fixable markdownlint diagnostics and output", async () => {
		const result = await createMarkdownlintAdapter({
			config: { MD009: { br_spaces: 0 } },
		}).fixText("line   \n", "fixture.md");
		expect(result.output).toBe("line\n");
		expect(result.applied.map((item) => item.ruleId)).toContain("MD009");
	});

	it("loads a markdown-it footnote plugin by module name", async () => {
		const result = await createMarkdownlintAdapter({
			markdownItPlugins: ["markdown-it-footnote"],
		}).lintText("A note.[^1]\n\n[^1]: Footnote.\n", "fixture.md");
		expect(
			result.diagnostics.every((item) => item.engine === "markdownlint"),
		).toBe(true);
	});

	it("computes offsets correctly for CRLF documents, not just LF", async () => {
		// A flat "+1 per line" offset calculation drops one byte (the "\r") per
		// preceding line under CRLF, so the 4th line's diagnostic would land 3
		// characters before the actual "#" of "# Another".
		const text = "# Heading\r\ntext\r\n\r\n# Another\r\ntext\r\n";
		const result = await createMarkdownlintAdapter({
			config: { MD022: true },
		}).lintText(text, "fixture.md");
		const onHeadingLineFour = result.diagnostics.filter(
			(item) => item.ruleId === "MD022",
		)[1];
		expect(onHeadingLineFour?.location.start.line).toBe(4);
		expect(onHeadingLineFour?.location.range.start).toBe(19);
		expect(text.slice(19, 20)).toBe("#");
	});

	it("attaches a fix edit to fixable diagnostics under CRLF, applying at the right offset", async () => {
		const text = "line1\r\nline   \r\n";
		const adapter = createMarkdownlintAdapter({
			config: { MD009: { br_spaces: 0 } },
		});
		const result = await adapter.fixText(text, "fixture.md");
		const fixable = result.diagnostics.find((item) => item.fix !== undefined);
		expect(fixable).toBeDefined();
		if (fixable?.fix)
			expect(
				text.slice(0, fixable.fix.range.start) +
					fixable.fix.text +
					text.slice(fixable.fix.range.end),
			).toBe(result.output);
	});

	it("splits fixable and non-fixable diagnostics between applied and remaining", async () => {
		const result = await createMarkdownlintAdapter({
			config: { MD009: { br_spaces: 0 }, MD013: { line_length: 5 } },
		}).fixText("line   \nThis line is much too long.\n", "fixture.md");
		expect(result.applied.every((item) => item.fix !== undefined)).toBe(true);
		expect(result.remaining.every((item) => item.fix === undefined)).toBe(true);
		expect(result.remaining.some((item) => item.ruleId === "MD013")).toBe(true);
	});
});
