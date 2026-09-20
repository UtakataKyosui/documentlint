import fs from "node:fs";
import path from "node:path";

export class ExternalChangeError extends Error {
	constructor(readonly filePath: string) {
		super(
			`Refusing to write "${filePath}": the file changed on disk after it was read. Re-run documentlint to pick up the new content.`,
		);
		this.name = "ExternalChangeError";
	}
}

/**
 * Writes `newContent` to `filePath` only if the file's on-disk content still
 * matches `expectedOriginal` (the text this run read before computing the
 * fix), and does so atomically (write a sibling temp file, then rename) so a
 * crash mid-write never leaves a truncated file. Throws ExternalChangeError,
 * without writing anything, when the file was modified by something else in
 * the meantime.
 *
 * This cannot be made fully atomic with the fs APIs Node exposes: there is
 * no OS-level "compare-and-rename". The initial read-then-later-rename is
 * therefore re-checked immediately before the rename, which shrinks the
 * window in which an external writer can race us down to the gap between
 * that second read and the rename syscall itself -- narrow, but not zero.
 */
export function writeFileIfUnchanged(
	filePath: string,
	expectedOriginal: string,
	newContent: string,
): void {
	const current = fs.readFileSync(filePath, "utf8");
	if (current !== expectedOriginal) throw new ExternalChangeError(filePath);
	const mode = fs.statSync(filePath).mode & 0o777;

	const directory = path.dirname(filePath);
	const tempPath = path.join(
		directory,
		`.${path.basename(filePath)}.documentlint-${process.pid}-${Date.now()}.tmp`,
	);
	fs.writeFileSync(tempPath, newContent);
	fs.chmodSync(tempPath, mode);
	try {
		const stillCurrent = fs.readFileSync(filePath, "utf8");
		if (stillCurrent !== expectedOriginal)
			throw new ExternalChangeError(filePath);
		fs.renameSync(tempPath, filePath);
	} catch (error) {
		fs.rmSync(tempPath, { force: true });
		throw error;
	}
}
