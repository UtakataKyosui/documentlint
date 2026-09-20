import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import MarkdownIt from "markdown-it";
import type { LintError } from "markdownlint";
import { applyFixes } from "markdownlint";
import { lint } from "markdownlint/promise";
import type {
	Diagnostic,
	FixResult,
	LintResult,
} from "../../diagnostics/types.js";

export interface MarkdownlintAdapterOptions {
	readonly config?: Record<string, unknown>;
	readonly moduleBaseDirectory?: string;
	readonly markdownItPlugins?: readonly (
		| string
		| {
				readonly plugin: (markdownIt: unknown, options?: unknown) => void;
				readonly options?: unknown;
		  }
	)[];
}

function offsetOf(text: string, line: number, column: number): number {
	const lines = text.split(/\r?\n/);
	return (
		lines
			.slice(0, line - 1)
			.reduce((offset, value) => offset + value.length + 1, 0) +
		column -
		1
	);
}

function diagnostic(
	error: LintError,
	text: string,
	filePath: string,
): Diagnostic {
	const column = error.errorRange?.[0] ?? 1;
	const length = error.errorRange?.[1] ?? 1;
	const start = offsetOf(text, error.lineNumber, column);
	return {
		engine: "markdownlint",
		ruleId: error.ruleNames[0] ?? "markdownlint",
		message: error.errorDetail ?? error.ruleDescription,
		severity: error.severity,
		filePath,
		location: {
			start: { line: error.lineNumber, column },
			end: { line: error.lineNumber, column: column + length },
			range: { start, end: start + length },
		},
	};
}

export interface MarkdownlintAdapter {
	lintText(text: string, filePath: string): Promise<LintResult>;
	fixText(text: string, filePath: string): Promise<FixResult>;
}

export function createMarkdownlintAdapter(
	options: MarkdownlintAdapterOptions = {},
): MarkdownlintAdapter {
	async function errors(text: string, filePath: string): Promise<LintError[]> {
		const requireFromBase = options.moduleBaseDirectory
			? createRequire(path.join(options.moduleBaseDirectory, "noop.cjs"))
			: undefined;
		const plugins = await Promise.all(
			(options.markdownItPlugins ?? []).map(async (configured) => {
				if (typeof configured !== "string") return configured;
				const resolved = requireFromBase?.resolve(configured) ?? configured;
				const module = await import(
					requireFromBase ? pathToFileURL(resolved).href : resolved
				);
				const plugin = module.default ?? module;
				if (typeof plugin !== "function")
					throw new Error(
						`markdownIt plugin "${configured}" must export a function.`,
					);
				return {
					plugin: plugin as (markdownIt: unknown, options?: unknown) => void,
				};
			}),
		);
		const lintOptions = {
			strings: { [filePath]: text },
			config: options.config,
			...(plugins.length
				? {
						markdownItFactory: () => {
							const markdownIt = new MarkdownIt();
							plugins.forEach((registration) => {
								registration.plugin(markdownIt, registration.options);
							});
							return markdownIt;
						},
					}
				: {}),
		};
		const result = await lint(
			lintOptions as unknown as Parameters<typeof lint>[0],
		);
		return result[filePath] ?? [];
	}
	return {
		async lintText(text, filePath) {
			const result = await errors(text, filePath);
			return {
				filePath,
				diagnostics: result.map((error) => diagnostic(error, text, filePath)),
			};
		},
		async fixText(text, filePath) {
			const result = await errors(text, filePath);
			const output = applyFixes(text, result);
			return {
				filePath,
				output,
				diagnostics: result.map((error) => diagnostic(error, text, filePath)),
				applied: result
					.filter((error) => error.fixInfo !== null)
					.map((error) => diagnostic(error, text, filePath)),
				remaining: [],
			};
		},
	};
}
