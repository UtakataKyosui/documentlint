# documentlint

Unified linting for textlint, markdownlint, prh dictionaries, and extended
Markdown syntax. A `.textlintrc.json` can be extended without moving existing
textlint rules.

```jsonc
// .textlintrc.json
{
	"rules": { "no-todo": true },
	"plugins": { "markdown": true },
	"documentlint": {
		"version": 1,
		"files": ["articles/**/*.md"],
		"prh": { "dictionaries": ["./prh.yml"] },
		"markdown": {
			"syntax": {
				"zenn": true,
				"markdownItPlugins": ["markdown-it-footnote"],
				"plugins": { "my-syntax": true }
			},
			"checks": {
				"markdownlint": { "MD013": false },
				"plugins": { "heading-policy": { "maxDepth": 3 } }
			}
		}
	}
}
```

Run `documentlint [--config .textlintrc.json] [--fix] [--format human|json] [files/globs...]`.
It exits with 0 for no findings, 1 for findings, and 2 for configuration or engine errors. `--fix` is the only mode that writes files; standard input is never written.

Plugin names use the `documentlint-plugin-` prefix, following textlint's naming
style. For example, `"heading-policy"` resolves to
`documentlint-plugin-heading-policy`. Scoped packages and paths relative to the
configuration file are supported. See [configuration and plugin API](docs/configuration.md).

Legacy configuration can be converted with `importLegacyConfig()` as a dry run. It returns a JSON diff and never deletes or changes the source file. CLI options override the unified configuration's file selection; unified configuration overrides imported legacy values. A textlint rule configured both in `textlint.config` and inline `textlint.rules` is rejected by configuration review before use.

Dynamic JavaScript settings, markdownlint custom rules/output formatters, and inline markdown-it plugin functions cannot be converted safely and are reported as errors. `.textlintrc.json`, `.markdownlint.json`, `.markdownlint-cli2.jsonc`, and `prh.yml` are supported import sources. See [compatibility](docs/compatibility.md) for the engine-specific scope.
