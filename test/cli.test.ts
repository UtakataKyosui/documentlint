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

	it("--fix writes the resolved file to disk and reports remaining diagnostics", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-fix-"),
		);
		temporary.push(directory);
		const configPath = path.join(directory, "documentlint.json");
		const articlePath = path.join(directory, "article.md");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				prh: {
					dictionary: {
						version: 1,
						rules: [{ expected: "JavaScript", pattern: "javascript" }],
					},
				},
			}),
		);
		fs.writeFileSync(articlePath, "javascript is great\n");

		const exitCode = await main(["--config", configPath, "--fix", articlePath]);

		expect(fs.readFileSync(articlePath, "utf8")).toBe("JavaScript is great\n");
		expect(exitCode).toBe(0);
	});

	it("--dry-run computes the fix and previews it without writing to disk", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-dry-run-"),
		);
		temporary.push(directory);
		const configPath = path.join(directory, "documentlint.json");
		const articlePath = path.join(directory, "article.md");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				prh: {
					dictionary: {
						version: 1,
						rules: [{ expected: "JavaScript", pattern: "javascript" }],
					},
				},
			}),
		);
		fs.writeFileSync(articlePath, "javascript is great\n");
		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output += String(chunk);
			return true;
		});

		const exitCode = await main([
			"--config",
			configPath,
			"--dry-run",
			"--format",
			"json",
			articlePath,
		]);

		expect(fs.readFileSync(articlePath, "utf8")).toBe("javascript is great\n");
		const payload = JSON.parse(output) as {
			results: { changed: boolean; diff?: string }[];
		};
		expect(payload.results[0]?.changed).toBe(true);
		expect(payload.results[0]?.diff).toContain("-javascript is great");
		expect(payload.results[0]?.diff).toContain("+JavaScript is great");
		expect(exitCode).toBe(0);
	});

	it("does not write a file whose fix run reported an engine error", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-fix-error-"),
		);
		temporary.push(directory);
		const configPath = path.join(directory, ".textlintrc.json");
		const articlePath = path.join(directory, "article.md");
		fs.writeFileSync(
			path.join(directory, "throws.mjs"),
			`export default { apiVersion: 1, async lint() { throw new Error("boom"); } };`,
		);
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				documentlint: {
					version: 1,
					markdown: { checks: { plugins: { "./throws.mjs": true } } },
				},
			}),
		);
		const original = "javascript is great\n";
		fs.writeFileSync(articlePath, original);

		const exitCode = await main(["--config", configPath, "--fix", articlePath]);

		expect(fs.readFileSync(articlePath, "utf8")).toBe(original);
		expect(exitCode).toBe(2);
	});

	it("treats a trailing --max-iterations with no value after it as a configuration error, not a silent default", async () => {
		// Regression for the minor-6 review finding: value(flag) returns
		// undefined both when the flag is absent and when it is the last
		// argument with nothing after it, so a trailing "--max-iterations"
		// used to be indistinguishable from never passing the flag at all and
		// silently ran with the default iteration cap instead of erroring.
		await expect(main(["--max-iterations"])).rejects.toThrow(
			"--max-iterations",
		);
	});

	it("reports stoppedReason in JSON output and exits non-zero even when the truncated run leaves no diagnostics", async () => {
		// Regression for issue #8's follow-up: a chained (but terminating) rule
		// pair capped at exactly the round it finishes on reports
		// "max-iterations", because convergence is only detected when a
		// *subsequent* round repeats the previous output -- the capped run
		// never gets that round, even though the settled text has zero
		// diagnostics. This must not be reported as a clean exit 0.
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-stopped-reason-"),
		);
		temporary.push(directory);
		const configPath = path.join(directory, "documentlint.json");
		const articlePath = path.join(directory, "article.md");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				prh: {
					dictionary: {
						version: 1,
						rules: [
							{ expected: "bar", pattern: "foo" },
							{ expected: "baz", pattern: "bar" },
						],
					},
				},
			}),
		);
		fs.writeFileSync(articlePath, "foo\n");
		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output += String(chunk);
			return true;
		});

		const exitCode = await main([
			"--config",
			configPath,
			"--dry-run",
			"--format",
			"json",
			"--max-iterations",
			"2",
			articlePath,
		]);

		const payload = JSON.parse(output) as {
			results: { stoppedReason?: string; diagnostics: unknown[] }[];
		};
		expect(payload.results[0]?.stoppedReason).toBe("max-iterations");
		expect(payload.results[0]?.diagnostics).toEqual([]);
		expect(exitCode).toBe(1);
	});

	it("does not report stoppedReason for a plain lint run (no --fix)", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-no-fix-"),
		);
		temporary.push(directory);
		const configPath = path.join(directory, "documentlint.json");
		const articlePath = path.join(directory, "article.md");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				prh: {
					dictionary: {
						version: 1,
						rules: [{ expected: "JavaScript", pattern: "javascript" }],
					},
				},
			}),
		);
		fs.writeFileSync(articlePath, "javascript is great\n");
		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output += String(chunk);
			return true;
		});

		await main(["--config", configPath, "--format", "json", articlePath]);

		const payload = JSON.parse(output) as {
			results: { stoppedReason?: string }[];
		};
		expect(payload.results[0]?.stoppedReason).toBeUndefined();
	});

	it("warns on stderr in human format when a fix run stops without converging (max-iterations)", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-warn-max-iterations-"),
		);
		temporary.push(directory);
		const configPath = path.join(directory, "documentlint.json");
		const articlePath = path.join(directory, "article.md");
		// A self-recursive rule: replacing "サーバ" with "サーバー" leaves a new
		// "サーバ" match inside the result, so it never converges.
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				prh: {
					dictionary: {
						version: 1,
						rules: [{ expected: "サーバー", pattern: "サーバ" }],
					},
				},
			}),
		);
		fs.writeFileSync(articlePath, "サーバの設定\n");
		let stdout = "";
		let stderr = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdout += String(chunk);
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderr += String(chunk);
			return true;
		});

		const exitCode = await main([
			"--config",
			configPath,
			"--dry-run",
			"--max-iterations",
			"3",
			articlePath,
		]);

		expect(stderr).toContain("stopped after 3 fix rounds without converging");
		expect(stderr).toContain(articlePath);
		expect(stdout).not.toContain("stopped after");
		expect(exitCode).toBe(1);
	});

	it("warns on stderr in human format with cycle-specific wording when a fix run stops on a detected cycle", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-warn-cycle-"),
		);
		temporary.push(directory);
		const configPath = path.join(directory, "documentlint.json");
		const articlePath = path.join(directory, "article.md");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				prh: {
					dictionary: {
						version: 1,
						rules: [
							{ expected: "bar", pattern: "foo" },
							{ expected: "foo", pattern: "bar" },
						],
					},
				},
			}),
		);
		fs.writeFileSync(articlePath, "foo\n");
		let stderr = "";
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderr += String(chunk);
			return true;
		});

		const exitCode = await main([
			"--config",
			configPath,
			"--dry-run",
			"--max-iterations",
			"50",
			articlePath,
		]);

		expect(stderr).toContain("cycle");
		expect(stderr).not.toContain("without converging");
		expect(exitCode).toBe(1);
	});

	it("does not warn on stderr when a fix run converges", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-no-warn-converged-"),
		);
		temporary.push(directory);
		const configPath = path.join(directory, "documentlint.json");
		const articlePath = path.join(directory, "article.md");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				prh: {
					dictionary: {
						version: 1,
						rules: [{ expected: "JavaScript", pattern: "javascript" }],
					},
				},
			}),
		);
		fs.writeFileSync(articlePath, "javascript is great\n");
		let stderr = "";
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderr += String(chunk);
			return true;
		});

		const exitCode = await main(["--config", configPath, "--fix", articlePath]);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
	});
});
