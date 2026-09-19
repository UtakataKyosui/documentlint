# 0001. textlint 互換性の範囲と統合アーキテクチャ

- Status: Accepted
- Date: 2026-09-20
- Issue: #1

## Context

documentlint は文章校正（textlint）・Markdown 構造チェック（markdownlint）・表記辞書（prh）を単一の
CLI と単一の設定へ統合する。利用者はすでに `.textlintrc.json` とルールパッケージに投資している。
移行に既存資産の書き換えを要求すると採用されない。

## Decision

### エンジンは再実装せず公式実装をアダプターで駆動する

Node.js / TypeScript 上で各エンジンの公式パッケージを依存に取り、documentlint はその周辺
（設定解決・ファイル選択・診断正規化・修正適用）だけを担う。ルールロジックは一切再実装しない。

再実装を選ばない理由は、textlint のルール資産（日本語技術文書 preset 等）が documentlint の価値の
本体であり、それを自前で持つことは移行先としての意味を失うためである。

### textlint は `loadTextlintrc` を使わず descriptor を自前で組み立てる

textlint 15 の公開 API は `loadTextlintrc` で `TextlintKernelDescriptor` を得て `createLinter` に
渡す形を取る。documentlint はこのうち `createLinter` のみを使い、descriptor は
`TextlintKernelDescriptor` を直接構築する。

理由は `loadTextlintrc` の解決失敗が観測できないことである。未導入のルールを `.textlintrc.json` に
書いた場合、`loadTextlintrc` は例外を投げず、該当ルールを descriptor から静かに除外する
（rule descriptors が 0 件になるだけで、エラー情報はどの戻り値にも残らない）。この挙動のままでは
「ルールが効いていないことに利用者が気づけない」状態を許すことになり、受け入れ条件に反する。

自前解決に切り替えることで、解決失敗を `ModuleResolutionError` として送出でき、あわせて短縮名・
スコープ付き名・相対パスの対応範囲を documentlint 側の仕様として定義できる。

### 責務境界

| 層 | 責務 | 非責務 |
|---|---|---|
| 設定解決 | `.textlintrc.json` の読み取り、パッケージ名の解決、未対応キーと不正な値型の検出 | モジュールの読み込み、ルールの実行 |
| エンジン境界 | 解決済みモジュールの読み込み、preset の展開とサブルール指定の解釈、descriptor の組み立て、`createLinter` の呼び出し | 設定ファイルの読み取りと構文解釈 |
| 診断正規化 | エンジン固有の結果を `Diagnostic` へ変換 | 重複排除、競合検出 |
| ファイル選択 | 対象ファイルの列挙と ignore の適用 | 差分取得 |

preset のサブルール指定の解釈をエンジン境界に置くのは、どのサブルールが存在するかが
preset モジュールを読み込むまで判らないためである。設定解決の層は preset パッケージ自体の
解決と、サブルール指定の構文的な妥当性までを見る。

修正の適用は独立した層を持たない。textlint の `fixText` / `fixFiles` に委譲し、その結果を
診断正規化の層で `FixResult` へ変換する。markdownlint と prh を統合する段階で複数エンジンの
修正が競合しうるため、そこで初めて独立した修正層が必要になる（Issue #8）。

### 対応バージョン

| 対象 | バージョン | 備考 |
|---|---|---|
| Node.js | >= 22 | markdownlint と prh が `engines` で要求する下限に合わせる。textlint 単体は >= 20.18.0 |
| textlint | 15.8.0 | `@textlint/kernel` `@textlint/types` `@textlint/module-interop` を同一バージョンで揃える |
| markdownlint | 0.41.1 | MVP では未統合（Issue #4） |
| prh | 6.1.0 | MVP では未統合（Issue #5） |

### 配布

npm パッケージ名 `documentlint` は未使用であることを registry で確認した（`doclint` も空き）。
`documentlint` を採用する。公開そのものは本 ADR の範囲外とする。

## Consequences

`loadTextlintrc` を使わないため、textlint 本体が設定形式を拡張した際に documentlint 側の追従が
必要になる。互換性は Issue #2 の parity テスト（同一バージョンの textlint 単体と ruleId・位置・
重要度・メッセージ・修正結果を比較する）で担保する。

`.textlintrc.js` など JavaScript 形式の設定は MVP では非対応とする。設定ファイルとして与えられた
場合は黙って無視せず `UnsupportedConfigError` を送出する。

`textlint` の `--rulesdir` は非対応であり、これを受け取る API を提供しない。設定ファイル経由で
指定する手段も無いため、検出して例外を送出する経路も存在しない。
