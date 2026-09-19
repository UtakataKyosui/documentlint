import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DocumentlintConfigError,
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
