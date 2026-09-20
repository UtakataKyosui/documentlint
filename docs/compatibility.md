# textlint 互換性表

対応バージョンは [ADR 0001](./adr/0001-textlint-compatibility-and-integration.md) を参照する。

## 設定

| 設定 | MVP | 挙動 |
|---|---|---|
| `.textlintrc.json` | 対応 | 読み込む |
| `.textlintrc.yml` / `.textlintrc.yaml` | 非対応 | `UnsupportedConfigError` |
| `.textlintrc.js` / `.textlintrc.cjs` | 非対応 | `UnsupportedConfigError` |
| `package.json` の `textlint` フィールド | 非対応 | `UnsupportedConfigError` |
| `rules` | 対応 | ルール ID とオプションを解決する |
| `presets`（`preset-` 接頭辞のルール指定） | 対応 | preset 内ルールへオプションを展開する |
| `filters` | 対応 | filter rule として解決する |
| `plugins` | 対応 | processor plugin として解決する |
| `.textlintignore` | 対応 | 選択した設定ファイルと同じディレクトリから自動読込する。`--ignore-path` で差し替えられる |
| `--rulesdir` | 非対応 | 受け取る API を提供しない。設定ファイル経由で指定する手段も無い |
| 上記以外のトップレベルキー | 非対応 | `UnsupportedConfigError` |

## パッケージ解決

利用側プロジェクトの `node_modules` を基準に解決する。

| 記法 | 例 | 解決先 |
|---|---|---|
| 短縮名 | `no-todo` | `textlint-rule-no-todo` |
| 短縮名（filter） | `comments` | `textlint-filter-rule-comments` |
| 短縮名（plugin） | `markdown` | `@textlint/textlint-plugin-markdown` |
| 短縮名（preset） | `preset-ja-technical-writing` | `textlint-rule-preset-ja-technical-writing` |
| 完全修飾名 | `textlint-rule-foo` | そのまま（接頭辞を重ねない） |
| スコープ付き完全名 | `@scope/textlint-rule-foo` | そのまま（接頭辞を重ねない） |
| スコープ短縮 | `@scope/foo` | `@scope/textlint-rule-foo` |
| 相対パス | `./rules/my-rule.js` | 設定ファイルからの相対で解決する |

完全修飾名（すでに接頭辞を持つ名前）は接頭辞を重ねず、そのまま解決する。短縮名の場合のみ
接頭辞付きの候補を先に試し、それが解決できなければ指定名そのものを試す。

解決に失敗した場合は該当する指定名と探索した候補名の全リストを含む `ModuleResolutionError`
を送出する。黙って無視しない。設定ファイルの構造や値の型が非対応の場合は
`UnsupportedConfigError` を送出する（解決の失敗とは別の例外型である）。

### textlint 本体との意図的な差異

plugin の短縮名について documentlint は textlint より広く解決する。textlint の
`loadTextlintrc` は未スコープの plugin 名を `textlint-plugin-<name>` としてしか展開せず、
`@textlint/textlint-plugin-<name>` を試さない。このため公式の組み込み plugin であっても
`{"plugins": {"markdown": true}}` は解決に失敗する。

さらに textlint は plugin の解決に失敗すると設定全体を破棄して組み込み plugin へ
フォールバックするため、**同じ設定ファイルに書かれた `rules` と `filters` まで一緒に
失われる**（実測で確認済み。rules が 0 件になる）。利用者にはエラーも警告も出ない。

documentlint は `@textlint/textlint-plugin-<name>` も候補に含めて解決し、どの候補でも
解決できなかった場合にのみ例外を送出する。設定の一部が解決できなかったことを理由に
他の設定を破棄することはしない。

## ルールの機能

| 機能 | MVP | 備考 |
|---|---|---|
| 同期ルール | 対応 | |
| 非同期ルール | 対応 | textlint kernel がそのまま扱う |
| `severity`（`error` / `warning` / `info`） | 対応 | 統一診断の `severity` へ写す |
| ルールオプション（`true` / `false` / オブジェクト） | 対応 | `false` は無効化として扱う |
| `fixable` ルール | 対応 | `fix` を `FixEdit` へ正規化する |
| `suggestions` | 対応 | 正規化するが自動適用はしない |
| processor plugin（`.md` 以外の拡張子） | 対応 | plugin が申告する拡張子を尊重する |
| filter rule（`allowlist` / `comments` / `node-types`） | 対応 | |

## 診断の正規化

textlint の数値 `severity` を統一診断へ次のように写す。

| textlint | documentlint |
|---|---|
| 2（error） | `error` |
| 1（warning） | `warning` |
| 3（info） | `info` |
| 0（none） | 例外を送出する |

`0` は textlint ではルールが無効であることを表し、報告対象の message には現れない。
現れた場合は想定外の入力として黙って握り潰さず例外を送出する。

位置情報は `loc`（1 始まりの line / column）と `range`（0 始まりのインデックス）の双方を保持する。
非推奨の `line` / `column` / `index` は読み取らない。
