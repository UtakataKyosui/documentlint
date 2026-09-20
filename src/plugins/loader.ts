import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { moduleInterop } from "@textlint/module-interop";
import type {
	DocumentlintPlugin,
	DocumentlintPluginExport,
	DocumentlintPluginOptions,
} from "./types.js";

export type DocumentlintPluginSettings = Readonly<
	Record<string, boolean | DocumentlintPluginOptions>
>;

export interface LoadedDocumentlintPlugin {
	readonly id: string;
	readonly moduleName: string;
	readonly resolvedPath: string;
	readonly options: DocumentlintPluginOptions;
	readonly plugin: DocumentlintPlugin;
}

export class DocumentlintPluginError extends Error {
	constructor(
		readonly pluginId: string,
		message: string,
	) {
		super(`Invalid documentlint plugin "${pluginId}": ${message}`);
		this.name = "DocumentlintPluginError";
	}
}

function candidates(
	specifier: string,
	baseDirectory: string,
): readonly string[] {
	if (specifier.startsWith(".") || path.isAbsolute(specifier))
		return [path.resolve(baseDirectory, specifier)];
	if (specifier.startsWith("@")) {
		const slash = specifier.indexOf("/");
		if (slash !== -1) {
			const scope = specifier.slice(0, slash);
			const name = specifier.slice(slash + 1);
			if (name.startsWith("documentlint-plugin-")) return [specifier];
			return [`${scope}/documentlint-plugin-${name}`, specifier];
		}
	}
	if (specifier.startsWith("documentlint-plugin-")) return [specifier];
	return [`documentlint-plugin-${specifier}`, specifier];
}

function resolvePlugin(specifier: string, baseDirectory: string): string {
	const requireFromConfig = createRequire(path.join(baseDirectory, "noop.cjs"));
	const attempted = candidates(specifier, baseDirectory);
	for (const candidate of attempted) {
		try {
			return requireFromConfig.resolve(candidate);
		} catch {}
	}
	throw new DocumentlintPluginError(
		specifier,
		`module could not be resolved. Tried: ${attempted.join(", ")}`,
	);
}

function isPlugin(value: unknown): value is DocumentlintPlugin {
	return (
		typeof value === "object" &&
		value !== null &&
		"apiVersion" in value &&
		value.apiVersion === 1
	);
}

export async function loadDocumentlintPlugins(
	settings: DocumentlintPluginSettings | undefined,
	configPath: string,
): Promise<readonly LoadedDocumentlintPlugin[]> {
	if (settings === undefined) return [];
	const baseDirectory = path.dirname(path.resolve(configPath));
	const loaded: LoadedDocumentlintPlugin[] = [];
	for (const [id, configured] of Object.entries(settings)) {
		if (configured === false) continue;
		const options = configured === true ? {} : configured;
		const resolvedFile = resolvePlugin(id, baseDirectory);
		const namespace = (await import(pathToFileURL(resolvedFile).href)) as {
			default: unknown;
		};
		const exported = moduleInterop(
			namespace.default,
		) as DocumentlintPluginExport;
		const plugin =
			typeof exported === "function" ? await exported(options) : exported;
		if (!isPlugin(plugin))
			throw new DocumentlintPluginError(
				id,
				'its default export must have "apiVersion: 1" or be a factory that returns one.',
			);
		if (
			plugin.preprocess === undefined &&
			plugin.markdownItPlugin === undefined &&
			plugin.lint === undefined
		)
			throw new DocumentlintPluginError(
				id,
				"it must expose preprocess, markdownItPlugin, or lint.",
			);
		loaded.push({
			id,
			moduleName: id,
			resolvedPath: pathToFileURL(resolvedFile).href,
			options,
			plugin,
		});
	}
	return loaded;
}
