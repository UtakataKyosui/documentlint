import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	findEscalationTrigger,
	listVcsChangedPaths,
	selectExplicitFiles,
	selectVcsFiles,
	TargetSelectionError,
} from "../../src/cli/target-selection.js";

const temporary: string[] = [];
afterEach(() => {
	for (const directory of temporary.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temporary.push(dir);
	return dir;
}

function writeFile(dir: string, name: string, content: string): string {
	const filePath = path.join(dir, name);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	return filePath;
}

function initGitRepo(): string {
	const dir = tempDir("documentlint-git-");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: dir,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
	return dir;
}

function commitAll(dir: string, message: string): void {
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

function names(files: readonly string[]): string[] {
	return files.map((file) => path.basename(file)).sort();
}

function isJjAvailable(): boolean {
	try {
		execFileSync("jj", ["--version"]);
		return true;
	} catch {
		return false;
	}
}
const jjAvailable = isJjAvailable();

const QUIET: { stdio: ["ignore", "ignore", "ignore"] } = {
	stdio: ["ignore", "ignore", "ignore"],
};

function initJjRepo(): string {
	const dir = tempDir("documentlint-jj-");
	execFileSync("jj", ["git", "init"], { cwd: dir, ...QUIET });
	return dir;
}

function jjCommit(dir: string, message: string): void {
	execFileSync("jj", ["commit", "-m", message], { cwd: dir, ...QUIET });
}

function jjBookmark(dir: string, bookmark: string, revision: string): void {
	execFileSync("jj", ["bookmark", "create", bookmark, "-r", revision], {
		cwd: dir,
		...QUIET,
	});
}

describe("selectExplicitFiles (explicit / --all mode)", () => {
	it("expands an explicit directory recursively to Markdown files", async () => {
		const dir = tempDir("documentlint-explicit-directory-");
		writeFile(dir, "docs/nested/article.md", "# ok\n");
		writeFile(dir, "docs/nested/notes.txt", "not selected\n");

		const files = await selectExplicitFiles(["docs"], [], dir);

		expect(files).toEqual(["docs/nested/article.md"]);
	});

	it("matches the given patterns and excludes node_modules without the caller listing it", async () => {
		const dir = tempDir("documentlint-explicit-");
		writeFile(dir, "article.md", "# ok\n");
		writeFile(dir, "node_modules/dep/readme.md", "# dep\n");

		const files = await selectExplicitFiles(["**/*.md"], [], dir);

		expect(files).toEqual(["article.md"]);
	});

	it("still applies the caller's own ignores on top of the default ones", async () => {
		const dir = tempDir("documentlint-explicit-ignore-");
		writeFile(dir, "article.md", "# ok\n");
		writeFile(dir, "generated/skip.md", "# skip\n");

		const files = await selectExplicitFiles(
			["**/*.md"],
			["generated/**"],
			dir,
		);

		expect(files).toEqual(["article.md"]);
	});
});

describe("Git selection", () => {
	it("throws a clear error outside a Git repository", () => {
		const dir = tempDir("documentlint-no-git-");

		expect(() =>
			listVcsChangedPaths({ source: "git", scope: { kind: "changed" } }, dir),
		).toThrow(TargetSelectionError);
	});

	it("--git-staged selects only files staged in the index, drops deletions, and follows a rename to its new path", () => {
		const dir = initGitRepo();
		writeFile(dir, "modified.md", "before\n");
		writeFile(dir, "to delete.md", "bye\n");
		writeFile(
			dir,
			"original name.md",
			"line1\nline2\nline3\nline4\nline5\n",
		);
		commitAll(dir, "init");

		fs.writeFileSync(path.join(dir, "modified.md"), "after\n");
		fs.rmSync(path.join(dir, "to delete.md"));
		fs.renameSync(
			path.join(dir, "original name.md"),
			path.join(dir, "renamed 日本語 name.md"),
		);
		writeFile(dir, "new untracked.md", "new\n");
		// Only staged content should be selected; leave "unstaged.md" behind
		// to prove it is excluded by --git-staged.
		writeFile(dir, "unstaged.md", "should not be selected\n");
		execFileSync("git", ["add", "-A", "--", ".", ":!unstaged.md"], {
			cwd: dir,
		});

		const files = listVcsChangedPaths(
			{ source: "git", scope: { kind: "staged" } },
			dir,
		);

		expect(names(files)).toEqual(
			["modified.md", "new untracked.md", "renamed 日本語 name.md"].sort(),
		);
	});

	it("--git-staged works before the first commit exists, diffing against the empty tree", () => {
		const dir = initGitRepo();
		writeFile(dir, "article.md", "content\n");
		execFileSync("git", ["add", "-A"], { cwd: dir });

		const files = listVcsChangedPaths(
			{ source: "git", scope: { kind: "staged" } },
			dir,
		);

		expect(names(files)).toEqual(["article.md"]);
	});

	it("--git-changed selects staged, unstaged, and untracked changes together, and still drops deletions", () => {
		const dir = initGitRepo();
		writeFile(dir, "staged.md", "before\n");
		writeFile(dir, "unstaged.md", "before\n");
		writeFile(dir, "gone.md", "bye\n");
		commitAll(dir, "init");

		fs.writeFileSync(path.join(dir, "staged.md"), "after\n");
		execFileSync("git", ["add", "staged.md"], { cwd: dir });
		fs.writeFileSync(path.join(dir, "unstaged.md"), "after\n");
		fs.rmSync(path.join(dir, "gone.md"));
		writeFile(dir, "untracked with spaces.md", "new\n");
		writeFile(dir, "weird\nname.md", "newline in the filename itself\n");

		const files = listVcsChangedPaths(
			{ source: "git", scope: { kind: "changed" } },
			dir,
		);

		expect(names(files)).toEqual(
			[
				"staged.md",
				"unstaged.md",
				"untracked with spaces.md",
				"weird\nname.md",
			].sort(),
		);
	});

	it("reports a file with both a staged and an unstaged edit exactly once", () => {
		const dir = initGitRepo();
		writeFile(dir, "both.md", "v1\n");
		commitAll(dir, "init");
		fs.writeFileSync(path.join(dir, "both.md"), "v2\n");
		execFileSync("git", ["add", "both.md"], { cwd: dir });
		fs.writeFileSync(path.join(dir, "both.md"), "v3\n");

		const files = listVcsChangedPaths(
			{ source: "git", scope: { kind: "changed" } },
			dir,
		);

		expect(names(files)).toEqual(["both.md"]);
	});

	it("handles a filename containing shell metacharacters as a literal path, never as a shell fragment", () => {
		const dir = initGitRepo();
		writeFile(dir, "base.md", "base\n");
		commitAll(dir, "init");
		const dangerousName = "$(echo pwned) & `rm -rf` ; injected.md";
		writeFile(dir, dangerousName, "content\n");

		const files = listVcsChangedPaths(
			{ source: "git", scope: { kind: "changed" } },
			dir,
		);

		expect(names(files)).toEqual([dangerousName]);
	});

	it("--git-since selects everything changed since the merge-base with a diverged revision, including uncommitted work, but not commits made only on the other side after the fork", () => {
		const dir = initGitRepo();
		writeFile(dir, "shared.md", "v1\n");
		commitAll(dir, "init");
		const forkPoint = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: dir,
		})
			.toString("utf8")
			.trim();

		// An independent commit on the "other" revision, made directly on
		// top of the fork point.
		execFileSync("git", ["checkout", "--detach", forkPoint, "-q"], {
			cwd: dir,
		});
		writeFile(dir, "unrelated.md", "unrelated\n");
		commitAll(dir, "unrelated work");
		const otherRev = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: dir,
		})
			.toString("utf8")
			.trim();

		// Our own line of work, also starting at the fork point.
		execFileSync("git", ["checkout", "--detach", forkPoint, "-q"], {
			cwd: dir,
		});
		writeFile(dir, "feature.md", "feature\n");
		commitAll(dir, "feature work");
		writeFile(dir, "wip.md", "uncommitted\n");

		const files = listVcsChangedPaths(
			{ source: "git", scope: { kind: "since", rev: otherRev } },
			dir,
		);

		// feature.md (committed since the fork) and wip.md (uncommitted) are
		// both "changed since otherRev"; unrelated.md only ever existed on
		// the other side of the fork and must not appear.
		expect(names(files)).toEqual(["feature.md", "wip.md"].sort());
	});

	it("--git-since requires an existing commit to compare against", () => {
		const dir = initGitRepo();
		writeFile(dir, "article.md", "content\n");

		expect(() =>
			listVcsChangedPaths(
				{ source: "git", scope: { kind: "since", rev: "HEAD" } },
				dir,
			),
		).toThrow(TargetSelectionError);
	});

	it("--git-since surfaces a clear error for an unresolvable revision", () => {
		const dir = initGitRepo();
		writeFile(dir, "article.md", "content\n");
		commitAll(dir, "init");

		expect(() =>
			listVcsChangedPaths(
				{ source: "git", scope: { kind: "since", rev: "no-such-revision" } },
				dir,
			),
		).toThrow(TargetSelectionError);
	});
});

describe("selectVcsFiles (Git/jj diff intersected with the configured file patterns)", () => {
	it("excludes node_modules by default even for a file Git reports as changed", async () => {
		const dir = initGitRepo();
		writeFile(dir, "base.md", "base\n");
		commitAll(dir, "init");
		writeFile(dir, "node_modules/pkg/readme.md", "# dep\n");
		writeFile(dir, "article.md", "# doc\n");

		const result = await selectVcsFiles(
			{ source: "git", scope: { kind: "changed" } },
			["**/*.md"],
			[],
			dir,
		);

		expect(names(result.files)).toEqual(["article.md"]);
	});

	it("restricts `files` to the configured file patterns while keeping every changed path in `changedPaths` for escalation checks", async () => {
		const dir = initGitRepo();
		writeFile(dir, "base.md", "base\n");
		commitAll(dir, "init");
		writeFile(dir, "article.md", "# doc\n");
		writeFile(dir, "config.ts", "export {};\n");

		const result = await selectVcsFiles(
			{ source: "git", scope: { kind: "changed" } },
			["**/*.md"],
			[],
			dir,
		);

		expect(names(result.files)).toEqual(["article.md"]);
		expect(names(result.changedPaths)).toEqual(
			["article.md", "config.ts"].sort(),
		);
	});

	it("returns no files, without throwing, when nothing changed", async () => {
		const dir = initGitRepo();
		writeFile(dir, "base.md", "base\n");
		commitAll(dir, "init");

		const result = await selectVcsFiles(
			{ source: "git", scope: { kind: "changed" } },
			["**/*.md"],
			[],
			dir,
		);

		expect(result.files).toEqual([]);
		expect(result.changedPaths).toEqual([]);
	});
});

describe("findEscalationTrigger", () => {
	it("matches an existing trigger path against the changed set, ignoring trigger paths that do not exist", () => {
		const dir = tempDir("documentlint-escalation-");
		const configPath = writeFile(dir, "documentlint.json", "{}");
		const article = writeFile(dir, "article.md", "# x\n");
		const missingLockfile = path.join(dir, "pnpm-lock.yaml");

		const trigger = findEscalationTrigger(
			[configPath, article],
			[missingLockfile, configPath],
		);

		expect(trigger).toBe(configPath);
	});

	it("returns undefined when no changed path matches a trigger", () => {
		const dir = tempDir("documentlint-escalation-none-");
		const configPath = writeFile(dir, "documentlint.json", "{}");
		const article = writeFile(dir, "article.md", "# x\n");

		expect(findEscalationTrigger([article], [configPath])).toBeUndefined();
	});
});

describe.skipIf(!jjAvailable)("jj selection", () => {
	it("throws a clear error outside a jj repository", () => {
		const dir = tempDir("documentlint-no-jj-");

		expect(() =>
			listVcsChangedPaths(
				{ source: "jj", scope: { kind: "revision", rev: "@" } },
				dir,
			),
		).toThrow(TargetSelectionError);
	});

	it("includes an untracked file automatically, since jj snapshots the whole working copy into @", () => {
		const dir = initJjRepo();
		writeFile(dir, "base.md", "base\n");
		jjCommit(dir, "init");
		writeFile(dir, "untracked 日本語.md", "new\n");

		const files = listVcsChangedPaths(
			{ source: "jj", scope: { kind: "revision", rev: "@" } },
			dir,
		);

		expect(names(files)).toEqual(["untracked 日本語.md"]);
	});

	it("--jj-revision selects only the files changed within that single revision; --jj-since accumulates from a base revision to the current working copy", () => {
		const dir = initJjRepo();
		writeFile(dir, "base.md", "base\n");
		jjCommit(dir, "init");
		jjBookmark(dir, "base", "@-");

		writeFile(dir, "feature.md", "feature\n");
		jjCommit(dir, "second");
		jjBookmark(dir, "after-second", "@-");

		writeFile(dir, "wip.md", "uncommitted\n");

		const revisionFiles = listVcsChangedPaths(
			{ source: "jj", scope: { kind: "revision", rev: "after-second" } },
			dir,
		);
		expect(names(revisionFiles)).toEqual(["feature.md"]);

		const sinceFiles = listVcsChangedPaths(
			{ source: "jj", scope: { kind: "since", rev: "base" } },
			dir,
		);
		expect(names(sinceFiles)).toEqual(["feature.md", "wip.md"].sort());
	});

	it("surfaces a clear error for an unresolvable revision", () => {
		const dir = initJjRepo();
		writeFile(dir, "base.md", "base\n");
		jjCommit(dir, "init");

		expect(() =>
			listVcsChangedPaths(
				{ source: "jj", scope: { kind: "revision", rev: "no-such-rev" } },
				dir,
			),
		).toThrow(TargetSelectionError);
	});
});
