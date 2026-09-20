import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ExternalChangeError,
	writeFileIfUnchanged,
} from "../../src/fix/write.js";

const temporary: string[] = [];
afterEach(() => {
	for (const directory of temporary.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

function tempFile(content: string): string {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "documentlint-write-"),
	);
	temporary.push(directory);
	const filePath = path.join(directory, "article.md");
	fs.writeFileSync(filePath, content);
	return filePath;
}

describe("writeFileIfUnchanged", () => {
	it("writes the new content when the file still matches what was read", () => {
		const filePath = tempFile("original\n");
		writeFileIfUnchanged(filePath, "original\n", "fixed\n");
		expect(fs.readFileSync(filePath, "utf8")).toBe("fixed\n");
	});

	it("leaves no temp file behind after a successful write", () => {
		const filePath = tempFile("original\n");
		writeFileIfUnchanged(filePath, "original\n", "fixed\n");
		const siblings = fs.readdirSync(path.dirname(filePath));
		expect(siblings).toEqual(["article.md"]);
	});

	it("preserves the target file mode across the atomic rename", () => {
		const filePath = tempFile("original\n");
		fs.chmodSync(filePath, 0o755);
		writeFileIfUnchanged(filePath, "original\n", "fixed\n");
		expect(fs.statSync(filePath).mode & 0o777).toBe(0o755);
	});

	it("refuses to write, and preserves the external edit, when the file changed since it was read", () => {
		const filePath = tempFile("original\n");
		fs.writeFileSync(filePath, "someone else's edit\n");
		expect(() =>
			writeFileIfUnchanged(filePath, "original\n", "fixed\n"),
		).toThrow(ExternalChangeError);
		expect(fs.readFileSync(filePath, "utf8")).toBe("someone else's edit\n");
	});

	it("leaves no temp file behind after refusing an external-change write", () => {
		const filePath = tempFile("original\n");
		fs.writeFileSync(filePath, "someone else's edit\n");
		expect(() =>
			writeFileIfUnchanged(filePath, "original\n", "fixed\n"),
		).toThrow();
		const siblings = fs.readdirSync(path.dirname(filePath));
		expect(siblings).toEqual(["article.md"]);
	});

	it("still refuses to write when the external change happens after the initial read but before the rename (TOCTOU race)", () => {
		// Regression for the major-3 review finding: the initial
		// read-then-compare only guards the window up to that read. A writer
		// that races in between the temp-file write and the rename used to go
		// undetected, silently overwriting the racing edit. writeFileIfUnchanged
		// re-reads the file immediately before the rename to shrink that
		// window; simulate the race by mutating the real file the moment the
		// temp file write happens, right before that second read runs.
		const filePath = tempFile("original\n");
		const realWriteFileSync = fs.writeFileSync;
		const spy = vi
			.spyOn(fs, "writeFileSync")
			.mockImplementation((target, data, options) => {
				realWriteFileSync(
					target as Parameters<typeof fs.writeFileSync>[0],
					data as Parameters<typeof fs.writeFileSync>[1],
					options as Parameters<typeof fs.writeFileSync>[2],
				);
				if (typeof target === "string" && target.includes(".documentlint-"))
					realWriteFileSync(filePath, "raced edit\n", "utf8");
			});
		try {
			expect(() =>
				writeFileIfUnchanged(filePath, "original\n", "fixed\n"),
			).toThrow(ExternalChangeError);
			expect(fs.readFileSync(filePath, "utf8")).toBe("raced edit\n");
			const siblings = fs.readdirSync(path.dirname(filePath));
			expect(siblings).toEqual(["article.md"]);
		} finally {
			spy.mockRestore();
		}
	});
});
