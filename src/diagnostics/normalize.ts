import type {
	TextlintFixResult,
	TextlintMessage,
	TextlintMessageFixCommand,
	TextlintMessageSuggestion,
	TextlintResult,
} from "@textlint/types";
import type {
	Diagnostic,
	DiagnosticSeverity,
	FixEdit,
	FixResult,
	LintResult,
	Suggestion,
} from "./types.js";

/** severity 0 は textlint では "none"（ルール無効）を意味し、報告対象の message には現れない。 */
function mapSeverity(
	severity: TextlintMessage["severity"],
): DiagnosticSeverity {
	switch (severity) {
		case 2:
			return "error";
		case 1:
			return "warning";
		case 3:
			return "info";
		default:
			throw new Error(`Unsupported textlint severity: ${String(severity)}`);
	}
}

function toFixEdit(command: TextlintMessageFixCommand): FixEdit {
	return {
		range: { start: command.range[0], end: command.range[1] },
		text: command.text,
	};
}

function toSuggestion(suggestion: TextlintMessageSuggestion): Suggestion {
	return {
		id: suggestion.id,
		message: suggestion.message,
		fix: toFixEdit(suggestion.fix),
	};
}

export function normalizeMessage(
	message: TextlintMessage,
	filePath: string,
): Diagnostic {
	const fix = message.fix !== undefined ? toFixEdit(message.fix) : undefined;
	const suggestions =
		message.suggestions !== undefined
			? message.suggestions.map(toSuggestion)
			: undefined;

	return {
		engine: "textlint",
		ruleId: message.ruleId,
		message: message.message,
		severity: mapSeverity(message.severity),
		filePath,
		location: {
			start: message.loc.start,
			end: message.loc.end,
			range: { start: message.range[0], end: message.range[1] },
		},
		...(fix !== undefined ? { fix } : {}),
		...(suggestions !== undefined ? { suggestions } : {}),
	};
}

export function normalizeResult(result: TextlintResult): LintResult {
	return {
		filePath: result.filePath,
		diagnostics: result.messages.map((message) =>
			normalizeMessage(message, result.filePath),
		),
	};
}

export function normalizeFixResult(result: TextlintFixResult): FixResult {
	return {
		filePath: result.filePath,
		output: result.output,
		diagnostics: result.messages.map((message) =>
			normalizeMessage(message, result.filePath),
		),
		applied: result.applyingMessages.map((message) =>
			normalizeMessage(message, result.filePath),
		),
		remaining: result.remainingMessages.map((message) =>
			normalizeMessage(message, result.filePath),
		),
	};
}
