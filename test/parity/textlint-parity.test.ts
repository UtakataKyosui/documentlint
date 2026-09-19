import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	TextlintFixResult,
	TextlintMessage,
	TextlintResult,
} from "@textlint/types";
import { beforeAll, describe, expect, it } from "vitest";
import type { TextlintAdapter } from "../../src/adapters/textlint/adapter.js";
import { createTextlintAdapter } from "../../src/adapters/textlint/adapter.js";
import { resolveTextlintrc } from "../../src/config/textlintrc.js";
import type { Diagnostic } from "../../src/diagnostics/types.js";
import type { TextlintReference } from "./run-textlint.js";
import { createTextlintReference } from "./run-textlint.js";

const fixturesDir = path.resolve(
	fileURLToPath(import.meta.url),
	"../../fixtures",
);
const configPath = path.join(fixturesDir, ".textlintrc.json");
const compositeConfigPath = path.join(fixturesDir, "composite.textlintrc.json");
const fixtureNames = [
	"basic.md",
	"japanese.md",
	"fixable.md",
	"spacing.md",
] as const;

type ComparableSeverity = "error" | "warning" | "info";

interface ComparableLocation {
	readonly start: { readonly line: number; readonly column: number };
	readonly end: { readonly line: number; readonly column: number };
	readonly range: { readonly start: number; readonly end: number };
}

interface ComparableDiagnostic {
	readonly ruleId: string;
	readonly message: string;
	readonly severity: ComparableSeverity;
	readonly filePath: string;
	readonly location: ComparableLocation;
}

interface ComparableFix {
	readonly range: { readonly start: number; readonly end: number };
	readonly text: string;
}

interface ComparableDiagnosticWithFix extends ComparableDiagnostic {
	readonly fix?: ComparableFix;
}

/**
 * textlint の生の severity（数値）を documentlint の文字列表現へ写す。
 * normalize.ts の mapSeverity は使わず、期待値をここで独立に組み立てる。
 */
function mapTextlintSeverity(
	severity: TextlintMessage["severity"],
): ComparableSeverity {
	switch (severity) {
		case 2:
			return "error";
		case 1:
			return "warning";
		case 3:
			return "info";
		default:
			throw new Error(
				`Unexpected textlint severity in parity test: ${String(severity)}`,
			);
	}
}

function expectedFromMessage(
	message: TextlintMessage,
	filePath: string,
): ComparableDiagnostic {
	return {
		ruleId: message.ruleId,
		message: message.message,
		severity: mapTextlintSeverity(message.severity),
		filePath,
		location: {
			start: { line: message.loc.start.line, column: message.loc.start.column },
			end: { line: message.loc.end.line, column: message.loc.end.column },
			range: { start: message.range[0], end: message.range[1] },
		},
	};
}

function actualFromDiagnostic(diagnostic: Diagnostic): ComparableDiagnostic {
	return {
		ruleId: diagnostic.ruleId,
		message: diagnostic.message,
		severity: diagnostic.severity,
		filePath: diagnostic.filePath,
		location: diagnostic.location,
	};
}

function expectedFromMessageWithFix(
	message: TextlintMessage,
	filePath: string,
): ComparableDiagnosticWithFix {
	const base = expectedFromMessage(message, filePath);
	if (message.fix === undefined) {
		return base;
	}
	return {
		...base,
		fix: {
			range: { start: message.fix.range[0], end: message.fix.range[1] },
			text: message.fix.text,
		},
	};
}

function actualFromDiagnosticWithFix(
	diagnostic: Diagnostic,
): ComparableDiagnosticWithFix {
	const base = actualFromDiagnostic(diagnostic);
	if (diagnostic.fix === undefined) {
		return base;
	}
	return {
		...base,
		fix: {
			range: {
				start: diagnostic.fix.range.start,
				end: diagnostic.fix.range.end,
			},
			text: diagnostic.fix.text,
		},
	};
}

/** ruleId → range.start → range.end → message の順で全順序に並べる。 */
function compareDiagnostics(
	a: ComparableDiagnostic,
	b: ComparableDiagnostic,
): number {
	if (a.ruleId !== b.ruleId) {
		return a.ruleId < b.ruleId ? -1 : 1;
	}
	if (a.location.range.start !== b.location.range.start) {
		return a.location.range.start - b.location.range.start;
	}
	if (a.location.range.end !== b.location.range.end) {
		return a.location.range.end - b.location.range.end;
	}
	if (a.message !== b.message) {
		return a.message < b.message ? -1 : 1;
	}
	return 0;
}

function sortDiagnostics<T extends ComparableDiagnostic>(
	diagnostics: readonly T[],
): T[] {
	return [...diagnostics].sort(compareDiagnostics);
}

function readFixture(fixtureName: string): {
	readonly filePath: string;
	readonly text: string;
} {
	const filePath = path.join(fixturesDir, fixtureName);
	return { filePath, text: fs.readFileSync(filePath, "utf8") };
}

describe("textlint adapter parity with textlint itself", () => {
	let reference: TextlintReference;
	let adapter: TextlintAdapter;

	beforeAll(async () => {
		reference = await createTextlintReference(configPath);
		const rc = resolveTextlintrc(configPath);
		adapter = await createTextlintAdapter(rc);
	});

	it.each(fixtureNames)(
		"matches textlint's lint diagnostics for %s",
		async (fixtureName) => {
			const { filePath, text } = readFixture(fixtureName);

			const referenceResult: TextlintResult = await reference.lintText(
				text,
				filePath,
			);
			const documentlintResult = await adapter.lintText(text, filePath);

			expect(referenceResult.messages.length).toBeGreaterThan(0);
			expect(documentlintResult.diagnostics.length).toBe(
				referenceResult.messages.length,
			);

			const expected = sortDiagnostics(
				referenceResult.messages.map((message) =>
					expectedFromMessage(message, filePath),
				),
			);
			const actual = sortDiagnostics(
				documentlintResult.diagnostics.map(actualFromDiagnostic),
			);

			expect(actual).toEqual(expected);
		},
	);

	it("suppresses the same diagnostics inside the textlint-disable/enable block for fixable.md", async () => {
		const { filePath, text } = readFixture("fixable.md");

		const referenceResult = await reference.lintText(text, filePath);
		const documentlintResult = await adapter.lintText(text, filePath);

		expect(referenceResult.messages).toHaveLength(2);
		expect(documentlintResult.diagnostics).toHaveLength(2);
	});

	it("matches textlint's fix output and applied/remaining diagnostics for fixable.md", async () => {
		const { filePath, text } = readFixture("fixable.md");

		const referenceFix: TextlintFixResult = await reference.fixText(
			text,
			filePath,
		);
		const documentlintFix = await adapter.fixText(text, filePath);

		expect(documentlintFix.output).toBe(referenceFix.output);
		// no-todo は fixer を提供しないため、両者とも入力をそのまま返す no-op fix になる。
		expect(documentlintFix.output).toBe(text);

		const expectedApplied = sortDiagnostics(
			referenceFix.applyingMessages.map((message) =>
				expectedFromMessage(message, filePath),
			),
		);
		const actualApplied = sortDiagnostics(
			documentlintFix.applied.map(actualFromDiagnostic),
		);
		expect(actualApplied).toEqual(expectedApplied);

		const expectedRemaining = sortDiagnostics(
			referenceFix.remainingMessages.map((message) =>
				expectedFromMessage(message, filePath),
			),
		);
		const actualRemaining = sortDiagnostics(
			documentlintFix.remaining.map(actualFromDiagnostic),
		);
		expect(actualRemaining).toEqual(expectedRemaining);
	});

	it("matches textlint's fix output, diagnostics and applied/remaining fix edits for spacing.md", async () => {
		const { filePath, text } = readFixture("spacing.md");

		const referenceFix: TextlintFixResult = await reference.fixText(
			text,
			filePath,
		);
		const documentlintFix = await adapter.fixText(text, filePath);

		expect(documentlintFix.output).toBe(referenceFix.output);
		expect(documentlintFix.output).not.toBe(text);

		const expectedDiagnostics = sortDiagnostics(
			referenceFix.messages.map((message) =>
				expectedFromMessageWithFix(message, filePath),
			),
		);
		const actualDiagnostics = sortDiagnostics(
			documentlintFix.diagnostics.map(actualFromDiagnosticWithFix),
		);
		expect(actualDiagnostics).toEqual(expectedDiagnostics);

		const expectedApplied = sortDiagnostics(
			referenceFix.applyingMessages.map((message) =>
				expectedFromMessageWithFix(message, filePath),
			),
		);
		const actualApplied = sortDiagnostics(
			documentlintFix.applied.map(actualFromDiagnosticWithFix),
		);
		expect(actualApplied).toEqual(expectedApplied);
		expect(actualApplied.length).toBeGreaterThan(0);
		expect(
			actualApplied.every((diagnostic) => diagnostic.fix !== undefined),
		).toBe(true);

		const expectedRemaining = sortDiagnostics(
			referenceFix.remainingMessages.map((message) =>
				expectedFromMessageWithFix(message, filePath),
			),
		);
		const actualRemaining = sortDiagnostics(
			documentlintFix.remaining.map(actualFromDiagnosticWithFix),
		);
		expect(actualRemaining).toEqual(expectedRemaining);
	});

	it("matches textlint for existing presets and allowlist/comments/node-types filters", async () => {
		const { filePath, text } = readFixture("composite.md");
		const compositeReference =
			await createTextlintReference(compositeConfigPath);
		const compositeAdapter = await createTextlintAdapter(
			resolveTextlintrc(compositeConfigPath),
		);

		const referenceResult = await compositeReference.lintText(text, filePath);
		const documentlintResult = await compositeAdapter.lintText(text, filePath);

		const expected = sortDiagnostics(
			referenceResult.messages.map((message) =>
				expectedFromMessage(message, filePath),
			),
		);
		const actual = sortDiagnostics(
			documentlintResult.diagnostics.map(actualFromDiagnostic),
		);
		expect(actual).toEqual(expected);

		const ruleIds = new Set(
			referenceResult.messages.map((message) => message.ruleId),
		);
		expect(ruleIds).toContain("ja-technical-writing/max-kanji-continuous-len");
		expect(ruleIds).toContain(
			"ja-spacing/ja-space-between-half-and-full-width",
		);
		expect(ruleIds).toContain("@textlint-ja/ai-writing/no-ai-hype-expressions");

		const todoMessages = referenceResult.messages.filter(
			(message) => message.ruleId === "no-todo",
		);
		expect(todoMessages).toHaveLength(1);
		expect(todoMessages[0]?.loc.start.line).toBe(7);
	});
});
