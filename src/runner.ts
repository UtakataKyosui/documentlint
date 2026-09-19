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
import {
	DocumentlintPluginError,
	loadDocumentlintPlugins,
} from "./plugins/loader.js";
import type {
	DocumentlintPluginContext,
	DocumentlintPluginDiagnostic,
} from "./plugins/types.js";
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

function pluginDiagnostic(
	pluginId: string,
	diagnostic: DocumentlintPluginDiagnostic,
	text: string,
	filePath: string,
): Diagnostic {
	if (
		typeof diagnostic.ruleId !== "string" ||
		typeof diagnostic.message !== "string" ||
		(diagnostic.severity !== undefined &&
			!(["error", "warning", "info"] as const).includes(diagnostic.severity))
	)
		throw new DocumentlintPluginError(
			pluginId,
			"each diagnostic must contain string ruleId/message values and a supported severity.",
		);
	if (
		diagnostic.range.start < 0 ||
		diagnostic.range.end < diagnostic.range.start ||
		diagnostic.range.end > text.length
	)
		throw new DocumentlintPluginError(
			pluginId,
			`rule "${diagnostic.ruleId}" returned an invalid range ${diagnostic.range.start}:${diagnostic.range.end}.`,
		);
	return {
		engine: `plugin:${pluginId}`,
		ruleId: diagnostic.ruleId,
		message: diagnostic.message,
		severity: diagnostic.severity ?? "error",
		filePath,
		location: {
			start: position(text, diagnostic.range.start),
			end: position(text, diagnostic.range.end),
			range: diagnostic.range,
		},
	};
}

function assertPositionPreserving(
	pluginId: string,
	before: string,
	after: string,
): void {
	if (before.length !== after.length)
		throw new DocumentlintPluginError(
			pluginId,
			`preprocess must preserve source length (received ${after.length}, expected ${before.length}).`,
		);
	for (let index = 0; index < before.length; index += 1) {
		const beforeCharacter = before[index];
		const afterCharacter = after[index];
		if (
			(beforeCharacter === "\n" ||
				beforeCharacter === "\r" ||
				afterCharacter === "\n" ||
				afterCharacter === "\r") &&
			afterCharacter !== beforeCharacter
		)
			throw new DocumentlintPluginError(
				pluginId,
				`preprocess must preserve the line break at offset ${index}.`,
			);
	}
}

export async function runDocumentlint(
	text: string,
	filePath: string,
	config: DocumentlintConfig,
	fix = false,
	configPath = "documentlint.json",
): Promise<RunResult> {
	const configDirectory = path.dirname(path.resolve(configPath));
	const [syntaxPlugins, checkPlugins] = await Promise.all([
		loadDocumentlintPlugins(config.extensionPlugins?.syntax, configPath),
		loadDocumentlintPlugins(config.extensionPlugins?.checks, configPath),
	]);
	for (const loaded of syntaxPlugins)
		if (
			loaded.plugin.preprocess === undefined &&
			loaded.plugin.markdownItPlugin === undefined
		)
			throw new DocumentlintPluginError(
				loaded.id,
				"a markdown.syntax plugin must expose preprocess or markdownItPlugin.",
			);
	for (const loaded of checkPlugins)
		if (loaded.plugin.lint === undefined)
			throw new DocumentlintPluginError(
				loaded.id,
				"a markdown.checks plugin must expose lint.",
			);
	let input = config.zenn?.enabled ? maskZennSyntax(text) : text;
	for (const loaded of syntaxPlugins) {
		if (loaded.plugin.preprocess === undefined) continue;
		const context: DocumentlintPluginContext = {
			filePath,
			configPath,
			source: text,
			text: input,
		};
		const processed = await loaded.plugin.preprocess(context, loaded.options);
		assertPositionPreserving(loaded.id, input, processed);
		input = processed;
	}
	type TaskResult = {
		readonly diagnostics: readonly Diagnostic[];
		readonly output?: string;
		readonly engine: string;
	};
	const tasks: { engine: string; promise: Promise<TaskResult> }[] = [];
	if (config.textlint) {
		const textlintConfigPath = config.textlint.config
			? path.resolve(configDirectory, config.textlint.config)
			: path.resolve(configPath);
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
		const pluginRegistrations = syntaxPlugins.flatMap((loaded) =>
			loaded.plugin.markdownItPlugin === undefined
				? []
				: [
						{
							plugin: loaded.plugin.markdownItPlugin,
							options: loaded.options,
						},
					],
		);
		const adapter = createMarkdownlintAdapter({
			moduleBaseDirectory: configDirectory,
			...(config.markdownlint.config
				? { config: config.markdownlint.config }
				: {}),
			...(config.markdownlint.markdownItPlugins ||
			config.extensionPlugins?.markdownIt ||
			pluginRegistrations.length
				? {
						markdownItPlugins: [
							...(config.markdownlint.markdownItPlugins ?? []),
							...(config.extensionPlugins?.markdownIt ?? []),
							...pluginRegistrations,
						],
					}
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
	for (const loaded of checkPlugins) {
		if (loaded.plugin.lint === undefined) continue;
		const context: DocumentlintPluginContext = {
			filePath,
			configPath,
			source: text,
			text: input,
		};
		tasks.push({
			engine: `plugin:${loaded.id}`,
			promise: Promise.resolve(
				loaded.plugin.lint(context, loaded.options),
			).then((diagnostics) => ({
				engine: `plugin:${loaded.id}`,
				diagnostics: diagnostics.map((diagnostic) =>
					pluginDiagnostic(loaded.id, diagnostic, text, filePath),
				),
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
