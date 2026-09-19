import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { UnsupportedConfigError } from "../../src/config/errors.js";
import { ModuleResolutionError } from "../../src/config/resolver.js";
import { resolveTextlintrc } from "../../src/config/textlintrc.js";

const projectRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");

function realPackagePath(name: string): string {
	return fs.realpathSync(path.join(projectRoot, "node_modules", name));
}

function linkPackage(nodeModulesDir: string, name: string): void {
	const target = realPackagePath(name);
	const linkPath = path.join(nodeModulesDir, name);
	fs.mkdirSync(path.dirname(linkPath), { recursive: true });
	fs.symlinkSync(target, linkPath, "dir");
}

describe("resolveTextlintrc", () => {
	let tempDir: string;
	let nodeModulesDir: string;
	let configPath: string;

	beforeAll(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "documentlint-textlintrc-")),
		);
		nodeModulesDir = path.join(tempDir, "node_modules");
		fs.mkdirSync(nodeModulesDir, { recursive: true });

		linkPackage(nodeModulesDir, "textlint-rule-no-todo");
		linkPackage(nodeModulesDir, "textlint-filter-rule-comments");
		linkPackage(nodeModulesDir, "@textlint/textlint-plugin-markdown");

		const presetDir = path.join(nodeModulesDir, "textlint-rule-preset-foo");
		fs.mkdirSync(presetDir, { recursive: true });
		fs.writeFileSync(
			path.join(presetDir, "package.json"),
			JSON.stringify({
				name: "textlint-rule-preset-foo",
				version: "1.0.0",
				main: "index.js",
			}),
		);
		fs.writeFileSync(path.join(presetDir, "index.js"), "export default {};\n");
	});

	afterAll(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		configPath = path.join(tempDir, ".textlintrc.json");
	});

	afterEach(() => {
		fs.rmSync(configPath, { force: true });
	});

	function writeConfig(content: unknown): void {
		fs.writeFileSync(configPath, JSON.stringify(content));
	}

	it("resolves rules, filters, and plugins from short names", () => {
		writeConfig({
			rules: { "no-todo": true },
			filters: { comments: true },
			plugins: { markdown: true },
		});

		const result = resolveTextlintrc(configPath);

		expect(result.filePath).toBe(configPath);
		expect(result.rules).toHaveLength(1);
		expect(result.rules[0]?.ruleId).toBe("no-todo");
		expect(result.rules[0]?.module.packageName).toBe("textlint-rule-no-todo");
		expect(result.rules[0]?.options).toBeUndefined();

		expect(result.filters).toHaveLength(1);
		expect(result.filters[0]?.module.packageName).toBe(
			"textlint-filter-rule-comments",
		);

		expect(result.plugins).toHaveLength(1);
		expect(result.plugins[0]?.module.packageName).toBe(
			"@textlint/textlint-plugin-markdown",
		);
	});

	it("excludes a rule disabled with false without resolving it", () => {
		writeConfig({ rules: { "no-todo": false, "nonexistent-rule": false } });

		const result = resolveTextlintrc(configPath);

		expect(result.rules).toHaveLength(0);
	});

	it("keeps an options object for a rule", () => {
		writeConfig({ rules: { "no-todo": { max: 3 } } });

		const result = resolveTextlintrc(configPath);

		expect(result.rules[0]?.options).toEqual({ max: 3 });
	});

	it("throws UnsupportedConfigError for an unknown top-level key", () => {
		writeConfig({ env: { browser: true } });

		expect(() => resolveTextlintrc(configPath)).toThrowError(
			UnsupportedConfigError,
		);
		try {
			resolveTextlintrc(configPath);
			throw new Error("expected resolveTextlintrc to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(UnsupportedConfigError);
			const configError = error as UnsupportedConfigError;
			expect(configError.location).toBe("env");
			expect(configError.configPath).toBe(configPath);
		}
	});

	it.each([
		".textlintrc.yml",
		".textlintrc.yaml",
		".textlintrc.js",
		".textlintrc.cjs",
	])(
		"throws UnsupportedConfigError for a non-JSON config file (%s)",
		(fileName) => {
			const nonJsonPath = path.join(tempDir, fileName);
			expect(() => resolveTextlintrc(nonJsonPath)).toThrowError(
				UnsupportedConfigError,
			);
		},
	);

	it("throws UnsupportedConfigError when a rule value has an invalid type", () => {
		writeConfig({ rules: { "no-todo": "always" } });

		try {
			resolveTextlintrc(configPath);
			throw new Error("expected resolveTextlintrc to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(UnsupportedConfigError);
			const configError = error as UnsupportedConfigError;
			expect(configError.location).toBe("rules.no-todo");
		}
	});

	it("propagates ModuleResolutionError for an uninstalled rule", () => {
		writeConfig({ rules: { "not-installed-rule": true } });

		expect(() => resolveTextlintrc(configPath)).toThrowError(
			ModuleResolutionError,
		);
	});

	it("expands preset options into individual preset rule entries", () => {
		writeConfig({
			rules: {
				"preset-foo": {
					"sentence-length": { max: 100 },
					"some-flag": true,
					"disabled-rule": false,
				},
			},
		});

		const result = resolveTextlintrc(configPath);

		expect(result.rules).toHaveLength(1);
		const presetEntry = result.rules[0];
		expect(presetEntry?.ruleId).toBe("preset-foo");
		expect(presetEntry?.module.kind).toBe("preset");
		expect(presetEntry?.module.packageName).toBe("textlint-rule-preset-foo");
		expect(presetEntry?.options).toBeUndefined();
		expect(presetEntry?.presetRules).toEqual([
			{ ruleId: "sentence-length", enabled: true, options: { max: 100 } },
			{ ruleId: "some-flag", enabled: true },
			{ ruleId: "disabled-rule", enabled: false },
		]);
	});

	it("throws UnsupportedConfigError for an invalid preset sub-rule value", () => {
		writeConfig({ rules: { "preset-foo": { "sentence-length": "oops" } } });

		try {
			resolveTextlintrc(configPath);
			throw new Error("expected resolveTextlintrc to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(UnsupportedConfigError);
			const configError = error as UnsupportedConfigError;
			expect(configError.location).toBe("rules.preset-foo.sentence-length");
		}
	});
});
