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
});
