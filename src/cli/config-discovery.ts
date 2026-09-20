import fs from "node:fs";
import path from "node:path";

export interface DiscoveredConfig {
	readonly path: string;
	readonly directory: string;
	readonly explicit: boolean;
}

/**
 * Searches upward from cwd. At each directory documentlint.json wins over an
 * adjacent .textlintrc.json; the filesystem root is the stopping boundary.
 * An explicit path is never searched for or silently replaced.
 */
export function discoverConfig(
	cwd: string,
	explicitPath?: string,
): DiscoveredConfig {
	if (explicitPath !== undefined) {
		const resolved = path.resolve(cwd, explicitPath);
		if (!fs.statSync(resolved).isFile())
			throw new Error(`Configuration file is not a regular file: ${resolved}`);
		return { path: resolved, directory: path.dirname(resolved), explicit: true };
	}
	let directory = path.resolve(cwd);
	for (;;) {
		for (const name of ["documentlint.json", ".textlintrc.json"]) {
			const candidate = path.join(directory, name);
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
				return { path: candidate, directory, explicit: false };
		}
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(
		`No documentlint.json or .textlintrc.json found from ${path.resolve(cwd)} to the filesystem root. Pass --config <path> to select one.`,
	);
}

/** textlint's ignore file format is a newline-separated glob list. */
export function readIgnorePatterns(ignorePath: string): readonly string[] {
	try {
		return fs
			.readFileSync(ignorePath, "utf8")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(`Could not read ignore file ${ignorePath}: ${String(error)}`);
	}
}
