import fs from "node:fs";
import path from "node:path";
import { UnsupportedConfigError } from "./errors.js";
import type { ModuleKind, ResolvedModule } from "./resolver.js";
import { resolveModule } from "./resolver.js";

export type TextlintRuleOptions = Record<string, unknown>;

export interface ResolvedPresetRuleEntry {
	readonly ruleId: string;
	/** false を明示した場合と未指定の場合を区別する。未指定なら preset の rulesConfig が既定値を決める。 */
	readonly enabled: boolean;
	readonly options?: TextlintRuleOptions;
}

export interface ResolvedRuleEntry {
	readonly ruleId: string;
	readonly module: ResolvedModule;
	readonly options?: TextlintRuleOptions;
	readonly presetRules?: readonly ResolvedPresetRuleEntry[];
}

export interface ResolvedTextlintrc {
	readonly filePath: string;
	readonly rules: readonly ResolvedRuleEntry[];
	readonly filters: readonly ResolvedRuleEntry[];
	readonly plugins: readonly ResolvedRuleEntry[];
}

const SUPPORTED_EXTENSION = ".json";
const TOP_LEVEL_KEYS = new Set(["rules", "filters", "plugins"]);

/** スコープ付きの完全名（@scope/textlint-rule-preset-foo）でも preset と判定する。 */
function isPresetName(name: string): boolean {
	const bare = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
	return bare.startsWith("preset-") || bare.startsWith("textlint-rule-preset-");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "an array";
	}
	return `a ${typeof value}`;
}

function assertSupportedExtension(configPath: string): void {
	const ext = path.extname(configPath);
	if (ext === SUPPORTED_EXTENSION) {
		return;
	}
	throw new UnsupportedConfigError(
		configPath,
		"(file)",
		`Unsupported config file extension "${ext || "(none)"}". Only .textlintrc.json is supported; rewrite the configuration as JSON.`,
	);
}

function buildEntry(
	ruleId: string,
	moduleInfo: ResolvedModule,
	options: TextlintRuleOptions | undefined,
	presetRules: readonly ResolvedPresetRuleEntry[] | undefined,
): ResolvedRuleEntry {
	return {
		ruleId,
		module: moduleInfo,
		...(options !== undefined ? { options } : {}),
		...(presetRules !== undefined ? { presetRules } : {}),
	};
}

function resolvePresetRules(
	section: Record<string, unknown>,
	parentLocation: string,
	configPath: string,
): readonly ResolvedPresetRuleEntry[] {
	const presetRules: ResolvedPresetRuleEntry[] = [];

	for (const [ruleId, value] of Object.entries(section)) {
		const location = `${parentLocation}.${ruleId}`;

		if (value === false) {
			presetRules.push({ ruleId, enabled: false });
			continue;
		}
		if (value === true) {
			presetRules.push({ ruleId, enabled: true });
			continue;
		}
		if (isPlainObject(value)) {
			presetRules.push({ ruleId, enabled: true, options: value });
			continue;
		}

		throw new UnsupportedConfigError(
			configPath,
			location,
			`The value for "${ruleId}" must be true, false, or an options object; received ${describeType(value)}.`,
		);
	}

	return presetRules;
}

function resolveRuleSection(
	section: unknown,
	sectionName: string,
	configPath: string,
	baseDir: string,
): readonly ResolvedRuleEntry[] {
	if (section === undefined) {
		return [];
	}
	if (!isPlainObject(section)) {
		throw new UnsupportedConfigError(
			configPath,
			sectionName,
			`"${sectionName}" must be an object mapping rule names to true, false, or an options object.`,
		);
	}

	const entries: ResolvedRuleEntry[] = [];

	for (const [name, value] of Object.entries(section)) {
		const location = `${sectionName}.${name}`;

		if (value === false) {
			continue;
		}

		const isPreset = isPresetName(name);
		const kind: ModuleKind = isPreset ? "preset" : "rule";

		if (value === true) {
			entries.push(
				buildEntry(
					name,
					resolveModule(kind, name, baseDir),
					undefined,
					undefined,
				),
			);
			continue;
		}

		if (isPlainObject(value)) {
			if (!isPreset) {
				entries.push(
					buildEntry(
						name,
						resolveModule(kind, name, baseDir),
						value,
						undefined,
					),
				);
				continue;
			}

			const presetModule = resolveModule(kind, name, baseDir);
			const presetRules = resolvePresetRules(value, location, configPath);
			entries.push(buildEntry(name, presetModule, undefined, presetRules));
			continue;
		}

		throw new UnsupportedConfigError(
			configPath,
			location,
			`The value for "${name}" must be true, false, or an options object; received ${describeType(value)}.`,
		);
	}

	return entries;
}

function resolveSimpleSection(
	section: unknown,
	kind: "filter" | "plugin",
	sectionName: string,
	configPath: string,
	baseDir: string,
): readonly ResolvedRuleEntry[] {
	if (section === undefined) {
		return [];
	}
	if (!isPlainObject(section)) {
		throw new UnsupportedConfigError(
			configPath,
			sectionName,
			`"${sectionName}" must be an object mapping names to true, false, or an options object.`,
		);
	}

	const entries: ResolvedRuleEntry[] = [];

	for (const [name, value] of Object.entries(section)) {
		const location = `${sectionName}.${name}`;

		if (value === false) {
			continue;
		}
		if (value === true) {
			entries.push(
				buildEntry(
					name,
					resolveModule(kind, name, baseDir),
					undefined,
					undefined,
				),
			);
			continue;
		}
		if (isPlainObject(value)) {
			entries.push(
				buildEntry(name, resolveModule(kind, name, baseDir), value, undefined),
			);
			continue;
		}

		throw new UnsupportedConfigError(
			configPath,
			location,
			`The value for "${name}" must be true, false, or an options object; received ${describeType(value)}.`,
		);
	}

	return entries;
}

export function resolveTextlintrcObject(
	raw: unknown,
	configPath: string,
): ResolvedTextlintrc {
	if (!isPlainObject(raw)) {
		throw new UnsupportedConfigError(
			configPath,
			"(file)",
			"The configuration root must be a JSON object.",
		);
	}

	for (const key of Object.keys(raw)) {
		if (!TOP_LEVEL_KEYS.has(key)) {
			throw new UnsupportedConfigError(
				configPath,
				key,
				`Unknown top-level key "${key}". Only "rules", "filters", and "plugins" are supported.`,
			);
		}
	}

	const baseDir = path.dirname(configPath);

	return {
		filePath: configPath,
		rules: resolveRuleSection(raw.rules, "rules", configPath, baseDir),
		filters: resolveSimpleSection(
			raw.filters,
			"filter",
			"filters",
			configPath,
			baseDir,
		),
		plugins: resolveSimpleSection(
			raw.plugins,
			"plugin",
			"plugins",
			configPath,
			baseDir,
		),
	};
}

export function resolveTextlintrc(configPath: string): ResolvedTextlintrc {
	assertSupportedExtension(configPath);
	return resolveTextlintrcObject(
		JSON.parse(fs.readFileSync(configPath, "utf8")),
		configPath,
	);
}
