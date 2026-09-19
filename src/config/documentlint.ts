import fs from "node:fs";
import path from "node:path";
import { type ParseErrorCode, parse, printParseErrorCode } from "jsonc-parser";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { DocumentlintPluginSettings } from "../plugins/loader.js";

export interface DocumentlintConfig {
	readonly version: 1;
	readonly files?: readonly string[];
	readonly ignores?: readonly string[];
	readonly textlint?: {
		readonly config?: string;
		readonly rules?: Record<string, unknown>;
		readonly filters?: Record<string, unknown>;
		readonly plugins?: Record<string, unknown>;
	};
	readonly markdownlint?: {
		readonly config?: Record<string, unknown>;
		readonly ignores?: readonly string[];
		readonly markdownItPlugins?: readonly string[];
	};
	readonly prh?: {
		readonly dictionary?: Record<string, unknown>;
		readonly dictionaries?: readonly string[];
	};
	readonly zenn?: { readonly enabled: boolean };
	readonly extensionPlugins?: {
		readonly syntax?: DocumentlintPluginSettings;
		readonly checks?: DocumentlintPluginSettings;
		readonly markdownIt?: readonly string[];
	};
}

export interface ConfigLocation {
	readonly line: number;
	readonly column: number;
	readonly offset: number;
}

export class DocumentlintConfigError extends Error {
	constructor(
		readonly filePath: string,
		readonly location: ConfigLocation,
		readonly suggestion: string,
		reason: string,
	) {
		super(
			`Invalid documentlint configuration in "${filePath}" at ${location.line}:${location.column}: ${reason}. ${suggestion}`,
		);
		this.name = "DocumentlintConfigError";
	}
}

/** The packaged JSON file is the single source of truth for editor and API consumers. */
export const documentlintConfigSchema = JSON.parse(
	fs.readFileSync(
		new URL("../../schema/documentlint.schema.json", import.meta.url),
		"utf8",
	),
) as Readonly<Record<string, unknown>>;

function locationOf(text: string, offset: number): ConfigLocation {
	const before = text.slice(0, offset);
	return {
		offset,
		line: before.split("\n").length,
		column: offset - before.lastIndexOf("\n"),
	};
}

function object(
	value: unknown,
	filePath: string,
	text: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DocumentlintConfigError(
			filePath,
			locationOf(text, 0),
			"Use a JSON object as the configuration root.",
			"Configuration root must be an object",
		);
	}
	return value as Record<string, unknown>;
}

function strings(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function optionalObject(
	value: unknown,
): value is Record<string, unknown> | undefined {
	return (
		value === undefined ||
		(typeof value === "object" && value !== null && !Array.isArray(value))
	);
}

function fail(
	filePath: string,
	text: string,
	key: string,
	suggestion: string,
	reason: string,
): never {
	throw new DocumentlintConfigError(
		filePath,
		locationOf(text, Math.max(0, text.indexOf(`"${key}"`))),
		suggestion,
		reason,
	);
}

function assertKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	filePath: string,
	text: string,
	location: string,
): void {
	const accepted = new Set(allowed);
	for (const key of Object.keys(value))
		if (!accepted.has(key))
			fail(
				filePath,
				text,
				key,
				`Remove it or move it under a supported ${location} property.`,
				`Unknown property "${location}.${key}"`,
			);
}

function pluginSettings(
	value: unknown,
	filePath: string,
	text: string,
	location: string,
): DocumentlintPluginSettings | undefined {
	if (value === undefined) return undefined;
	if (!optionalObject(value))
		fail(
			filePath,
			text,
			location.split(".").at(-1) ?? location,
			"Use an object that maps plugin names to true, false, or options.",
			`${location} must be an object`,
		);
	for (const [name, configured] of Object.entries(value))
		if (
			configured !== true &&
			configured !== false &&
			!optionalObject(configured)
		)
			fail(
				filePath,
				text,
				name,
				"Use true, false, or an options object.",
				`${location}.${name} has an invalid value`,
			);
	return value as DocumentlintPluginSettings;
}

function parseExtendedTextlintrc(
	root: Record<string, unknown>,
	filePath: string,
	text: string,
): DocumentlintConfig {
	assertKeys(
		root,
		["$schema", "rules", "filters", "plugins", "documentlint"],
		filePath,
		text,
		"root",
	);
	for (const key of ["rules", "filters", "plugins"] as const)
		if (!optionalObject(root[key]))
			fail(
				filePath,
				text,
				key,
				`Use an object for "${key}".`,
				`${key} must be an object`,
			);
	const configuredDocumentlint = root.documentlint;
	if (!optionalObject(configuredDocumentlint))
		fail(
			filePath,
			text,
			"documentlint",
			'Add "documentlint": { "version": 1 }.',
			"documentlint must be an object",
		);
	const rawDocumentlint = configuredDocumentlint ?? { version: 1 };
	assertKeys(
		rawDocumentlint,
		["version", "files", "ignores", "prh", "markdown"],
		filePath,
		text,
		"documentlint",
	);
	if (rawDocumentlint.version !== 1)
		fail(
			filePath,
			text,
			"version",
			'Set "documentlint.version" to 1.',
			"Only configuration version 1 is supported",
		);
	for (const key of ["files", "ignores"] as const)
		if (rawDocumentlint[key] !== undefined && !strings(rawDocumentlint[key]))
			fail(
				filePath,
				text,
				key,
				"Use an array of glob strings.",
				`documentlint.${key} must be an array of strings`,
			);
	const prh = rawDocumentlint.prh;
	if (!optionalObject(prh))
		fail(filePath, text, "prh", "Use a prh object.", "prh must be an object");
	if (prh !== undefined) {
		assertKeys(prh, ["dictionary", "dictionaries"], filePath, text, "prh");
		if (!optionalObject(prh.dictionary))
			fail(
				filePath,
				text,
				"dictionary",
				"Use an inline prh dictionary object.",
				"prh.dictionary must be an object",
			);
		if (prh.dictionary !== undefined && prh.dictionaries !== undefined)
			fail(
				filePath,
				text,
				"prh",
				"Choose prh.dictionary or prh.dictionaries.",
				"inline and external dictionaries cannot be combined implicitly",
			);
		if (prh.dictionaries !== undefined && !strings(prh.dictionaries))
			fail(
				filePath,
				text,
				"dictionaries",
				"Use an array of dictionary file paths.",
				"prh.dictionaries must be an array of strings",
			);
	}
	const markdown = rawDocumentlint.markdown;
	if (!optionalObject(markdown))
		fail(
			filePath,
			text,
			"markdown",
			"Use a markdown object.",
			"markdown must be an object",
		);
	let zenn: { enabled: boolean } | undefined;
	let markdownlint: DocumentlintConfig["markdownlint"];
	let markdownItPlugins: readonly string[] | undefined;
	let syntaxPlugins: DocumentlintPluginSettings | undefined;
	let checkPlugins: DocumentlintPluginSettings | undefined;
	if (markdown !== undefined) {
		assertKeys(markdown, ["syntax", "checks"], filePath, text, "markdown");
		const syntax = markdown.syntax;
		if (!optionalObject(syntax))
			fail(
				filePath,
				text,
				"syntax",
				"Use a markdown.syntax object.",
				"markdown.syntax must be an object",
			);
		if (syntax !== undefined) {
			assertKeys(
				syntax,
				["zenn", "plugins", "markdownItPlugins"],
				filePath,
				text,
				"markdown.syntax",
			);
			if (syntax.zenn !== undefined && typeof syntax.zenn !== "boolean")
				fail(
					filePath,
					text,
					"zenn",
					"Use true or false.",
					"markdown.syntax.zenn must be a boolean",
				);
			if (
				syntax.markdownItPlugins !== undefined &&
				!strings(syntax.markdownItPlugins)
			)
				fail(
					filePath,
					text,
					"markdownItPlugins",
					"Use an array of module names.",
					"markdown.syntax.markdownItPlugins must be an array of strings",
				);
			zenn = syntax.zenn === true ? { enabled: true } : undefined;
			syntaxPlugins = pluginSettings(
				syntax.plugins,
				filePath,
				text,
				"markdown.syntax.plugins",
			);
			if (syntax.markdownItPlugins !== undefined)
				markdownItPlugins = syntax.markdownItPlugins as readonly string[];
		}
		const checks = markdown.checks;
		if (!optionalObject(checks))
			fail(
				filePath,
				text,
				"checks",
				"Use a markdown.checks object.",
				"markdown.checks must be an object",
			);
		if (checks !== undefined) {
			assertKeys(
				checks,
				["markdownlint", "plugins"],
				filePath,
				text,
				"markdown.checks",
			);
			if (!optionalObject(checks.markdownlint))
				fail(
					filePath,
					text,
					"markdownlint",
					"Use a markdownlint rule object.",
					"markdown.checks.markdownlint must be an object",
				);
			if (checks.markdownlint !== undefined)
				markdownlint = {
					...markdownlint,
					config: checks.markdownlint,
				};
			checkPlugins = pluginSettings(
				checks.plugins,
				filePath,
				text,
				"markdown.checks.plugins",
			);
		}
	}
	return {
		version: 1,
		...(rawDocumentlint.files !== undefined
			? { files: rawDocumentlint.files as readonly string[] }
			: {}),
		...(rawDocumentlint.ignores !== undefined
			? { ignores: rawDocumentlint.ignores as readonly string[] }
			: {}),
		...(root.rules !== undefined ||
		root.filters !== undefined ||
		root.plugins !== undefined
			? {
					textlint: {
						...(root.rules !== undefined
							? { rules: root.rules as Record<string, unknown> }
							: {}),
						...(root.filters !== undefined
							? { filters: root.filters as Record<string, unknown> }
							: {}),
						...(root.plugins !== undefined
							? { plugins: root.plugins as Record<string, unknown> }
							: {}),
					},
				}
			: {}),
		...(prh !== undefined
			? { prh: prh as NonNullable<DocumentlintConfig["prh"]> }
			: {}),
		...(markdownlint !== undefined ? { markdownlint } : {}),
		...(zenn !== undefined ? { zenn } : {}),
		...(syntaxPlugins !== undefined ||
		checkPlugins !== undefined ||
		markdownItPlugins !== undefined
			? {
					extensionPlugins: {
						...(syntaxPlugins !== undefined ? { syntax: syntaxPlugins } : {}),
						...(checkPlugins !== undefined ? { checks: checkPlugins } : {}),
						...(markdownItPlugins !== undefined
							? { markdownIt: markdownItPlugins }
							: {}),
					},
				}
			: {}),
	};
}

export function parseDocumentlintConfig(
	text: string,
	filePath = "documentlint.json",
): DocumentlintConfig {
	const errors: { error: ParseErrorCode; offset: number; length: number }[] =
		[];
	const raw = parse(text, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	});
	if (errors.length > 0) {
		const error = errors[0];
		if (error === undefined)
			throw new Error("JSONC parser returned no error details.");
		throw new DocumentlintConfigError(
			filePath,
			locationOf(text, error.offset),
			"Fix the JSONC syntax at this location.",
			printParseErrorCode(error.error),
		);
	}
	const config = object(raw, filePath, text);
	if (config.version === undefined)
		return parseExtendedTextlintrc(config, filePath, text);
	const allowed = new Set([
		"$schema",
		"version",
		"files",
		"ignores",
		"textlint",
		"markdownlint",
		"prh",
		"zenn",
	]);
	for (const key of Object.keys(config)) {
		if (!allowed.has(key))
			throw new DocumentlintConfigError(
				filePath,
				locationOf(text, text.indexOf(`"${key}"`)),
				"Remove it or move it under a supported engine.",
				`Unknown property "${key}"`,
			);
	}
	if (config.version !== 1)
		throw new DocumentlintConfigError(
			filePath,
			locationOf(text, text.indexOf("version")),
			'Set "version" to 1.',
			"Only configuration version 1 is supported",
		);
	if (config.files !== undefined && !strings(config.files))
		throw new DocumentlintConfigError(
			filePath,
			locationOf(text, text.indexOf("files")),
			"Use an array of glob strings.",
			"files must be an array of strings",
		);
	if (config.ignores !== undefined && !strings(config.ignores))
		throw new DocumentlintConfigError(
			filePath,
			locationOf(text, text.indexOf("ignores")),
			"Use an array of glob strings.",
			"ignores must be an array of strings",
		);
	for (const key of ["textlint", "markdownlint", "prh", "zenn"] as const)
		if (!optionalObject(config[key]))
			throw new DocumentlintConfigError(
				filePath,
				locationOf(text, text.indexOf(key)),
				`Use an object for "${key}".`,
				`${key} must be an object`,
			);
	const textlint = config.textlint as Record<string, unknown> | undefined;
	if (
		textlint?.config !== undefined &&
		["rules", "filters", "plugins"].some((key) => textlint[key] !== undefined)
	)
		throw new DocumentlintConfigError(
			filePath,
			locationOf(text, text.indexOf("textlint")),
			"Choose textlint.config or inline rules/filters/plugins.",
			"textlint legacy config conflicts with inline configuration",
		);
	const prh = config.prh as Record<string, unknown> | undefined;
	if (prh?.dictionary !== undefined && prh.dictionaries !== undefined)
		throw new DocumentlintConfigError(
			filePath,
			locationOf(text, text.indexOf("prh")),
			"Choose prh.dictionary or prh.dictionaries.",
			"inline and external dictionaries cannot be combined implicitly",
		);
	return config as unknown as DocumentlintConfig;
}

export function loadDocumentlintConfig(configPath: string): DocumentlintConfig {
	return parseDocumentlintConfig(
		fs.readFileSync(configPath, "utf8"),
		configPath,
	);
}

export interface ImportResult {
	readonly config?: DocumentlintConfig;
	readonly warnings: readonly string[];
	readonly diff: string;
}

function readJsonc(filePath: string): Record<string, unknown> {
	const text = fs.readFileSync(filePath, "utf8");
	const errors: { error: ParseErrorCode; offset: number; length: number }[] =
		[];
	const value = parse(text, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	});
	if (errors.length) {
		const error = errors[0];
		if (error === undefined)
			throw new Error("JSONC parser returned no error details.");
		throw new DocumentlintConfigError(
			filePath,
			locationOf(text, error.offset),
			"Fix the JSONC syntax.",
			printParseErrorCode(error.error),
		);
	}
	return object(value, filePath, text);
}

/** Converts one legacy file without writing it; callers decide whether to persist the shown diff. */
export function importLegacyConfig(filePath: string): ImportResult {
	const base = path.basename(filePath);
	const warnings: string[] = [];
	let config: DocumentlintConfig;
	if (base === ".textlintrc.json") {
		config = { version: 1, textlint: readJsonc(filePath) };
	} else if (base === ".markdownlint.json") {
		config = { version: 1, markdownlint: { config: readJsonc(filePath) } };
	} else if (base === ".markdownlint-cli2.jsonc") {
		const source = readJsonc(filePath);
		if (
			source.customRules !== undefined ||
			source.outputFormatters !== undefined
		)
			throw new DocumentlintConfigError(
				filePath,
				locationOf(fs.readFileSync(filePath, "utf8"), 0),
				"Remove dynamic modules before importing.",
				"customRules and outputFormatters cannot be converted safely",
			);
		const markdownItPlugins =
			Array.isArray(source.markdownItPlugins) &&
			source.markdownItPlugins.every((item) => typeof item === "string")
				? source.markdownItPlugins
				: undefined;
		if (
			source.markdownItPlugins !== undefined &&
			markdownItPlugins === undefined
		)
			throw new DocumentlintConfigError(
				filePath,
				locationOf(fs.readFileSync(filePath, "utf8"), 0),
				"Use plugin module names only.",
				"Inline markdownItPlugins cannot be converted safely",
			);
		if (source.config !== undefined && !optionalObject(source.config))
			throw new DocumentlintConfigError(
				filePath,
				locationOf(fs.readFileSync(filePath, "utf8"), 0),
				"Use an object for markdownlint config.",
				"markdownlint config must be an object",
			);
		const markdownConfig = source.config as Record<string, unknown> | undefined;
		config = {
			version: 1,
			...(Array.isArray(source.globs)
				? { files: source.globs as string[] }
				: {}),
			markdownlint: {
				...(markdownConfig !== undefined ? { config: markdownConfig } : {}),
				...(markdownItPlugins ? { markdownItPlugins } : {}),
				...(Array.isArray(source.ignores)
					? { ignores: source.ignores as string[] }
					: {}),
			},
		};
	} else if (base === "prh.yml" || base === "prh.yaml") {
		const text = fs.readFileSync(filePath, "utf8");
		let dictionary: unknown;
		try {
			dictionary = parseYaml(text);
		} catch (error) {
			throw new DocumentlintConfigError(
				filePath,
				locationOf(text, 0),
				"Fix the YAML syntax.",
				error instanceof YAMLParseError ? error.message : "Invalid YAML",
			);
		}
		const parsed = object(dictionary, filePath, text);
		if (parsed.version !== 1)
			throw new DocumentlintConfigError(
				filePath,
				locationOf(text, 0),
				"Use a prh dictionary with version: 1.",
				"Unsupported prh dictionary version",
			);
		config = { version: 1, prh: { dictionary: parsed } };
	} else
		throw new DocumentlintConfigError(
			filePath,
			{ line: 1, column: 1, offset: 0 },
			"Use .textlintrc.json, .markdownlint.json, .markdownlint-cli2.jsonc, or prh.yml.",
			"Unsupported legacy configuration file",
		);
	return { config, warnings, diff: `${JSON.stringify(config, null, 2)}\n` };
}
