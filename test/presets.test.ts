import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocumentlintConfig } from "../src/config/documentlint.js";
import { runDocumentlint } from "../src/runner.js";

describe("published configuration presets", () => {
	for (const name of ["ja", "ja-zenn", "ja-ai"]) {
		it(`${name} is a valid documentlint configuration`, async () => {
			const file = path.resolve("presets", `${name}.jsonc`);
			const config = parseDocumentlintConfig(fs.readFileSync(file, "utf8"), file);
			expect(config.version).toBe(1);
			expect(config.files).toEqual(["**/*.md"]);
			expect(config.textlint?.rules).toHaveProperty("preset-ja-technical-writing");
			expect(config.textlint?.rules).toHaveProperty("preset-ja-spacing");
			expect(config.textlint?.plugins).toEqual({ markdown: true });
			if (name === "ja-zenn") expect(config.zenn).toEqual({ enabled: true });
			else expect(config.zenn).toBeUndefined();
			const result = await runDocumentlint("# Heading\n本文です。\n", path.resolve("article.md"), config, false, file);
			expect(result.errors).toEqual([]);
			expect(result.diagnostics.some((item) => item.ruleId === "MD022")).toBe(true);
		});
	}
});
