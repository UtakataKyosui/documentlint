import type { Engine } from "prh";
import { fromRowConfig, fromYAMLFilePaths } from "prh";
import type { Config as PrhConfig } from "prh/lib/raw.js";
import type {
	Diagnostic,
	FixResult,
	LintResult,
} from "../../diagnostics/types.js";

export interface PrhAdapter {
	lintText(text: string, filePath: string): LintResult;
	fixText(text: string, filePath: string): FixResult;
}

function position(
	text: string,
	offset: number,
): { line: number; column: number } {
	const before = text.slice(0, offset);
	return {
		line: before.split(/\r?\n/).length,
		column:
			offset - Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")),
	};
}

function fromEngine(engine: Engine): PrhAdapter {
	function lintText(text: string, filePath: string): LintResult {
		const changes = engine.makeChangeSet(filePath, text);
		return {
			filePath,
			diagnostics: changes.diffs.map((diff) => {
				const start = position(text, diff.index);
				const end = position(text, diff.tailIndex);
				const replacement = diff.newText;
				return {
					engine: "prh",
					ruleId: "prh",
					message: `Replace "${diff.matches[0] ?? ""}" with "${replacement ?? ""}"`,
					severity: "error",
					filePath,
					location: {
						start,
						end,
						range: { start: diff.index, end: diff.tailIndex },
					},
					...(replacement === null
						? {}
						: {
								fix: {
									range: { start: diff.index, end: diff.tailIndex },
									text: replacement,
								},
							}),
				} satisfies Diagnostic;
			}),
		};
	}
	return {
		lintText,
		fixText(text, filePath) {
			const result = lintText(text, filePath);
			const changes = engine.makeChangeSet(filePath, text);
			return {
				...result,
				output: changes.applyChangeSets(text),
				applied: result.diagnostics.filter((item) => item.fix !== undefined),
				remaining: [],
			};
		},
	};
}

export function createPrhAdapter(
	dictionary: Record<string, unknown>,
	dictionaryPath = "documentlint.json",
): PrhAdapter {
	return fromEngine(
		fromRowConfig(dictionaryPath, dictionary as unknown as PrhConfig),
	);
}
export function createPrhAdapterFromFiles(
	dictionaryPaths: readonly string[],
): PrhAdapter {
	return fromEngine(fromYAMLFilePaths(...dictionaryPaths));
}
