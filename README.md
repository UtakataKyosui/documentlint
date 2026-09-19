# documentlint

Unified linting for textlint, markdownlint, and prh dictionaries.

```jsonc
// documentlint.json
{
  "$schema": "https://documentlint.dev/schema.json",
  "version": 1,
  "files": ["docs/**/*.md"],
  "ignores": ["docs/generated/**"],
  "textlint": { "rules": { "no-todo": true }, "plugins": { "markdown": true } },
  "markdownlint": { "config": { "MD013": false } },
  "prh": { "dictionary": { "version": 1, "rules": [{ "expected": "JavaScript", "pattern": "javascript" }] } },
  "zenn": { "enabled": true }
}
```

Run `documentlint [--config documentlint.json] [--fix] [--format human|json] [files/globs...]`.
It exits with 0 for no findings, 1 for findings, and 2 for configuration or engine errors. `--fix` is the only mode that writes files; standard input is never written.

Legacy configuration can be converted with `importLegacyConfig()` as a dry run. It returns a JSON diff and never deletes or changes the source file. CLI options override the unified configuration's file selection; unified configuration overrides imported legacy values. A textlint rule configured both in `textlint.config` and inline `textlint.rules` is rejected by configuration review before use.

Dynamic JavaScript settings, markdownlint custom rules/output formatters, and inline markdown-it plugin functions cannot be converted safely and are reported as errors. `.textlintrc.json`, `.markdownlint.json`, `.markdownlint-cli2.jsonc`, and `prh.yml` are supported import sources. See [compatibility](docs/compatibility.md) for the engine-specific scope.
