import fs from "node:fs";
import path from "node:path";
import { type ParseErrorCode, parse, printParseErrorCode } from "jsonc-parser";
import { parse as parseYaml, YAMLParseError } from "yaml";

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

export const documentlintConfigSchema = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://documentlint.dev/schema.json",
	type: "object",
	required: ["version"],
	additionalProperties: false,
	properties: {
		version: { const: 1 },
		files: { type: "array", items: { type: "string" } },
		ignores: { type: "array", items: { type: "string" } },
		textlint: { type: "object" },
		markdownlint: { type: "object" },
		prh: { type: "object" },
		zenn: {
			type: "object",
			properties: { enabled: { type: "boolean" } },
			required: ["enabled"],
			additionalProperties: false,
		},
	},
} as const;

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
