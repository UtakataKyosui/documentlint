import type { DocumentlintConfig } from "../config/documentlint.js";
import type { Diagnostic, FixConflict } from "../diagnostics/types.js";
import { runDocumentlint } from "../runner.js";

export type SafeFixStopReason =
	| "converged"
	| "cycle-detected"
	| "max-iterations";

export interface SafeFixOptions {
	/** Upper bound on re-analysis rounds; guards against fixes that never settle. Default 10. */
	readonly maxIterations?: number;
}

export interface SafeFixIteration {
	readonly input: string;
	readonly output: string;
	readonly applied: readonly Diagnostic[];
	readonly conflicts: readonly FixConflict[];
}

export interface SafeFixResult {
	readonly filePath: string;
	readonly input: string;
	readonly output: string;
	readonly changed: boolean;
	readonly iterations: readonly SafeFixIteration[];
	readonly conflicts: readonly FixConflict[];
	/** Diagnostics from a full, fix-free re-check of the final output across every engine. */
	readonly diagnostics: readonly Diagnostic[];
	readonly errors: readonly { engine: string; message: string }[];
	readonly stoppedReason: SafeFixStopReason;
}

const DEFAULT_MAX_ITERATIONS = 10;

function dedupeConflicts(conflicts: readonly FixConflict[]): FixConflict[] {
	const seen = new Set<string>();
	const unique: FixConflict[] = [];
	for (const conflict of conflicts) {
		const key = `${conflict.kind}:${conflict.range.start}:${conflict.range.end}:${conflict.diagnostics
			.map((item) => `${item.engine}/${item.ruleId}`)
			.sort()
			.join(",")}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(conflict);
	}
	return unique;
}

/**
 * Iterates documentlint's single-round fix (same-input edit merge with
 * conflict detection, see mergeEdits) to a fixed point: each round's output
 * becomes the next round's input, so every engine re-analyzes fresh text
 * (catching fixes that only become visible after another engine's edit)
 * while conflicting edits proposed within one round are never silently
 * resolved by picking a winner. Stops on no further change, on a max
 * iteration count, or when a round's output repeats one already seen (a
 * cycle between mutually undoing fixes). Finishes with a fix-free re-check
 * of every engine against the settled text.
 */
export async function safeFixDocument(
	text: string,
	filePath: string,
	config: DocumentlintConfig,
	configPath = "documentlint.json",
	options: SafeFixOptions = {},
): Promise<SafeFixResult> {
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	// Number.isInteger rejects fractions (1.5 would silently run one round and
	// report "converged" with diagnostics still outstanding), NaN (which
	// makes every `<=` comparison false, so the loop below runs zero rounds
	// while `stoppedReason` keeps its "converged" default), and Infinity
	// (which removes the round cap the option exists to provide).
	if (!Number.isInteger(maxIterations) || maxIterations < 1)
		throw new RangeError("maxIterations must be a positive integer.");

	const seen = new Set<string>([text]);
	const iterations: SafeFixIteration[] = [];
	const allConflicts: FixConflict[] = [];
	const errors: { engine: string; message: string }[] = [];
	let current = text;
	let stoppedReason: SafeFixStopReason = "converged";

	for (let round = 1; round <= maxIterations; round += 1) {
		const result = await runDocumentlint(
			current,
			filePath,
			config,
			true,
			configPath,
		);
		errors.push(...result.errors);
		allConflicts.push(...result.conflicts);
		iterations.push({
			input: current,
			output: result.output,
			applied: result.applied,
			conflicts: result.conflicts,
		});
		if (result.output === current) {
			stoppedReason = "converged";
			break;
		}
		if (seen.has(result.output)) {
			current = result.output;
			stoppedReason = "cycle-detected";
			break;
		}
		seen.add(result.output);
		current = result.output;
		if (round === maxIterations) stoppedReason = "max-iterations";
	}

	const finalCheck = await runDocumentlint(
		current,
		filePath,
		config,
		false,
		configPath,
	);
	return {
		filePath,
		input: text,
		output: current,
		changed: current !== text,
		iterations,
		conflicts: dedupeConflicts(allConflicts),
		diagnostics: finalCheck.diagnostics,
		errors: [...errors, ...finalCheck.errors],
		stoppedReason,
	};
}
