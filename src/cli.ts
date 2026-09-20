#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
	findEscalationTrigger,
	selectExplicitFiles,
	selectVcsFiles,
	type TargetSelectionMode,
} from "./cli/target-selection.js";
import { discoverConfig, readIgnorePatterns } from "./cli/config-discovery.js";
import { loadDocumentlintConfig } from "./config/documentlint.js";
import type { Diagnostic, FixConflict } from "./diagnostics/types.js";
import { renderDiffPreview } from "./fix/diff-preview.js";
import type { SafeFixStopReason } from "./fix/session.js";
import { safeFixDocument } from "./fix/session.js";
import { ExternalChangeError, writeFileIfUnchanged } from "./fix/write.js";
import { runDocumentlint } from "./runner.js";

/**
 * Flags with a following value versus boolean flags, kept as the single
 * source of truth for both the `positional` filter and the flag/value
 * parsing below -- listing a flag in only one place used to let its value
 * (or the flag itself) leak into the positional file list as an
 * unresolvable glob instead of being consumed.
 */
const FLAGS_WITH_VALUE = [
	"--config",
	"--format",
	"--stdin-filename",
	"--max-iterations",
	"--git-since",
	"--jj-revision",
	"--jj-since",
	"--ignore-path",
] as const;
const VALUELESS_FLAGS = [
	"--stdin",
	"--fix",
	"--dry-run",
	"--all",
	"--git-staged",
	"--git-changed",
] as const;

function usage(): string {
	return [
		"Usage: documentlint [--config file] [--ignore-path file] [--fix] [--dry-run] [--max-iterations n] [--format human|json] [--stdin --stdin-filename path] [--all | --git-staged | --git-changed | --git-since rev | --jj-revision rev | --jj-since rev | files/globs...]",
		"Config: searches parent directories for documentlint.json then .textlintrc.json; --config selects exactly one file.",
		"--fix writes resolved files to disk; --dry-run computes the same fixes and previews them without writing (implies --fix's analysis, never writes)",
		"Target selection (at most one; with none of these and no file/glob arguments, the configured `files` glob is used):",
		"  --all                scan every file the configured `files` glob matches (default: **/*.md)",
		"  --git-staged         files staged in the Git index",
		"  --git-changed        files with an uncommitted Git change: staged, unstaged, or untracked",
		"  --git-since <rev>    files changed since the merge-base of <rev> and HEAD, including uncommitted changes",
		"  --jj-revision <rev>  files changed in one jj revision (jj diff -r <rev>)",
		"  --jj-since <rev>     files changed between <rev> and the current jj working-copy commit (@)",
		"Every mode checks whole files, not just changed lines. Deletions are excluded; renames and untracked files are included by their current path. node_modules is always excluded. If the resolved config file, a prh dictionary, or a dependency manifest is among the changed files, documentlint runs a full scan instead and reports why on stderr.",
		"Exit: 0=no findings, 1=findings or a fix run that stopped without converging, 2=configuration or execution error",
		"",
	].join("\n");
}

interface CliFileResult {
	readonly filePath: string;
	readonly diagnostics: readonly Diagnostic[];
	readonly errors: readonly { engine: string; message: string }[];
	readonly changed: boolean;
	/** True only when this invocation atomically replaced the file on disk. */
	readonly written: boolean;
	readonly conflicts: readonly FixConflict[];
	readonly iterations: number;
	/**
	 * Only present for a --fix/--dry-run run (safeFixDocument executed);
	 * absent for a plain lint run, which never entered the fix loop.
	 */
	readonly stoppedReason?: SafeFixStopReason;
	readonly diff?: string;
}

function human(result: CliFileResult): string {
	const lines = result.diagnostics.map(
		(item) =>
			`${item.filePath}:${item.location.start.line}:${item.location.start.column} ${item.severity} ${item.engine}/${item.ruleId} ${item.message}`,
	);
	for (const conflict of result.conflicts)
		lines.push(
			`${result.filePath}: ${conflict.kind} fix conflict at ${conflict.range.start}:${conflict.range.end} between ${conflict.diagnostics
				.map((item) => `${item.engine}/${item.ruleId}`)
				.join(", ")}`,
		);
	for (const error of result.errors)
		lines.push(`${result.filePath}: ${error.engine} error: ${error.message}`);
	if (result.diff) lines.push(result.diff.trimEnd());
	return lines.join("\n");
}

/**
 * A fix run that stops without proving convergence (round cap reached, or a
 * cycle between mutually undoing edits) can leave the output partially or
 * over-applied; human format surfaces that on stderr instead of only in the
 * machine-readable stoppedReason field.
 */
function stopWarning(result: CliFileResult): string | undefined {
	if (!result.stoppedReason || result.stoppedReason === "converged")
		return undefined;
	if (result.stoppedReason === "cycle-detected")
		return `warning: ${result.filePath}: stopped after ${result.iterations} fix rounds because the fixes cycled between rules that undo each other; the output may be incomplete or over-applied. Review the conflicting rules.`;
	return `warning: ${result.filePath}: stopped after ${result.iterations} fix rounds without converging; the output may be incomplete or over-applied. Re-run with --max-iterations or review the conflicting rules.`;
}

export async function main(
	args = process.argv.slice(2),
	stdin?: string,
): Promise<number> {
	// The CLI accepts the conventional --flag=value spelling, but normalizes it
	// before validation so every option has exactly one parsing path.
	args = args.flatMap((arg) => {
		const equal = arg.indexOf("=");
		return equal > 2 && arg.startsWith("--")
			? [arg.slice(0, equal), arg.slice(equal + 1)]
			: [arg];
	});
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(usage());
		return 0;
	}
	const value = (flag: string) => {
		const i = args.indexOf(flag);
		return i === -1 ? undefined : args[i + 1];
	};
	const knownFlags = new Set<string>([
		...FLAGS_WITH_VALUE,
		...VALUELESS_FLAGS,
		"--help",
		"-h",
	]);
	const separator = args.indexOf("--");
	const optionArgs = separator === -1 ? args : args.slice(0, separator);
	for (const arg of optionArgs)
		if (arg.startsWith("-") && !knownFlags.has(arg))
			throw new Error(`Unknown option: ${arg}. Run documentlint --help for usage.`);
	for (const flag of [...FLAGS_WITH_VALUE, ...VALUELESS_FLAGS])
		if (optionArgs.filter((arg) => arg === flag).length > 1)
			throw new Error(`${flag} may be specified at most once.`);
	for (const flag of FLAGS_WITH_VALUE)
		if (optionArgs.includes(flag)) {
			const optionValue = value(flag);
			if (optionValue === undefined || optionValue === "" || optionValue.startsWith("--"))
				throw new Error(`${flag} requires a value.`);
		}
	const format = value("--format") ?? "human";
	if (format !== "human" && format !== "json")
		throw new Error("--format must be human or json");
	const dryRun = args.includes("--dry-run");
	const fix = args.includes("--fix") || dryRun;
	const hasMaxIterationsFlag = args.includes("--max-iterations");
	const maxIterationsRaw = value("--max-iterations");
	// `value()` returns undefined both when the flag is absent and when it is
	// the last argument with no value after it; without this check the two
	// are indistinguishable and a trailing `--max-iterations` silently falls
	// back to the default instead of erroring.
	if (hasMaxIterationsFlag && maxIterationsRaw === undefined)
		throw new Error("--max-iterations requires a value");
	const maxIterations =
		maxIterationsRaw === undefined ? undefined : Number(maxIterationsRaw);
	if (
		maxIterations !== undefined &&
		(!Number.isInteger(maxIterations) || maxIterations < 1)
	)
		throw new Error("--max-iterations must be a positive integer");
	const stdinMode = args.includes("--stdin");
	const stdinText = stdin ?? (stdinMode ? fs.readFileSync(0, "utf8") : "");
	const positional = args.filter(
		(arg, i) =>
			((separator !== -1 && i > separator) ||
				(arg !== "--" &&
			!(FLAGS_WITH_VALUE as readonly string[]).includes(args[i - 1] ?? "") &&
			![
				...(FLAGS_WITH_VALUE as readonly string[]),
				...(VALUELESS_FLAGS as readonly string[]),
			].includes(arg))),
	);
	const requiredValue = (flag: string): string | undefined => {
		if (!args.includes(flag)) return undefined;
		const flagValue = value(flag);
		if (flagValue === undefined) throw new Error(`${flag} requires a value`);
		return flagValue;
	};
	const allFlag = args.includes("--all");
	const gitStaged = args.includes("--git-staged");
	const gitChanged = args.includes("--git-changed");
	const gitSince = requiredValue("--git-since");
	const jjRevision = requiredValue("--jj-revision");
	const jjSince = requiredValue("--jj-since");
	const selectionModes = [
		{ label: "explicit file arguments", active: positional.length > 0 },
		{ label: "--all", active: allFlag },
		{ label: "--git-staged", active: gitStaged },
		{ label: "--git-changed", active: gitChanged },
		{ label: "--git-since", active: gitSince !== undefined },
		{ label: "--jj-revision", active: jjRevision !== undefined },
		{ label: "--jj-since", active: jjSince !== undefined },
	].filter((mode) => mode.active);
	if (selectionModes.length > 1)
		throw new Error(
			`Only one target-selection mode may be used at a time; got ${selectionModes
				.map((mode) => mode.label)
				.join(" and ")}.`,
		);
	if (stdinMode && selectionModes.some((mode) => mode.label !== "explicit file arguments"))
		throw new Error(
			"--stdin cannot be combined with a target-selection flag (--all, --git-*, --jj-*).",
		);
	const vcsSelection: TargetSelectionMode | undefined = gitStaged
		? { source: "git", scope: { kind: "staged" } }
		: gitChanged
			? { source: "git", scope: { kind: "changed" } }
			: gitSince !== undefined
				? { source: "git", scope: { kind: "since", rev: gitSince } }
				: jjRevision !== undefined
					? { source: "jj", scope: { kind: "revision", rev: jjRevision } }
					: jjSince !== undefined
						? { source: "jj", scope: { kind: "since", rev: jjSince } }
						: undefined;
	const discoveredConfig = discoverConfig(process.cwd(), value("--config"));
	const configPath = discoveredConfig.path;
	const config = loadDocumentlintConfig(configPath);
	const configDirectory = discoveredConfig.directory;
	const ignorePath = value("--ignore-path")
		? path.resolve(configDirectory, value("--ignore-path") ?? "")
		: path.join(configDirectory, ".textlintignore");
	const ignores = [
		...(config.ignores ?? []),
		...(config.markdownlint?.ignores ?? []),
		...readIgnorePatterns(ignorePath),
	];
	const filePatterns = positional.length
		? positional
		: [...(config.files ?? ["**/*.md"])];
	const notices: string[] = [];
	let files: readonly string[];
	if (stdinMode) {
		files = [value("--stdin-filename") ?? "stdin.md"];
	} else if (vcsSelection === undefined) {
		files = await selectExplicitFiles(
			filePatterns,
			ignores,
			positional.length ? process.cwd() : configDirectory,
		);
		if (positional.length > 0 && files.length === 0)
			throw new Error(
				`No files matched the explicit target(s): ${positional.join(", ")}.`,
			);
	} else {
		const escalationTriggers = [
			path.resolve(configPath),
			path.join(process.cwd(), "package.json"),
			path.join(process.cwd(), "pnpm-lock.yaml"),
			path.join(process.cwd(), "package-lock.json"),
			path.join(process.cwd(), "yarn.lock"),
			...(config.prh?.dictionaries ?? []).map((file) =>
				path.resolve(configDirectory, file),
			),
		];
		const selection = await selectVcsFiles(
			vcsSelection,
			filePatterns,
			ignores,
			configDirectory,
		);
		const trigger = findEscalationTrigger(
			selection.changedPaths,
			escalationTriggers,
		);
		if (trigger !== undefined) {
			notices.push(
				`${path.relative(process.cwd(), trigger)} changed; running a full scan instead of the requested diff.`,
			);
			files = await selectExplicitFiles(filePatterns, ignores, configDirectory);
		} else {
			files = selection.files;
			if (files.length === 0)
				notices.push("No changed files matched; nothing to check.");
		}
	}
	const results: CliFileResult[] = await Promise.all(
		files.map(async (file) => {
			const filePath = path.resolve(file);
			const text = stdinMode ? stdinText : fs.readFileSync(file, "utf8");
			if (!fix) {
				const result = await runDocumentlint(
					text,
					filePath,
					config,
					false,
					configPath,
				);
				return {
					filePath,
					diagnostics: result.diagnostics,
					errors: result.errors,
					changed: false,
					written: false,
					conflicts: [],
					iterations: 0,
				};
			}
			const result = await safeFixDocument(
				text,
				filePath,
				config,
				configPath,
				maxIterations !== undefined ? { maxIterations } : {},
			);
			const canWrite =
				!stdinMode &&
				!dryRun &&
				result.changed &&
				result.errors.length === 0 &&
				result.stoppedReason === "converged";
			if (canWrite) {
				try {
					writeFileIfUnchanged(file, text, result.output);
				} catch (error) {
					const message =
						error instanceof ExternalChangeError
							? error.message
							: error instanceof Error
								? error.message
								: String(error);
					return {
						filePath,
						diagnostics: result.diagnostics,
						errors: [...result.errors, { engine: "documentlint", message }],
						changed: result.changed,
						written: false,
						conflicts: result.conflicts,
						iterations: result.iterations.length,
						stoppedReason: result.stoppedReason,
					};
				}
			}
			return {
				filePath,
				diagnostics: result.diagnostics,
				errors: result.errors,
				changed: result.changed,
				written: canWrite,
				conflicts: result.conflicts,
				iterations: result.iterations.length,
				stoppedReason: result.stoppedReason,
				...(dryRun && result.changed
					? { diff: renderDiffPreview(filePath, text, result.output) }
					: {}),
			};
		}),
	);
	for (const notice of notices)
		process.stderr.write(`documentlint: ${notice}\n`);
	if (format === "json")
		process.stdout.write(
			`${JSON.stringify(
				{
					version: 1,
					results,
					...(notices.length ? { notices } : {}),
				},
				null,
				2,
			)}\n`,
		);
	else {
		const output = results.map(human).filter(Boolean).join("\n");
		if (output) process.stdout.write(`${output}\n`);
		for (const result of results) {
			const warning = stopWarning(result);
			if (warning) process.stderr.write(`${warning}\n`);
		}
	}
	const stoppedWithoutConverging = results.some(
		(result) =>
			result.stoppedReason !== undefined &&
			result.stoppedReason !== "converged",
	);
	return results.some((result) => result.errors.length)
		? 2
		: results.some((result) => result.diagnostics.length) ||
				stoppedWithoutConverging
			? 1
			: 0;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href)
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			const cliArgs = process.argv.slice(2);
			const json =
			cliArgs.includes("--format=json") ||
			cliArgs.some(
				(arg, index) => arg === "--format" && cliArgs[index + 1] === "json",
			);
			if (json)
				process.stdout.write(
					`${JSON.stringify({ version: 1, error: { message } })}\n`,
				);
			else process.stderr.write(`${message}\n`);
			process.exitCode = 2;
		});
