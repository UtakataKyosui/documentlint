#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { loadDocumentlintConfig } from "./config/documentlint.js";
import { runDocumentlint } from "./runner.js";

function usage(): string {
	return "Usage: documentlint [--config file] [--fix] [--format human|json] [--stdin --stdin-filename path] [files/globs...]\nExit: 0=no findings, 1=findings, 2=configuration or execution error\n";
}
function human(result: Awaited<ReturnType<typeof runDocumentlint>>): string {
	return result.diagnostics
		.map(
			(item) =>
				`${item.filePath}:${item.location.start.line}:${item.location.start.column} ${item.severity} ${item.engine}/${item.ruleId} ${item.message}`,
		)
		.join("\n");
}

export async function main(
	args = process.argv.slice(2),
	stdin?: string,
): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(usage());
		return 0;
	}
	const value = (flag: string) => {
		const i = args.indexOf(flag);
		return i === -1 ? undefined : args[i + 1];
	};
	const configPath = value("--config") ?? "documentlint.json";
	const format = value("--format") ?? "human";
	if (format !== "human" && format !== "json")
		throw new Error("--format must be human or json");
	const fix = args.includes("--fix");
	const stdinMode = args.includes("--stdin");
	const stdinText = stdin ?? (stdinMode ? fs.readFileSync(0, "utf8") : "");
	const positional = args.filter(
		(arg, i) =>
			!["--config", "--format", "--stdin-filename"].includes(
				args[i - 1] ?? "",
			) &&
			![
				"--config",
				"--format",
				"--stdin-filename",
				"--stdin",
				"--fix",
			].includes(arg),
	);
	const config = loadDocumentlintConfig(configPath);
	const files = stdinMode
		? [value("--stdin-filename") ?? "stdin.md"]
		: await fg(
				positional.length ? positional : [...(config.files ?? ["**/*.md"])],
				{
					ignore: [
						...(config.ignores ?? []),
						...(config.markdownlint?.ignores ?? []),
					],
					onlyFiles: true,
				},
			);
	if (files.length === 0) return 0;
	const results = await Promise.all(
		files.map(async (file) => {
			const text = stdinMode ? stdinText : fs.readFileSync(file, "utf8");
			const result = await runDocumentlint(
				text,
				path.resolve(file),
				config,
				fix,
				configPath,
			);
			if (fix && !stdinMode && result.output !== text)
				fs.writeFileSync(file, result.output);
			return result;
		}),
	);
	if (format === "json")
		process.stdout.write(
			`${JSON.stringify({ version: 1, results }, null, 2)}\n`,
		);
	else {
		const output = results.map(human).filter(Boolean).join("\n");
		if (output) process.stdout.write(`${output}\n`);
	}
	return results.some((result) => result.errors.length)
		? 2
		: results.some((result) => result.diagnostics.length)
			? 1
			: 0;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href)
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			process.stderr.write(
				`${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 2;
		});
