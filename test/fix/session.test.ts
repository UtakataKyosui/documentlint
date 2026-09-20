import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMarkdownlintAdapter } from "../../src/adapters/markdownlint/adapter.js";
import type { DocumentlintConfig } from "../../src/config/documentlint.js";
import { safeFixDocument } from "../../src/fix/session.js";

const temporary: string[] = [];
afterEach(() => {
	for (const directory of temporary.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

// Chained fix: fixing "foo" -> "bar" only reveals the "bar" -> "baz" opportunity
// on the NEXT round, because a single prh call scans the original text once.
// This is a real multi-round convergence case, not a synthetic one.
const chainedConfig: DocumentlintConfig = {
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
};

// Two rules that permanently flip a word back and forth: a genuine cycle.
const cyclicConfig: DocumentlintConfig = {
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
};

describe("safeFixDocument", () => {
	it("re-analyzes across rounds until every engine converges", async () => {
		const result = await safeFixDocument("foo\n", "fixture.md", chainedConfig);
		expect(result.output).toBe("baz\n");
		expect(result.changed).toBe(true);
		expect(result.stoppedReason).toBe("converged");
		expect(result.iterations.length).toBeGreaterThanOrEqual(2);
		expect(result.diagnostics).toEqual([]);
	});

	it("stops at maxIterations and reports the partially-fixed result", async () => {
		const result = await safeFixDocument(
			"foo\n",
			"fixture.md",
			chainedConfig,
			"documentlint.json",
			{
				maxIterations: 1,
			},
		);
		expect(result.output).toBe("bar\n");
		expect(result.stoppedReason).toBe("max-iterations");
		expect(result.iterations).toHaveLength(1);
		expect(result.diagnostics.some((item) => item.fix?.text === "baz")).toBe(
			true,
		);
	});

	it("detects a cycle between mutually undoing fixes and stops instead of looping forever", async () => {
		const result = await safeFixDocument(
			"foo\n",
			"fixture.md",
			cyclicConfig,
			"documentlint.json",
			{
				maxIterations: 50,
			},
		);
		expect(result.stoppedReason).toBe("cycle-detected");
		expect(result.iterations.length).toBeLessThan(50);
	});

	it("stops immediately (converged) when a round's fixes are all deferred as conflicts", async () => {
		const configDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), "documentlint-session-conflict-"),
		);
		temporary.push(configDirectory);
		fs.writeFileSync(
			path.join(configDirectory, "terms.yml"),
			"version: 1\nrules:\n  - expected: HELLO\n    pattern: hello\n",
		);
		const config: DocumentlintConfig = {
			version: 1,
			prh: {
				dictionary: {
					version: 1,
					rules: [{ expected: "Hello", pattern: "hello" }],
				},
				dictionaries: ["terms.yml"],
			},
		};
		const result = await safeFixDocument(
			"hello world\n",
			"fixture.md",
			config,
			path.join(configDirectory, "documentlint.json"),
		);
		expect(result.stoppedReason).toBe("converged");
		expect(result.changed).toBe(false);
		expect(result.conflicts).toHaveLength(1);
		expect(result.diagnostics).toHaveLength(2);
	});

	it("rejects a non-positive maxIterations instead of looping zero times silently", async () => {
		await expect(
			safeFixDocument(
				"foo\n",
				"fixture.md",
				chainedConfig,
				"documentlint.json",
				{
					maxIterations: 0,
				},
			),
		).rejects.toThrow("maxIterations");
	});

	it("rejects a non-integer maxIterations (fractional, NaN, or infinite) instead of silently misreporting convergence", async () => {
		// Regression for the minor-5 review finding: the old check was only
		// `maxIterations < 1`. A fraction like 1.5 passed it and ran exactly one
		// round, reporting "converged" even with diagnostics still outstanding;
		// NaN also passed it (every comparison against NaN is false), but then
		// made the loop's own `round <= maxIterations` false too, so it ran
		// zero rounds while `stoppedReason` kept its "converged" default;
		// Infinity passed it and removed the round cap entirely.
		for (const invalid of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(
				safeFixDocument(
					"foo\n",
					"fixture.md",
					chainedConfig,
					"documentlint.json",
					{
						maxIterations: invalid,
					},
				),
			).rejects.toThrow("maxIterations");
		}
	});

	it("is idempotent: re-running on the converged output changes nothing and takes one round", async () => {
		const first = await safeFixDocument("foo\n", "fixture.md", chainedConfig);
		const second = await safeFixDocument(
			first.output,
			"fixture.md",
			chainedConfig,
		);
		expect(second.changed).toBe(false);
		expect(second.output).toBe(first.output);
		expect(second.iterations).toHaveLength(1);
	});

	it("converges to markdownlint's own multi-error fix result across rounds, even when a single round under-applies", async () => {
		// A single round derives each markdownlint diagnostic's edit in
		// isolation (see the markdownlint adapter), so two structurally
		// different "delete this blank line" fixes that happen to compute an
		// identical range/text pair collapse into one application per round
		// instead of markdownlint's own N-at-once apply. Re-analysis recovers
		// the full fix over more rounds instead of silently under-fixing.
		const text = "# Heading\n\n\n\ntext\n## Another\ntext\n";
		const markdownlintConfig = { MD012: true, MD022: true };
		const direct = await createMarkdownlintAdapter({
			config: markdownlintConfig,
		}).fixText(text, "f.md");
		const session = await safeFixDocument(text, "f.md", {
			version: 1,
			markdownlint: { config: markdownlintConfig },
		});
		expect(session.output).toBe(direct.output);
		expect(session.diagnostics).toEqual([]);
	});
});
