# 日本語・Zenn プリセット

documentlint は既存の textlint ルールを組み合わせた設定プリセットを提供します。ルールの実装をコピーしていないため、ルールパッケージの更新と互換性は利用側の依存管理に従います。

## 選択

| プリセット | 内容 |
|---|---|
| `presets/ja.jsonc` | 日本語技術文書、半角・全角スペーシング、Markdown 構造 |
| `presets/ja-zenn.jsonc` | `ja` に Zenn front matter、コードブロック、インライン構文のマスクを追加 |
| `presets/ja-ai.jsonc` | `ja` に AI 表現チェックを追加。表現の好みに依存するため任意 |

プリセットファイルをプロジェクトの `documentlint.json` としてコピーし、必要なルールパッケージを追加します。npm パッケージに含まれるファイルの場所は配布設定に従うため、公開パッケージを利用する場合は `documentlint/presets/ja-zenn.jsonc` を参照してください。

```sh
pnpm add -D documentlint textlint-rule-preset-ja-technical-writing textlint-rule-preset-ja-spacing @textlint/textlint-plugin-markdown
cp node_modules/documentlint/presets/ja-zenn.jsonc documentlint.json
pnpm exec documentlint --fix
```

AI プリセットを選ぶ場合は `@textlint-ja/textlint-rule-preset-ai-writing` も明示的に追加します。AI プリセットは既定で有効にならないため、導入時に選択したことを設定レビューで確認できます。

## 上書き

プリセットの `textlint.rules` は通常の textlint 設定なので、サブ規則を無効化またはオプション変更できます。

```jsonc
{
	"version": 1,
	"textlint": {
		"rules": {
			"preset-ja-technical-writing": {
				"sentence-length": { "max": 120 }
			},
			"preset-ja-spacing": {
				"ja-space-between-half-and-full-width": { "space": 1 }
			}
		},
		"plugins": { "markdown": true }
	},
	"zenn": { "enabled": true }
}
```

実際のサブ規則名とオプションはインストールしたプリセットのリリースに依存します。`--print-config` と `--debug` で採用設定とルール解決を確認し、パッケージの README を優先してください。文長、文体、助詞、句読点はプロジェクトの読者と媒体に合わせてサブ規則の設定を調整します。

## textlint からの移行

移行前の分散設定:

```json
{ "rules": { "preset-ja-technical-writing": true }, "plugins": { "markdown": true } }
```

移行後は実行対象、Zenn 対応、Markdown 構造を一つの設定へ集約します。

```json
{
	"version": 1,
	"files": ["articles/**/*.md"],
	"textlint": {
		"rules": { "preset-ja-technical-writing": true, "preset-ja-spacing": true },
		"plugins": { "markdown": true }
	},
	"markdownlint": { "config": { "default": true, "MD013": false } },
	"zenn": { "enabled": true }
}
```

既存のルール、辞書、ignore は一度に捨てず、`importLegacyConfig()` で変換内容を確認してから統合します。textlint の動的 JavaScript 設定や独自 formatter は自動変換せず、互換性表の制限を確認してください。依存パッケージのバージョンとプリセットのルール構成は利用側で管理し、private の記事や辞書をプリセットへ含めません。
