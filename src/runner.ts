import path from "node:path";
import { createMarkdownlintAdapter } from "./adapters/markdownlint/adapter.js";
import {
	createPrhAdapter,
	createPrhAdapterFromFiles,
} from "./adapters/prh/adapter.js";
import { createTextlintAdapter } from "./adapters/textlint/adapter.js";
import type { DocumentlintConfig } from "./config/documentlint.js";
import {
	resolveTextlintrc,
	resolveTextlintrcObject,
} from "./config/textlintrc.js";
import type { Diagnostic, FixResult, LintResult } from "./diagnostics/types.js";
import { maskZennSyntax } from "./zenn/mask.js";

export interface RunResult {
	readonly filePath: string;
	readonly output: string;
	readonly diagnostics: readonly Diagnostic[];
	readonly errors: readonly { engine: string; message: string }[];
}

function compare(a: Diagnostic, b: Diagnostic): number {
	return (
		a.filePath.localeCompare(b.filePath) ||
		a.location.range.start - b.location.range.start ||
		a.engine.localeCompare(b.engine) ||
		a.ruleId.localeCompare(b.ruleId) ||
		a.message.localeCompare(b.message)
	);
}
function isFixResult(value: LintResult | FixResult): value is FixResult {
	return "output" in value;
}

export async function runDocumentlint(
	text: string,
	filePath: string,
	config: DocumentlintConfig,
	fix = false,
	configPath = "documentlint.json",
): Promise<RunResult> {
	const input = config.zenn?.enabled ? maskZennSyntax(text) : text;
	const configDirectory = path.dirname(path.resolve(configPath));
	type TaskResult = {
		readonly diagnostics: readonly Diagnostic[];
		readonly output?: string;
		readonly engine: string;
	};
	const tasks: { engine: string; promise: Promise<TaskResult> }[] = [];
	if (config.textlint) {
		const textlintConfigPath = config.textlint.config
			? path.resolve(configDirectory, config.textlint.config)
			: path.resolve(configDirectory, "documentlint.json");
		const rc = config.textlint.config
			? resolveTextlintrc(textlintConfigPath)
			: resolveTextlintrcObject(
					{
						rules: config.textlint.rules,
						filters: config.textlint.filters,
						plugins: config.textlint.plugins,
					},
					textlintConfigPath,
				);
		const adapter = await createTextlintAdapter(rc);
		tasks.push({
			engine: "textlint",
			promise: (fix
				? adapter.fixText(input, filePath)
				: adapter.lintText(input, filePath)
			).then((result) => ({
				diagnostics: result.diagnostics,
				...(isFixResult(result) ? { output: result.output } : {}),
				engine: "textlint",
			})),
		});
	}
	if (config.markdownlint) {
		const adapter = createMarkdownlintAdapter({
			...(config.markdownlint.config
				? { config: config.markdownlint.config }
				: {}),
			...(config.markdownlint.markdownItPlugins
				? { markdownItPlugins: config.markdownlint.markdownItPlugins }
				: {}),
		});
		tasks.push({
			engine: "markdownlint",
			promise: (fix
				? adapter.fixText(input, filePath)
				: adapter.lintText(input, filePath)
			).then((result) => ({
				diagnostics: result.diagnostics,
				...(isFixResult(result) ? { output: result.output } : {}),
				engine: "markdownlint",
			})),
		});
	}
	if (config.prh?.dictionary) {
		const adapter = createPrhAdapter(config.prh.dictionary, filePath);
		tasks.push({
			engine: "prh",
			promise: Promise.resolve(
				fix
					? adapter.fixText(input, filePath)
					: adapter.lintText(input, filePath),
			).then((result) => ({
				diagnostics: result.diagnostics,
				...(isFixResult(result) ? { output: result.output } : {}),
				engine: "prh",
			})),
		});
	}
	if (config.prh?.dictionaries) {
		const adapter = createPrhAdapterFromFiles(
			config.prh.dictionaries.map((file) =>
				path.resolve(configDirectory, file),
			),
		);
		tasks.push({
			engine: "prh",
			promise: Promise.resolve(
				fix
					? adapter.fixText(input, filePath)
					: adapter.lintText(input, filePath),
			).then((result) => ({
				diagnostics: result.diagnostics,
				...(isFixResult(result) ? { output: result.output } : {}),
				engine: "prh",
			})),
		});
	}
	const settled = await Promise.allSettled(tasks.map((task) => task.promise));
	const diagnostics: Diagnostic[] = [];
	const errors: { engine: string; message: string }[] = [];
	let output = text;
	settled.forEach((result, index) => {
		if (result.status === "rejected")
			errors.push({
				engine: tasks[index]?.engine ?? "unknown",
				message:
					result.reason instanceof Error
						? result.reason.message
						: String(result.reason),
			});
		else {
			diagnostics.push(...result.value.diagnostics);
			if (
				fix &&
				result.value.output !== undefined &&
				result.value.output !== input
			)
				output = result.value.output;
		}
	});
	return { filePath, output, diagnostics: diagnostics.sort(compare), errors };
}
