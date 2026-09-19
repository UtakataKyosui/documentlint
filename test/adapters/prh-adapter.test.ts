import { describe, expect, it } from "vitest";
import { createPrhAdapter } from "../../src/adapters/prh/adapter.js";

describe("prh adapter", () => {
	const adapter = createPrhAdapter({
		version: 1,
		rules: [
			{ expected: "JavaScript", pattern: "/javascript/i" },
			{ expected: "サーバー", pattern: "/サーバ(?!ー)/" },
		],
	});

	it("preserves dictionary diagnostics and replacements", () => {
		const result = adapter.lintText(
			"javascript とサーバを使う。",
			"fixture.md",
		);
		expect(result.diagnostics).toHaveLength(2);
		expect(result.diagnostics.map((item) => item.fix?.text)).toEqual([
			"JavaScript",
			"サーバー",
		]);
		expect(
			result.diagnostics.every(
				(item) => item.engine === "prh" && item.location.range.start >= 0,
			),
		).toBe(true);
	});

	it("applies non-overlapping dictionary replacements", () => {
		expect(
			adapter.fixText("javascript とサーバを使う。", "fixture.md").output,
		).toBe("JavaScript とサーバーを使う。");
	});
});
