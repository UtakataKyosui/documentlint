import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DocumentlintConfigError,
	documentlintConfigSchema,
	importLegacyConfig,
	parseDocumentlintConfig,
} from "../../src/config/documentlint.js";

const temporary: string[] = [];
afterEach(() => {
	for (const directory of temporary.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});
function fixture(name: string, content: string): string {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "documentlint-config-"),
	);
	temporary.push(directory);
	const file = path.join(directory, name);
	fs.writeFileSync(file, content);
	return file;
}

describe("documentlint config", () => {
	it("exports the packaged schema as its single programmatic schema", () => {
		const schemaPath = path.resolve("schema/documentlint.schema.json");
		expect(documentlintConfigSchema).toEqual(
			JSON.parse(fs.readFileSync(schemaPath, "utf8")),
		);
		expect(documentlintConfigSchema).toMatchObject({
			$id: "https://documentlint.dev/schema.json",
			$defs: { plugins: { type: "object" } },
		});
	});

	it("continues to accept a plain textlintrc without an extension block", () => {
		expect(
			parseDocumentlintConfig('{"rules":{"no-todo":true}}', ".textlintrc.json"),
		).toMatchObject({
			version: 1,
			textlint: { rules: { "no-todo": true } },
		});
	});

	it("parses a textlintrc-compatible root and normalizes documentlint extensions", () => {
		const parsed = parseDocumentlintConfig(`{
			"rules": { "no-todo": true },
			"filters": { "comments": true },
			"plugins": { "markdown": true },
			"documentlint": {
				"version": 1,
				"files": ["articles/**/*.md"],
				"prh": { "dictionaries": ["./prh.yml"] },
				"markdown": {
					"syntax": {
						"zenn": true,
						"markdownItPlugins": ["markdown-it-footnote"],
						"plugins": { "./syntax.mjs": { "dialect": "zenn" } }
					},
					"checks": {
						"markdownlint": { "MD013": false },
						"plugins": { "heading-policy": true }
					}
				}
			}
		}`);

		expect(parsed).toMatchObject({
			version: 1,
			files: ["articles/**/*.md"],
			textlint: {
				rules: { "no-todo": true },
				filters: { comments: true },
				plugins: { markdown: true },
			},
			prh: { dictionaries: ["./prh.yml"] },
			zenn: { enabled: true },
			markdownlint: {
				config: { MD013: false },
			},
			extensionPlugins: {
				syntax: { "./syntax.mjs": { dialect: "zenn" } },
				checks: { "heading-policy": true },
				markdownIt: ["markdown-it-footnote"],
			},
		});
	});

	it("rejects invalid nested extension settings with a useful location", () => {
		try {
			parseDocumentlintConfig(
				'{\n"documentlint":{"version":1,"markdown":{"syntax":{"plugins":{"bad":42}}}}}',
				".textlintrc.json",
			);
			throw new Error("expected parser to reject invalid settings");
		} catch (error) {
			expect(error).toBeInstanceOf(DocumentlintConfigError);
			expect(error).toMatchObject({ filePath: ".textlintrc.json" });
			expect((error as Error).message).toContain("markdown.syntax.plugins.bad");
		}
	});

	it("parses JSONC and reports a positioned schema suggestion", () => {
		expect(
			parseDocumentlintConfig(
				'{\n // comment\n "version": 1,\n "files": ["**/*.md",],\n}',
			),
		).toMatchObject({ version: 1 });
		expect(() =>
			parseDocumentlintConfig('{"version": 2}', "documentlint.json"),
		).toThrow(DocumentlintConfigError);
	});
	it("converts legacy textlint, markdownlint-cli2 JSONC, and prh YAML without writing source files", () => {
		const textlint = fixture(".textlintrc.json", '{"rules":{"no-todo":true}}');
		const markdownlint = fixture(
			".markdownlint-cli2.jsonc",
			'{// comment\n"globs":["docs/**/*.md"],"config":{"MD013":false},"ignores":["node_modules"]}',
		);
		const prh = fixture(
			"prh.yml",
			"version: 1\nrules:\n  - expected: JavaScript\n    pattern: javascript\n",
		);
		expect(importLegacyConfig(textlint).config?.textlint).toEqual({
			rules: { "no-todo": true },
		});
		expect(importLegacyConfig(markdownlint).config).toMatchObject({
			files: ["docs/**/*.md"],
			markdownlint: { config: { MD013: false } },
		});
		expect(importLegacyConfig(prh).config?.prh?.dictionary).toMatchObject({
			version: 1,
		});
		expect(fs.existsSync(textlint)).toBe(true);
	});
});
