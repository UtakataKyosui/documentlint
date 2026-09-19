export type DiagnosticSeverity = "error" | "warning" | "info";

export type SourceEngine =
	| "textlint"
	| "markdownlint"
	| "prh"
	| `plugin:${string}`;

/** 0 始まりのインデックスで表す文字範囲。 */
export interface TextRange {
	readonly start: number;
	readonly end: number;
}

/** line / column ともに 1 始まり。 */
export interface Position {
	readonly line: number;
	readonly column: number;
}

export interface DiagnosticLocation {
	readonly start: Position;
	readonly end: Position;
	readonly range: TextRange;
}

export interface FixEdit {
	readonly range: TextRange;
	readonly text: string;
}

export interface Suggestion {
	readonly id: string;
	readonly message: string;
	readonly fix: FixEdit;
}

export interface Diagnostic {
	readonly engine: SourceEngine;
	readonly ruleId: string;
	readonly message: string;
	readonly severity: DiagnosticSeverity;
	readonly filePath: string;
	readonly location: DiagnosticLocation;
	readonly fix?: FixEdit;
	readonly suggestions?: readonly Suggestion[];
}

export interface LintResult {
	readonly filePath: string;
	readonly diagnostics: readonly Diagnostic[];
}

export interface FixResult extends LintResult {
	readonly output: string;
	readonly applied: readonly Diagnostic[];
	readonly remaining: readonly Diagnostic[];
}
