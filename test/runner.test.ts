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
});
