import { describe, expect, it } from "vitest";
import { isRangeMasked, maskZennSyntax } from "../../src/zenn/mask.js";

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

describe("isRangeMasked", () => {
	const maskedRanges = [{ start: 5, end: 10 }];

	it("treats a non-empty range as masked as soon as it overlaps a masked span at all", () => {
		expect(isRangeMasked({ start: 0, end: 6 }, maskedRanges)).toBe(true);
		expect(isRangeMasked({ start: 9, end: 12 }, maskedRanges)).toBe(true);
		expect(isRangeMasked({ start: 6, end: 8 }, maskedRanges)).toBe(true);
	});

	it("treats a non-empty range as unmasked when it only touches the mask's boundary", () => {
		expect(isRangeMasked({ start: 0, end: 5 }, maskedRanges)).toBe(false);
		expect(isRangeMasked({ start: 10, end: 15 }, maskedRanges)).toBe(false);
	});

	// Regression for the major-1 review finding's zero-length half:
	// `text.slice(p, p) === input.slice(p, p)` is "" === "" no matter where
	// `p` lands, so the naive string-equality guard alone can never reject a
	// zero-length insertion computed against masked content. isRangeMasked
	// must catch it by position instead.
	it("treats a zero-length insertion strictly inside a masked span as masked, even though slice(p, p) is always empty", () => {
		expect(isRangeMasked({ start: 7, end: 7 }, maskedRanges)).toBe(true);
	});

	it("treats a zero-length insertion exactly on a masked span's boundary as unmasked", () => {
		expect(isRangeMasked({ start: 5, end: 5 }, maskedRanges)).toBe(false);
		expect(isRangeMasked({ start: 10, end: 10 }, maskedRanges)).toBe(false);
	});

	it("is unmasked when there are no masked ranges at all", () => {
		expect(isRangeMasked({ start: 5, end: 5 }, [])).toBe(false);
	});
});
