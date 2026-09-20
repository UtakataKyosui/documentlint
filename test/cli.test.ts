import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

const temporary: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of temporary.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

describe("documentlint CLI", () => {
	it("runs all configured engines from an extended textlintrc", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-"),
		);
		temporary.push(directory);
		const configPath = path.join(directory, ".textlintrc.json");
		const articlePath = path.join(directory, "article.md");
		fs.writeFileSync(
			configPath,
			`{
				// JSONC comments and trailing commas are supported.
				"documentlint": {
					"version": 1,
					"prh": { "dictionary": { "version": 1, "rules": [
						{ "expected": "JavaScript", "pattern": "javascript" }
					] } },
					"markdown": { "checks": { "markdownlint": { "MD022": true } } },
				},
			}`,
		);
		fs.writeFileSync(articlePath, "# Heading\njavascript\n");
		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output += String(chunk);
			return true;
		});

		const exitCode = await main([
			"--config",
			configPath,
			"--format",
			"json",
			articlePath,
		]);
		const payload = JSON.parse(output) as {
			results: {
				diagnostics: { engine: string }[];
				errors: { engine: string; message: string }[];
			}[];
		};

		expect(payload.results[0]?.errors).toEqual([]);
		expect(exitCode).toBe(1);
		expect(payload.results[0]?.diagnostics.map((item) => item.engine)).toEqual([
			"markdownlint",
			"prh",
		]);
	});
});
