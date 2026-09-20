#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { loadDocumentlintConfig } from "./config/documentlint.js";
import type { Diagnostic, FixConflict } from "./diagnostics/types.js";
import { renderDiffPreview } from "./fix/diff-preview.js";
import type { SafeFixStopReason } from "./fix/session.js";
import { safeFixDocument } from "./fix/session.js";
import { ExternalChangeError, writeFileIfUnchanged } from "./fix/write.js";
import { runDocumentlint } from "./runner.js";

function usage(): string {
	return "Usage: documentlint [--config file] [--fix] [--dry-run] [--max-iterations n] [--format human|json] [--stdin --stdin-filename path] [files/globs...]\nConfig: documentlint.json, falling back to .textlintrc.json\n--fix writes resolved files to disk; --dry-run computes the same fixes and previews them without writing (implies --fix's analysis, never writes)\nExit: 0=no findings, 1=findings or a fix run that stopped without converging, 2=configuration or execution error\n";
}

interface CliFileResult {
	readonly filePath: string;
	readonly diagnostics: readonly Diagnostic[];
	readonly errors: readonly { engine: string; message: string }[];
	readonly changed: boolean;
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
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(usage());
		return 0;
	}
	const value = (flag: string) => {
		const i = args.indexOf(flag);
		return i === -1 ? undefined : args[i + 1];
	};
	const configPath =
		value("--config") ??
		(fs.existsSync("documentlint.json")
			? "documentlint.json"
			: ".textlintrc.json");
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
			![
				"--config",
				"--format",
				"--stdin-filename",
				"--max-iterations",
			].includes(args[i - 1] ?? "") &&
			![
				"--config",
				"--format",
				"--stdin-filename",
				"--stdin",
				"--fix",
				"--dry-run",
				"--max-iterations",
			].includes(arg),
	);
	const config = loadDocumentlintConfig(configPath);
	const files = stdinMode
		? [value("--stdin-filename") ?? "stdin.md"]
		: await fg(
				positional.length ? positional : [...(config.files ?? ["**/*.md"])],
				{
					ignore: [
						...(config.ignores ?? []),
						...(config.markdownlint?.ignores ?? []),
					],
					onlyFiles: true,
				},
			);
	if (files.length === 0) return 0;
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
				!stdinMode && !dryRun && result.changed && result.errors.length === 0;
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
				conflicts: result.conflicts,
				iterations: result.iterations.length,
				stoppedReason: result.stoppedReason,
				...(dryRun && result.changed
					? { diff: renderDiffPreview(filePath, text, result.output) }
					: {}),
			};
		}),
	);
	if (format === "json")
		process.stdout.write(
			`${JSON.stringify({ version: 1, results }, null, 2)}\n`,
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
			process.stderr.write(
				`${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 2;
		});
