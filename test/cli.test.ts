import { execFileSync } from "node:child_process";
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
	it("prints the package version without requiring a configuration", async () => {
		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output += String(chunk);
			return true;
		});

		expect(await main(["--version"])).toBe(0);
		expect(output.trim()).toBe("0.0.0");
	});

	it("creates a minimal configuration with --init and refuses to overwrite it", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "documentlint-cli-init-"));
		temporary.push(directory);
		const originalCwd = process.cwd();
		process.chdir(directory);
		try {
			expect(await main(["--init"])).toBe(0);
			expect(JSON.parse(fs.readFileSync(path.join(directory, "documentlint.json"), "utf8"))).toEqual({
				version: 1,
				files: ["**/*.md"],
				markdownlint: { config: { default: true, MD013: false } },
			});
			await expect(main(["--init"])).rejects.toThrow("refusing to overwrite");
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("prints the selected path and effective config without linting", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "documentlint-cli-print-config-"));
		temporary.push(directory);
		const configPath = path.join(directory, "documentlint.json");
		fs.writeFileSync(configPath, JSON.stringify({ version: 1, files: ["docs/**/*.md"] }));
		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output += String(chunk);
			return true;
		});

		expect(await main(["--config", configPath, "--print-config"])).toBe(0);
		const payload = JSON.parse(output) as { path: string; config: { files: string[] } };
		expect(payload.path).toBe(path.resolve(configPath));
		expect(payload.config.files).toEqual(["docs/**/*.md"]);
	});
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

describe("documentlint CLI target selection", () => {
	function initGitRepo(directory: string): void {
		execFileSync("git", ["init", "-q"], { cwd: directory });
		execFileSync("git", ["config", "user.email", "test@example.com"], {
			cwd: directory,
		});
		execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
	}

	function commitAll(directory: string, message: string): void {
		execFileSync("git", ["add", "-A"], { cwd: directory });
		execFileSync("git", ["commit", "-q", "-m", message], { cwd: directory });
	}

	async function runInDirectory(
		directory: string,
		args: string[],
	): Promise<number> {
		const originalCwd = process.cwd();
		process.chdir(directory);
		try {
			return await main(args);
		} finally {
			process.chdir(originalCwd);
		}
	}

	it("rejects combining two target-selection flags", async () => {
		await expect(
			main(["--git-staged", "--jj-revision", "@"]),
		).rejects.toThrow("Only one target-selection mode");
	});

	it("rejects a target-selection flag combined with explicit file arguments", async () => {
		await expect(main(["--git-changed", "article.md"])).rejects.toThrow(
			"Only one target-selection mode",
		);
	});

	it("rejects --stdin combined with a target-selection flag", async () => {
		await expect(
			main(["--stdin", "--git-changed"], "# doc\n"),
		).rejects.toThrow("--stdin cannot be combined");
	});

	it.each(["--git-since", "--jj-revision", "--jj-since"])(
		"treats a trailing %s with no value as a configuration error, not a silent default",
		async (flag) => {
			await expect(main([flag])).rejects.toThrow(`${flag} requires a value`);
		},
	);

	it("--git-staged outside a Git repository fails with a clear error instead of a confusing empty run", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-no-git-"),
		);
		temporary.push(directory);
		const configPath = path.join(directory, "documentlint.json");
		fs.writeFileSync(configPath, JSON.stringify({ version: 1 }));

		await expect(
			runInDirectory(directory, ["--config", configPath, "--git-staged"]),
		).rejects.toThrow(/not a git repository/i);
	});

	it("--git-changed lints an untracked Markdown file selected from a real Git working tree", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-git-changed-"),
		);
		temporary.push(directory);
		initGitRepo(directory);
		const configPath = path.join(directory, "documentlint.json");
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
		commitAll(directory, "init");
		fs.writeFileSync(
			path.join(directory, "article.md"),
			"javascript is great\n",
		);

		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output += String(chunk);
			return true;
		});

		const exitCode = await runInDirectory(directory, [
			"--config",
			configPath,
			"--format",
			"json",
			"--git-changed",
		]);

		const payload = JSON.parse(output) as {
			results: { filePath: string; diagnostics: unknown[] }[];
		};
		expect(payload.results).toHaveLength(1);
		expect(payload.results[0]?.filePath.endsWith("article.md")).toBe(true);
		expect(payload.results[0]?.diagnostics).not.toEqual([]);
		expect(exitCode).toBe(1);
	});

	it("--git-changed checks the whole changed file, not only its changed lines: a pre-existing violation earlier in the file is still reported", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-git-wholefile-"),
		);
		temporary.push(directory);
		initGitRepo(directory);
		const configPath = path.join(directory, "documentlint.json");
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
		const articlePath = path.join(directory, "article.md");
		// The violation on the first line is already committed; only the
		// second line is part of the uncommitted diff.
		fs.writeFileSync(articlePath, "javascript is great\n");
		commitAll(directory, "init");
		fs.appendFileSync(articlePath, "a second, unrelated line\n");

		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output += String(chunk);
			return true;
		});

		const exitCode = await runInDirectory(directory, [
			"--config",
			configPath,
			"--format",
			"json",
			"--git-changed",
		]);

		const payload = JSON.parse(output) as {
			results: { diagnostics: { ruleId: string }[] }[];
		};
		expect(
			payload.results[0]?.diagnostics.some((item) => item.ruleId === "prh"),
		).toBe(true);
		expect(exitCode).toBe(1);
	});

	it("--git-changed with nothing changed exits 0 and reports there was nothing to check", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-git-empty-"),
		);
		temporary.push(directory);
		initGitRepo(directory);
		const configPath = path.join(directory, "documentlint.json");
		fs.writeFileSync(configPath, JSON.stringify({ version: 1 }));
		fs.writeFileSync(path.join(directory, "article.md"), "# ok\n");
		commitAll(directory, "init");

		let stderrOutput = "";
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderrOutput += String(chunk);
			return true;
		});

		const exitCode = await runInDirectory(directory, [
			"--config",
			configPath,
			"--git-changed",
		]);

		expect(exitCode).toBe(0);
		expect(stderrOutput).toContain("No changed files matched");
	});

	it("running --git-changed while the config file itself changed escalates to a full scan and reports why on stderr", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-escalate-"),
		);
		temporary.push(directory);
		initGitRepo(directory);
		const configPath = path.join(directory, "documentlint.json");
		const dictionary = {
			version: 1,
			rules: [{ expected: "JavaScript", pattern: "javascript" }],
		};
		fs.writeFileSync(
			configPath,
			JSON.stringify({ version: 1, prh: { dictionary } }),
		);
		// Untouched by the uncommitted diff below, but should still be found
		// once the config change escalates the run to a full scan.
		fs.writeFileSync(
			path.join(directory, "other.md"),
			"javascript is great\n",
		);
		commitAll(directory, "init");

		fs.writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				ignores: ["nonexistent/**"],
				prh: { dictionary },
			}),
		);

		let stdoutOutput = "";
		let stderrOutput = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdoutOutput += String(chunk);
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderrOutput += String(chunk);
			return true;
		});

		const exitCode = await runInDirectory(directory, [
			"--config",
			configPath,
			"--format",
			"json",
			"--git-changed",
		]);

		expect(stderrOutput).toContain("documentlint.json");
		expect(stderrOutput).toContain("running a full scan");
		const payload = JSON.parse(stdoutOutput) as {
			results: { filePath: string }[];
			notices?: string[];
		};
		expect(
			payload.results.some((item) => item.filePath.endsWith("other.md")),
		).toBe(true);
		expect(payload.notices?.[0]).toContain("documentlint.json");
		expect(exitCode).toBe(1);
	});

	it("--all forces a full scan with the configured files glob, excluding node_modules by default", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-cli-all-"),
		);
		temporary.push(directory);
		const configPath = path.join(directory, "documentlint.json");
		fs.writeFileSync(configPath, JSON.stringify({ version: 1 }));
		fs.writeFileSync(path.join(directory, "a.md"), "# a\n");
		fs.writeFileSync(path.join(directory, "b.md"), "# b\n");
		fs.mkdirSync(path.join(directory, "node_modules"));
		fs.writeFileSync(path.join(directory, "node_modules", "c.md"), "# c\n");

		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output += String(chunk);
			return true;
		});

		await runInDirectory(directory, [
			"--config",
			configPath,
			"--format",
			"json",
			"--all",
		]);

		const payload = JSON.parse(output) as { results: { filePath: string }[] };
		const basenames = payload.results
			.map((item) => path.basename(item.filePath))
			.sort();
		expect(basenames).toEqual(["a.md", "b.md"]);
	});

	it("resolves configured globs from a parent configuration directory", async () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "documentlint-parent-config-"));
		const child = path.join(parent, "packages", "docs");
		temporary.push(parent);
		fs.mkdirSync(child, { recursive: true });
		const configPath = path.join(parent, "documentlint.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				files: ["packages/docs/**/*.md"],
				prh: { dictionary: { version: 1, rules: [] } },
			}),
		);
		const article = path.join(child, "article.md");
		fs.writeFileSync(article, "# ok\n");

		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output += String(chunk);
			return true;
		});
		const exitCode = await runInDirectory(child, ["--format", "json"]);

		const payload = JSON.parse(output) as { results: { filePath: string }[] };
		expect(payload.results).toHaveLength(1);
		expect(payload.results[0]?.filePath).toBe(fs.realpathSync(article));
		expect(exitCode).toBe(0);
	});

	it("fails when an explicitly selected ignore file does not exist", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "documentlint-missing-ignore-"));
		temporary.push(directory);
		const configPath = path.join(directory, "documentlint.json");
		fs.writeFileSync(configPath, JSON.stringify({ version: 1 }));

		await expect(
			runInDirectory(directory, [
				"--config",
				configPath,
				"--ignore-path",
				"missing.ignore",
			]),
		).rejects.toThrow("Ignore file does not exist");
	});
});
