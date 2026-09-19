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
});
