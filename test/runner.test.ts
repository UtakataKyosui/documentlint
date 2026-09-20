import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDocumentlint } from "../src/runner.js";

const temporary: string[] = [];
afterEach(() => {
	for (const directory of temporary.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

describe("documentlint runner", () => {
	it("runs markdownlint and prh together without suppressing either engine", async () => {
		const result = await runDocumentlint(
			"# Heading\ntext\n\njavascript\n",
			"fixture.md",
			{
				version: 1,
				markdownlint: { config: { MD022: true } },
				prh: {
					dictionary: {
						version: 1,
						rules: [{ expected: "JavaScript", pattern: "javascript" }],
					},
				},
			},
		);
		expect(result.diagnostics.map((item) => item.engine)).toEqual([
			"markdownlint",
			"prh",
		]);
		expect(result.errors).toEqual([]);
	});

	it("resolves external dictionaries from the documentlint config directory", async () => {
		const configDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-runner-config-"),
		);
		const documentDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-runner-document-"),
		);
		temporary.push(configDirectory, documentDirectory);
		const configPath = path.join(configDirectory, "documentlint.json");
		fs.writeFileSync(
			path.join(configDirectory, "terms.yml"),
			"version: 1\nrules:\n  - expected: JavaScript\n    pattern: javascript\n",
		);

		const result = await runDocumentlint(
			"javascript\n",
			path.join(documentDirectory, "guide.md"),
			{ version: 1, prh: { dictionaries: ["terms.yml"] } },
			false,
			configPath,
		);

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]?.engine).toBe("prh");
	});

	it("runs position-preserving syntax and check plugins from the config directory", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-runner-plugin-"),
		);
		temporary.push(directory);
		const configPath = path.join(directory, ".textlintrc.json");
		fs.writeFileSync(
			path.join(directory, "syntax.mjs"),
			`export default {
				apiVersion: 1,
				preprocess({ text }) { return text.replace(":::note", "       "); },
				markdownItPlugin() {}
			};`,
		);
		fs.writeFileSync(
			path.join(directory, "check.mjs"),
			`export default (options) => ({
				apiVersion: 1,
				lint({ source, text }) {
					if (text.includes(":::note")) throw new Error("syntax plugin did not run");
					const start = source.indexOf(options.word);
					return [{ ruleId: "forbidden-word", message: "Avoid it", range: { start, end: start + options.word.length } }];
				}
			});`,
		);

		const result = await runDocumentlint(
			":::note\nbad\n",
			path.join(directory, "article.md"),
			{
				version: 1,
				markdownlint: { config: { MD041: false } },
				extensionPlugins: {
					syntax: { "./syntax.mjs": true },
					checks: { "./check.mjs": { word: "bad" } },
				},
			},
			false,
			configPath,
		);

		expect(result.errors).toEqual([]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				engine: "plugin:./check.mjs",
				ruleId: "forbidden-word",
				location: expect.objectContaining({ range: { start: 8, end: 11 } }),
			}),
		);
	});

	it("rejects syntax preprocessors that invalidate source locations", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-runner-invalid-plugin-"),
		);
		temporary.push(directory);
		fs.writeFileSync(
			path.join(directory, "invalid.mjs"),
			'export default { apiVersion: 1, preprocess({ text }) { return text + "x"; } };',
		);
		await expect(
			runDocumentlint(
				"text\n",
				path.join(directory, "article.md"),
				{
					version: 1,
					extensionPlugins: { syntax: { "./invalid.mjs": true } },
				},
				false,
				path.join(directory, ".textlintrc.json"),
			),
		).rejects.toThrow("must preserve source length");
	});

	it("rejects a plugin placed in an incompatible extension category", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-runner-category-plugin-"),
		);
		temporary.push(directory);
		fs.writeFileSync(
			path.join(directory, "check-only.mjs"),
			"export default { apiVersion: 1, lint() { return []; } };",
		);
		await expect(
			runDocumentlint(
				"text\n",
				path.join(directory, "article.md"),
				{
					version: 1,
					extensionPlugins: { syntax: { "./check-only.mjs": true } },
				},
				false,
				path.join(directory, ".textlintrc.json"),
			),
		).rejects.toThrow("markdown.syntax plugin");
	});

	it("never overwrites masked-but-untouched regions (frontmatter, fenced code) when fixing", async () => {
		const text = "# Title\n\n```js\nconst x = 1;\n```\n\njavascript is great\n";
		const result = await runDocumentlint(
			text,
			"fixture.md",
			{
				version: 1,
				zenn: { enabled: true },
				prh: {
					dictionary: {
						version: 1,
						rules: [{ expected: "JavaScript", pattern: "javascript" }],
					},
				},
			},
			true,
		);
		expect(result.output).toBe(
			"# Title\n\n```js\nconst x = 1;\n```\n\nJavaScript is great\n",
		);
	});

	it("does not let a markdownlint fix land inside a Zenn-masked fenced code block just because the exact bytes it touches happen to match", async () => {
		// Regression for the major-1 review finding: two consecutive blank lines
		// inside a fenced code block get masked to two blank lines too (masking
		// only blanks out non-newline characters), so MD012 fires on masked
		// content it never should have seen. The fix it proposes deletes a lone
		// newline, which reads identically in `text` and `input` (newlines are
		// never masked), so a naive "does the touched slice still match"
		// string-equality guard does not catch it -- only checking the fix's
		// range against the mask's own recorded [start, end) span does.
		const text = "```txt\na\n\n\nb\n```\ntext\n";
		const result = await runDocumentlint(
			text,
			"fixture.md",
			{
				version: 1,
				zenn: { enabled: true },
				markdownlint: { config: { default: false, MD012: true } },
			},
			true,
		);
		expect(result.output).toBe(text);
	});

	// The zero-length-insertion half of the same bug (an insertion range has
	// start === end, so slice(p, p) === slice(p, p) trivially holds no matter
	// where it lands) is exercised directly against isRangeMasked in
	// test/zenn/mask.test.ts rather than here: neither bundled engine's own
	// fix-normalization step happens to preserve a genuinely zero-length
	// range once it survives a round trip through a masked region, so a
	// realistic end-to-end reproduction of only that half is impractical --
	// the guard code path is shared with the case above regardless.

	it("detects and reports a cross-engine fix conflict instead of silently picking one", async () => {
		const configDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-runner-conflict-"),
		);
		temporary.push(configDirectory);
		const configPath = path.join(configDirectory, "documentlint.json");
		fs.writeFileSync(
			path.join(configDirectory, "terms.yml"),
			"version: 1\nrules:\n  - expected: HELLO\n    pattern: hello\n",
		);
		// Two independently configured prh sources both propose a fix for the
		// same word, with different replacements: a genuine cross-engine (here,
		// cross-dictionary) conflict, not just two engines racing on the same
		// `output` field.
		const result = await runDocumentlint(
			"hello world\n",
			"fixture.md",
			{
				version: 1,
				prh: {
					dictionary: {
						version: 1,
						rules: [{ expected: "Hello", pattern: "hello" }],
					},
					dictionaries: ["terms.yml"],
				},
			},
			true,
			configPath,
		);
		expect(result.output).toBe("hello world\n");
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]?.kind).toBe("conflicting");
		expect(
			result.conflicts[0]?.diagnostics.map((item) => item.fix?.text).sort(),
		).toEqual(["HELLO", "Hello"]);
		expect(result.diagnostics.some((item) => item.fix?.text === "Hello")).toBe(
			true,
		);
		expect(result.diagnostics.some((item) => item.fix?.text === "HELLO")).toBe(
			true,
		);
	});

	it("leaves suggestion-only diagnostics untouched by --fix and keeps reporting them", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-runner-suggestion-"),
		);
		temporary.push(directory);
		const configPath = path.join(directory, ".textlintrc.json");
		fs.writeFileSync(
			path.join(directory, "suggest-only.mjs"),
			`export default {
				apiVersion: 1,
				lint({ text }) {
					const start = text.indexOf("bad");
					if (start === -1) return [];
					return [{ ruleId: "no-bad", message: "avoid bad", range: { start, end: start + 3 } }];
				}
			};`,
		);
		const result = await runDocumentlint(
			"this is bad text\n",
			path.join(directory, "article.md"),
			{
				version: 1,
				extensionPlugins: { checks: { "./suggest-only.mjs": true } },
			},
			true,
			configPath,
		);
		expect(result.output).toBe("this is bad text\n");
		expect(result.diagnostics.some((item) => item.ruleId === "no-bad")).toBe(
			true,
		);
	});

	it("is idempotent: fixing an already-fixed document makes no further changes", async () => {
		const config = {
			version: 1 as const,
			prh: {
				dictionary: {
					version: 1,
					rules: [{ expected: "JavaScript", pattern: "javascript" }],
				},
			},
		};
		const first = await runDocumentlint(
			"javascript is great\n",
			"fixture.md",
			config,
			true,
		);
		const second = await runDocumentlint(
			first.output,
			"fixture.md",
			config,
			true,
		);
		expect(second.output).toBe(first.output);
		expect(second.applied).toEqual([]);
	});

	it("applies a fix at the correct offset when an astral character precedes the fix site", async () => {
		// FixEdit ranges are UTF-16 code units; a two-unit emoji before the fix
		// site is exactly what naive offset math (or a boundary that splits the
		// surrogate pair) would get wrong.
		const config = {
			version: 1 as const,
			prh: {
				dictionary: {
					version: 1,
					rules: [{ expected: "JavaScript", pattern: "javascript" }],
				},
			},
		};
		const result = await runDocumentlint(
			"\u{1F389} javascript is great\n",
			"fixture.md",
			config,
			true,
		);
		expect(result.output).toBe("\u{1F389} JavaScript is great\n");
	});

	it("preserves CRLF line endings through a fix pass", async () => {
		const config = {
			version: 1 as const,
			prh: {
				dictionary: {
					version: 1,
					rules: [{ expected: "JavaScript", pattern: "javascript" }],
				},
			},
		};
		const result = await runDocumentlint(
			"# Title\r\n\r\njavascript is great\r\n",
			"fixture.md",
			config,
			true,
		);
		expect(result.output).toBe("# Title\r\n\r\nJavaScript is great\r\n");
		expect(result.output).not.toMatch(/[^\r]\n/);
	});
});
