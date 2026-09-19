import { describe, expect, it } from "vitest";
import { maskZennSyntax } from "../../src/zenn/mask.js";

describe("Zenn masking", () => {
	it("preserves offsets and line breaks while hiding syntax, URLs, and code", () => {
		const source =
			'---\ntitle: "🎉"\n---\n\n:::message\n本文です。\n:::\n\n`code` [link](https://example.com)\n```ts\nconst x = 1\n```\n$E=mc^2$\n';
		const masked = maskZennSyntax(source);
		expect(masked).toHaveLength(source.length);
		expect(masked.replace(/[^\r\n]/g, "")).toBe(source.replace(/[^\r\n]/g, ""));
		expect(masked).toContain("本文です。");
		expect(masked).not.toContain("const x");
	});
});
