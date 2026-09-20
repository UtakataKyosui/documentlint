# Extended textlintrc configuration

documentlint keeps textlint's `rules`, `filters`, and `plugins` at the root of
`.textlintrc.json`. Its own settings live under `documentlint`, so existing
textlint settings can be extended in place. JSON comments and trailing commas
are accepted.

```jsonc
{
  "$schema": "./node_modules/documentlint/schema/documentlint.schema.json",
  "rules": { "preset-ja-technical-writing": true },
  "filters": { "comments": true },
  "plugins": { "markdown": true },
  "documentlint": {
    "version": 1,
    "files": ["articles/**/*.md"],
    "ignores": ["articles/generated/**"],
    "prh": {
      "dictionaries": ["./prh.yml"]
    },
    "markdown": {
      "syntax": {
        "zenn": true,
        "markdownItPlugins": ["markdown-it-footnote"],
        "plugins": { "zenn-custom-block": true }
      },
      "checks": {
        "markdownlint": { "MD013": false },
        "plugins": { "heading-policy": { "maxDepth": 3 } }
      }
    }
  }
}
```

`prh.dictionary` accepts an inline prh version 1 dictionary;
`prh.dictionaries` accepts file paths. The two forms cannot be combined. All
relative paths and plugin modules are resolved from the configuration file.

`markdown.syntax.markdownItPlugins` loads ordinary markdown-it packages for
markdownlint parsing. `markdown.syntax.plugins` loads documentlint plugins that
preprocess extension syntax or register a markdown-it extension.
`markdown.checks.plugins` loads plugins that return their own diagnostics.
Plugin API version 1 is diagnostic-only; check plugins do not participate in
`--fix`.

A plain textlintrc without a `documentlint` block remains valid. The former
`documentlint.json` format is also accepted while projects migrate.

## Multi-round `--fix`

`documentlint --fix` re-runs every engine's fix pass to a fixed point: each
round's output becomes the next round's input, so an edit that only becomes
visible after another engine's fix still gets picked up on a later round.
`--dry-run` runs the same multi-round analysis and previews the result with a
unified diff instead of writing to disk.

`--max-iterations n` caps how many rounds a fix run may take before giving up;
it defaults to 10. A run can also stop early if a round's output repeats one
already seen, which means two rules are undoing each other in a cycle. Either
case is reported through `stoppedReason` (`converged`, `max-iterations`, or
`cycle-detected`) in `--format json` output, and as a warning on stderr in the
default human format, because the settled text can be partially or
over-applied when the round cap is hit.

Because `--fix` can take several rounds where a single textlint fix pass takes
one, the result of `--fix` on a document can differ from applying the
underlying engines' fixes once. A `prh` dictionary rule whose expected term
still matches its own pattern is a common way to hit `--max-iterations`: each
round's replacement immediately qualifies as the next round's match, so the
text keeps growing until the cap stops it.

## Plugin API

Packages use the `documentlint-plugin-<name>` convention. `@scope/name` maps to
`@scope/documentlint-plugin-name`; fully qualified names and relative paths are
also supported. `false` disables a plugin, `true` enables it with empty options,
and an object is passed to the plugin as options.

The default export is an API version 1 object or a factory receiving the plugin
options:

```js
export default (options) => ({
  apiVersion: 1,

  preprocess({ text }) {
    // Mask custom delimiters with spaces. Length and line breaks must remain
    // identical so diagnostics still point into the original document.
    return text.replaceAll(":::custom", "         ");
  },

  markdownItPlugin(markdownIt) {
    // Register markdown-it rules when this syntax participates in markdownlint.
  },

  lint({ source, text, filePath }) {
    const start = source.indexOf(options.forbidden);
    return start === -1
      ? []
      : [{
          ruleId: "forbidden-word",
          message: `Avoid ${options.forbidden}`,
          severity: "warning",
          range: { start, end: start + options.forbidden.length }
        }];
  }
});
```

Syntax and check plugins receive the original `source`, the preprocessed
`text`, `filePath`, and `configPath`. Syntax preprocessors run in configuration
order. documentlint rejects a preprocessor that changes the UTF-16 length or
line-break positions. Check diagnostics use zero-based, end-exclusive ranges;
documentlint validates them and supplies line and column positions.
