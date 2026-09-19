import type { DiagnosticSeverity, TextRange } from "../diagnostics/types.js";

export type DocumentlintPluginOptions = Readonly<Record<string, unknown>>;

export interface DocumentlintPluginContext {
	readonly filePath: string;
	readonly configPath: string;
	/** Original, unmodified source. */
	readonly source: string;
	/** Source after the configured syntax preprocessors have run. */
	readonly text: string;
}

export interface DocumentlintPluginDiagnostic {
	readonly ruleId: string;
	readonly message: string;
	readonly severity?: DiagnosticSeverity;
	readonly range: TextRange;
}

export interface DocumentlintPlugin {
	readonly apiVersion: 1;
	readonly name?: string;
	/**
	 * Hide or rewrite extension syntax before built-in engines parse it.
	 * The returned string must preserve UTF-16 length and every line break.
	 */
	preprocess?(
		context: DocumentlintPluginContext,
		options: DocumentlintPluginOptions,
	): string | Promise<string>;
	/** A markdown-it plugin used by markdownlint's parser. */
	readonly markdownItPlugin?: (markdownIt: unknown, options?: unknown) => void;
	/** Add diagnostics that are independent from textlint, markdownlint, and prh. */
	lint?(
		context: DocumentlintPluginContext,
		options: DocumentlintPluginOptions,
	):
		| readonly DocumentlintPluginDiagnostic[]
		| Promise<readonly DocumentlintPluginDiagnostic[]>;
}

export type DocumentlintPluginFactory = (
	options: DocumentlintPluginOptions,
) => DocumentlintPlugin | Promise<DocumentlintPlugin>;

export type DocumentlintPluginExport =
	| DocumentlintPlugin
	| DocumentlintPluginFactory;

export function defineDocumentlintPlugin<T extends DocumentlintPlugin>(
	plugin: T,
): T {
	return plugin;
}
