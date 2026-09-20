import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";

/**
 * Excluded from every selection mode regardless of user configuration, so a
 * full scan (or a Git/jj diff intersected with the full scan, see
 * `selectVcsFiles`) never walks into installed dependencies.
 */
export const DEFAULT_TARGET_IGNORES: readonly string[] = ["**/node_modules/**"];

export type GitDiffScope =
	| { readonly kind: "staged" }
	| { readonly kind: "changed" }
	| { readonly kind: "since"; readonly rev: string };

export type JjDiffScope =
	| { readonly kind: "revision"; readonly rev: string }
	| { readonly kind: "since"; readonly rev: string };

export type VcsSelection =
	| { readonly source: "git"; readonly scope: GitDiffScope }
	| { readonly source: "jj"; readonly scope: JjDiffScope };

export type TargetSelectionMode =
	| { readonly source: "explicit"; readonly patterns: readonly string[] }
	| VcsSelection;

export class TargetSelectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TargetSelectionError";
	}
}

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function run(command: string, args: readonly string[], cwd: string): Buffer {
	try {
		return execFileSync(command, args, {
			cwd,
			maxBuffer: 64 * 1024 * 1024,
			// Sync child_process helpers inherit stderr from the parent by
			// default; piping it keeps a failed lookup (not a repo, bad
			// revision, ...) out of the caller's own stderr and lets the
			// catch block below fold it into a clear TargetSelectionError.
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		if (
			error !== null &&
			typeof error === "object" &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		)
			throw new TargetSelectionError(
				`"${command}" was not found on PATH. Install ${command}, or choose a target-selection mode that does not need it.`,
			);
		const stderr =
			error !== null && typeof error === "object" && "stderr" in error
				? Buffer.isBuffer((error as { stderr: unknown }).stderr)
					? (error as { stderr: Buffer }).stderr.toString("utf8").trim()
					: String((error as { stderr: unknown }).stderr).trim()
				: "";
		throw new TargetSelectionError(
			`${[command, ...args].join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
		);
	}
}

function splitNulTerminated(output: Buffer): string[] {
	if (output.length === 0) return [];
	const fields = output.toString("utf8").split("\0");
	if (fields.at(-1) === "") fields.pop();
	return fields;
}

function gitRepoRoot(cwd: string): string {
	return run("git", ["rev-parse", "--show-toplevel"], cwd)
		.toString("utf8")
		.trim();
}

function hasGitHead(repoRoot: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--verify", "-q", "HEAD"], {
			cwd: repoRoot,
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Parses `git diff --name-status -z`. A rename/copy status ("R100", "C75",
 * ...) is followed by two path fields, old then new; every other status is
 * followed by one. Deletions are dropped because there is no file left to
 * read.
 */
function parseNameStatusZ(output: Buffer, repoRoot: string): string[] {
	const fields = splitNulTerminated(output);
	const files: string[] = [];
	let i = 0;
	while (i < fields.length) {
		const status = fields[i] ?? "";
		const isRenameOrCopy = status.startsWith("R") || status.startsWith("C");
		const relativePath = isRenameOrCopy ? fields[i + 2] : fields[i + 1];
		i += isRenameOrCopy ? 3 : 2;
		if (status.startsWith("D") || relativePath === undefined) continue;
		files.push(path.resolve(repoRoot, relativePath));
	}
	return files;
}

interface PorcelainEntry {
	readonly status: string;
	readonly path: string;
}

/**
 * Parses `git status --porcelain=v1 -z`. Unlike `--name-status`, the
 * two-letter status code and the (new, for renames) path share a single
 * field; a rename/copy's old path follows as a second, unprefixed field.
 */
function parsePorcelainEntries(
	output: Buffer,
	repoRoot: string,
): PorcelainEntry[] {
	const fields = splitNulTerminated(output);
	const entries: PorcelainEntry[] = [];
	let i = 0;
	while (i < fields.length) {
		const field = fields[i] ?? "";
		const status = field.slice(0, 2);
		const relativePath = field.slice(3);
		const isRenameOrCopy = status.startsWith("R") || status.startsWith("C");
		i += isRenameOrCopy ? 2 : 1;
		entries.push({ status, path: path.resolve(repoRoot, relativePath) });
	}
	return entries;
}

function parsePorcelainZ(output: Buffer, repoRoot: string): string[] {
	return parsePorcelainEntries(output, repoRoot)
		.filter((entry) => !entry.status.includes("D"))
		.map((entry) => entry.path);
}

function runStatusPorcelain(repoRoot: string): PorcelainEntry[] {
	return parsePorcelainEntries(
		run(
			"git",
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			repoRoot,
		),
		repoRoot,
	);
}

function listGitFiles(scope: GitDiffScope, cwd: string): string[] {
	const repoRoot = gitRepoRoot(cwd);
	if (scope.kind === "staged") {
		const target = hasGitHead(repoRoot) ? "HEAD" : EMPTY_TREE_SHA;
		return parseNameStatusZ(
			run(
				"git",
				["diff", "--cached", "--find-renames", "--name-status", "-z", target],
				repoRoot,
			),
			repoRoot,
		);
	}
	if (scope.kind === "changed")
		return runStatusPorcelain(repoRoot)
			.filter((entry) => !entry.status.includes("D"))
			.map((entry) => entry.path);
	if (!hasGitHead(repoRoot))
		throw new TargetSelectionError(
			"--git-since requires an existing commit to compare against; this repository has none yet.",
		);
	// Diffing against the merge-base (rather than `rev` itself) means changes
	// made on `rev` after the current branch diverged from it are not
	// reported as "changed here"; diffing a single commit against the
	// working tree (rather than `--cached`) picks up staged and unstaged
	// edits to *tracked* files alike, so "since" covers everything not yet
	// on `rev`. Plain `git diff` never reports untracked files regardless of
	// its arguments, so those are folded in separately from `git status`.
	const mergeBase = run("git", ["merge-base", scope.rev, "HEAD"], repoRoot)
		.toString("utf8")
		.trim();
	const trackedChanges = parseNameStatusZ(
		run(
			"git",
			["diff", "--find-renames", "--name-status", "-z", mergeBase],
			repoRoot,
		),
		repoRoot,
	);
	const untracked = runStatusPorcelain(repoRoot)
		.filter((entry) => entry.status === "??")
		.map((entry) => entry.path);
	return Array.from(new Set([...trackedChanges, ...untracked]));
}

/**
 * `status_char() ++ path.absolute()` is emitted through a `jj diff -T`
 * template because neither `--name-only` nor `--summary` NUL-terminates
 * paths; a path containing a literal newline would otherwise be
 * indistinguishable from a record boundary.
 */
const JJ_NAME_STATUS_TEMPLATE = 'status_char ++ "\\0" ++ path.absolute() ++ "\\0"';

function parseJjDiffZ(output: Buffer): string[] {
	const fields = splitNulTerminated(output);
	const files: string[] = [];
	for (let i = 0; i < fields.length; i += 2) {
		const status = fields[i] ?? "";
		const absolutePath = fields[i + 1];
		if (status === "D" || absolutePath === undefined) continue;
		files.push(absolutePath);
	}
	return files;
}

function listJjFiles(scope: JjDiffScope, cwd: string): string[] {
	const args =
		scope.kind === "revision"
			? ["diff", "-r", scope.rev]
			: ["diff", "--from", scope.rev, "--to", "@"];
	return parseJjDiffZ(
		run(
			"jj",
			[...args, "-T", JJ_NAME_STATUS_TEMPLATE, "--no-pager", "--color=never"],
			cwd,
		),
	);
}

/** Absolute paths of every file a Git/jj diff selection touched, deletions excluded. Not yet filtered by `files`/`ignores`. */
export function listVcsChangedPaths(
	selection: VcsSelection,
	cwd: string,
): readonly string[] {
	return selection.source === "git"
		? listGitFiles(selection.scope, cwd)
		: listJjFiles(selection.scope, cwd);
}

function realpathOrUndefined(candidate: string): string | undefined {
	try {
		return fs.realpathSync(candidate);
	} catch {
		return undefined;
	}
}

/**
 * Selects files for the "all"/explicit-arguments modes: a plain fast-glob
 * run, with `DEFAULT_TARGET_IGNORES` merged ahead of the caller's ignores.
 */
export function selectExplicitFiles(
	patterns: readonly string[],
	ignores: readonly string[],
	cwd?: string,
): Promise<string[]> {
	const base = cwd ?? process.cwd();
	// A directory target is a convenience spelling for its recursive Markdown
	// contents. Other explicit files and glob patterns keep their normal
	// fast-glob semantics.
	const expanded = patterns.map((pattern) => {
		try {
			return fs.statSync(path.resolve(base, pattern)).isDirectory()
				? path.join(pattern, "**/*.md")
				: pattern;
		} catch {
			return pattern;
		}
	});
	return fg(expanded, {
		ignore: [...DEFAULT_TARGET_IGNORES, ...ignores],
		onlyFiles: true,
		...(cwd !== undefined ? { cwd } : {}),
	});
}

export interface SelectVcsFilesResult {
	/** Every changed path the VCS reported, deletions excluded, before intersecting with `filePatterns`. Used to decide whether a config/dictionary/dependency change should escalate to a full scan. */
	readonly changedPaths: readonly string[];
	/** `changedPaths` narrowed to files that a full scan with `filePatterns`/`ignores` would also select, resolved to real (symlink-free) absolute paths and de-duplicated. */
	readonly files: readonly string[];
}

/**
 * A changed path is only lintable if it both came out of the VCS diff and
 * would be picked up by an ordinary full scan (matches `filePatterns`, does
 * not match `ignores`/`DEFAULT_TARGET_IGNORES`, still exists as a file). The
 * intersection is computed by realpath-comparing against one full-scan glob
 * rather than glob-matching each candidate individually: Git and jj resolve
 * symlinks in the absolute paths they report (e.g. macOS's `/tmp` ->
 * `/private/tmp`) while `process.cwd()`-based paths may not, so a raw string
 * comparison silently drops every result on such platforms.
 */
export async function selectVcsFiles(
	selection: VcsSelection,
	filePatterns: readonly string[],
	ignores: readonly string[],
	cwd?: string,
): Promise<SelectVcsFilesResult> {
	const resolvedCwd = cwd ?? process.cwd();
	const changedPaths = listVcsChangedPaths(selection, resolvedCwd);
	if (changedPaths.length === 0) return { changedPaths, files: [] };

	const fullScan = await fg([...filePatterns], {
		ignore: [...DEFAULT_TARGET_IGNORES, ...ignores],
		onlyFiles: true,
		absolute: true,
		cwd: resolvedCwd,
	});
	const selectable = new Set(
		fullScan
			.map(realpathOrUndefined)
			.filter((value): value is string => value !== undefined),
	);
	if (selectable.size === 0) return { changedPaths, files: [] };

	const seen = new Set<string>();
	const files: string[] = [];
	for (const candidate of changedPaths) {
		const real = realpathOrUndefined(candidate);
		if (real === undefined || seen.has(real) || !selectable.has(real))
			continue;
		seen.add(real);
		files.push(real);
	}
	return { changedPaths, files };
}

/**
 * Returns the first `triggerPath` that also appears in `changedPaths`
 * (comparing realpaths, since the two lists are not guaranteed to share the
 * same symlink-resolution convention). Used to escalate a Git/jj diff
 * selection to a full scan when configuration, a prh dictionary, or a
 * dependency manifest changed alongside the documents.
 */
export function findEscalationTrigger(
	changedPaths: readonly string[],
	triggerPaths: readonly string[],
): string | undefined {
	const changedReal = new Set(
		changedPaths
			.map(realpathOrUndefined)
			.filter((value): value is string => value !== undefined),
	);
	if (changedReal.size === 0) return undefined;
	for (const trigger of triggerPaths) {
		const real = realpathOrUndefined(trigger);
		if (real !== undefined && changedReal.has(real)) return trigger;
	}
	return undefined;
}
