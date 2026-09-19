import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DocumentlintPluginError,
	loadDocumentlintPlugins,
} from "../../src/plugins/loader.js";

const temporary: string[] = [];
afterEach(() => {
	for (const directory of temporary.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

function pluginFile(source: string): {
	configPath: string;
	pluginPath: string;
} {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "documentlint-plugin-"),
	);
	temporary.push(directory);
	const pluginPath = path.join(directory, "plugin.mjs");
	fs.writeFileSync(pluginPath, source);
	return {
		configPath: path.join(directory, ".textlintrc.json"),
		pluginPath,
	};
}

function packagePlugin(source: string): string {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "documentlint-plugin-package-"),
	);
	temporary.push(directory);
	const packageDirectory = path.join(
		directory,
		"node_modules",
		"documentlint-plugin-fixture",
	);
	fs.mkdirSync(packageDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(packageDirectory, "package.json"),
		JSON.stringify({ type: "module", exports: "./index.mjs" }),
	);
	fs.writeFileSync(path.join(packageDirectory, "index.mjs"), source);
	return path.join(directory, ".textlintrc.json");
}

describe("documentlint plugin loader", () => {
	it("loads a relative factory and passes its configuration", async () => {
		const fixture = pluginFile(`export default (options) => ({
			apiVersion: 1,
			name: options.name,
			lint() { return []; }
		});`);
		const loaded = await loadDocumentlintPlugins(
			{ "./plugin.mjs": { name: "fixture" } },
			fixture.configPath,
		);
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.plugin.name).toBe("fixture");
	});

	it("rejects exports that do not implement API version 1", async () => {
		const fixture = pluginFile("export default { apiVersion: 2 };");
		await expect(
			loadDocumentlintPlugins({ "./plugin.mjs": true }, fixture.configPath),
		).rejects.toBeInstanceOf(DocumentlintPluginError);
	});

	it("resolves shorthand names to documentlint-plugin packages", async () => {
		const configPath = packagePlugin(
			"export default { apiVersion: 1, lint() { return []; } };",
		);
		const loaded = await loadDocumentlintPlugins({ fixture: true }, configPath);
		expect(loaded[0]?.resolvedPath).toContain("documentlint-plugin-fixture");
	});
});
