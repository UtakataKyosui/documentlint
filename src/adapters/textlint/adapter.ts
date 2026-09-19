import path from "node:path";
import type {
	TextlintKernelFilterRule,
	TextlintKernelPlugin,
	TextlintKernelRule,
} from "@textlint/kernel";
import { TextlintKernelDescriptor } from "@textlint/kernel";
import { moduleInterop } from "@textlint/module-interop";
import type {
	TextlintFilterRuleReporter,
	TextlintPluginCreator,
	TextlintRuleModule,
} from "@textlint/types";
import { createLinter } from "textlint";
import { UnsupportedConfigError } from "../../config/errors.js";
import type {
	ResolvedPresetRuleEntry,
	ResolvedRuleEntry,
	ResolvedTextlintrc,
	TextlintRuleOptions,
} from "../../config/textlintrc.js";
import {
	normalizeFixResult,
	normalizeResult,
} from "../../diagnostics/normalize.js";
import type { FixResult, LintResult } from "../../diagnostics/types.js";

export interface CreateTextlintAdapterOptions {
	readonly ignoreFilePath?: string;
	readonly cwd?: string;
}

export interface TextlintAdapter {
	lintText(text: string, filePath: string): Promise<LintResult>;
	fixText(text: string, filePath: string): Promise<FixResult>;
	lintFiles(filesOrGlobs: readonly string[]): Promise<LintResult[]>;
	fixFiles(filesOrGlobs: readonly string[]): Promise<FixResult[]>;
}

interface TextlintPresetModule {
	readonly rules: Readonly<Record<string, TextlintRuleModule>>;
	readonly rulesConfig?: Readonly<Record<string, unknown>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextlintPresetModule(value: unknown): value is TextlintPresetModule {
	return isPlainObject(value) && isPlainObject(value.rules);
}

async function importDefault<T>(resolvedPath: string): Promise<T> {
	const namespace = (await import(resolvedPath)) as { default: unknown };
	return moduleInterop(namespace.default) as T;
}

function resolvePresetRuleOptions(
	ruleKey: string,
	presetRules: readonly ResolvedPresetRuleEntry[] | undefined,
	rulesConfig: Readonly<Record<string, unknown>> | undefined,
): TextlintRuleOptions | boolean | undefined {
	const override = presetRules?.find(
		(candidate) => candidate.ruleId === ruleKey,
	);
	if (override !== undefined) {
		if (!override.enabled) {
			return false;
		}
		if (override.options !== undefined) {
			return override.options;
		}
	}
	if (rulesConfig !== undefined && ruleKey in rulesConfig) {
		return rulesConfig[ruleKey] as TextlintRuleOptions | boolean;
	}
	return undefined;
}

/** textlint が preset の子ルールに付ける ruleId を再現する。 */
function presetRuleId(presetId: string, ruleKey: string): string {
	const slashIndex = presetId.startsWith("@") ? presetId.indexOf("/") : -1;
	const scope = slashIndex === -1 ? "" : presetId.slice(0, slashIndex + 1);
	const bare = slashIndex === -1 ? presetId : presetId.slice(slashIndex + 1);
	const canonicalPresetName = bare
		.replace(/^textlint-rule-preset-/, "")
		.replace(/^preset-/, "");
	return `${scope}${canonicalPresetName}/${ruleKey}`;
}

async function expandPresetRules(
	entry: ResolvedRuleEntry,
	configPath: string,
): Promise<TextlintKernelRule[]> {
	const presetModule = await importDefault<unknown>(entry.module.resolvedPath);

	if (!isTextlintPresetModule(presetModule)) {
		throw new UnsupportedConfigError(
			configPath,
			`rules.${entry.ruleId}`,
			`Preset module "${entry.module.packageName}" must export an object with a "rules" object.`,
		);
	}

	const available = new Set(Object.keys(presetModule.rules));
	for (const presetRule of entry.presetRules ?? []) {
		if (!available.has(presetRule.ruleId)) {
			throw new UnsupportedConfigError(
				configPath,
				`rules.${entry.ruleId}.${presetRule.ruleId}`,
				`Preset "${entry.module.packageName}" has no rule named "${presetRule.ruleId}". Available rules: ${[...available].sort().join(", ")}.`,
			);
		}
	}

	return Object.entries(presetModule.rules).map(([ruleKey, rule]) => {
		const options = resolvePresetRuleOptions(
			ruleKey,
			entry.presetRules,
			presetModule.rulesConfig,
		);
		return {
			ruleId: presetRuleId(entry.ruleId, ruleKey),
			rule,
			...(options !== undefined ? { options } : {}),
		};
	});
}

async function buildRules(
	rc: ResolvedTextlintrc,
): Promise<TextlintKernelRule[]> {
	const rules: TextlintKernelRule[] = [];

	for (const entry of rc.rules) {
		if (entry.module.kind === "preset") {
			rules.push(...(await expandPresetRules(entry, rc.filePath)));
			continue;
		}

		const rule = await importDefault<TextlintRuleModule>(
			entry.module.resolvedPath,
		);
		rules.push({
			ruleId: entry.ruleId,
			rule,
			...(entry.options !== undefined ? { options: entry.options } : {}),
		});
	}

	return rules;
}

async function buildFilterRules(
	filters: readonly ResolvedRuleEntry[],
): Promise<TextlintKernelFilterRule[]> {
	return Promise.all(
		filters.map(async (entry) => {
			const rule = await importDefault<TextlintFilterRuleReporter>(
				entry.module.resolvedPath,
			);
			return {
				ruleId: entry.ruleId,
				rule,
				...(entry.options !== undefined ? { options: entry.options } : {}),
			};
		}),
	);
}

async function buildPlugins(
	plugins: readonly ResolvedRuleEntry[],
): Promise<TextlintKernelPlugin[]> {
	return Promise.all(
		plugins.map(async (entry) => {
			const plugin = await importDefault<TextlintPluginCreator>(
				entry.module.resolvedPath,
			);
			return {
				pluginId: entry.ruleId,
				plugin,
				...(entry.options !== undefined ? { options: entry.options } : {}),
			};
		}),
	);
}

async function buildDescriptor(
	rc: ResolvedTextlintrc,
): Promise<TextlintKernelDescriptor> {
	const [rules, filterRules, plugins] = await Promise.all([
		buildRules(rc),
		buildFilterRules(rc.filters),
		buildPlugins(rc.plugins),
	]);

	return new TextlintKernelDescriptor({
		rules,
		filterRules,
		plugins,
		configBaseDir: path.dirname(rc.filePath),
	});
}

export async function createTextlintAdapter(
	rc: ResolvedTextlintrc,
	options: CreateTextlintAdapterOptions = {},
): Promise<TextlintAdapter> {
	const descriptor = await buildDescriptor(rc);
	const linter = createLinter({
		descriptor,
		...(options.ignoreFilePath !== undefined
			? { ignoreFilePath: options.ignoreFilePath }
			: {}),
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
	});

	return {
		async lintText(text, filePath) {
			const result = await linter.lintText(text, filePath);
			return normalizeResult(result);
		},
		async fixText(text, filePath) {
			const result = await linter.fixText(text, filePath);
			return normalizeFixResult(result);
		},
		async lintFiles(filesOrGlobs) {
			const results = await linter.lintFiles([...filesOrGlobs]);
			return results.map(normalizeResult);
		},
		async fixFiles(filesOrGlobs) {
			const results = await linter.fixFiles([...filesOrGlobs]);
			return results.map(normalizeFixResult);
		},
	};
}
