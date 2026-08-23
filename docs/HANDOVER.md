# 引き継ぎ

最終更新: 2026-08-23

このファイルは**次に作業を再開する人（未来の自分を含む）が最初に読む1枚**。
設計の詳細は他のファイルにあるので、ここでは「今どこにいるか」「次に何をするか」
「同じ穴に落ちないための知識」に絞る。

---

## 1. いま動いているもの

| | 状態 |
|---|---|
| 本番サイト | https://brog-ez1.pages.dev/ （独自ドメイン `mihoudairader.com` は取得済み・未割当） |
| サイト名 | **見放題レーダー**（2026-08-23 に「観とこう」から改名）。理由と却下案は [DEPLOY.md の改名の記録](../DEPLOY.md#取得したら) |
| リポジトリ | https://github.com/MORILABABLE/brog （Private） |
| 収集パイプライン | ✅ 2026-08 で1,089件を取得済み |
| 邦題解決 | ✅ Wikidata経由・解決率73% |
| サイト | ✅ 14ページ生成・型エラー0・JSなし |
| 記事 | ✅ 6本を公開中（`leaving`2 / `arrivals`3 / `ended`1） |
| 記事タイプ | ✅ 5種（`npm run write -- --list` が唯一の一覧） |
| デザイン | ✅ 濃紺の背景＋本文カード、ヘッダーバナー、カテゴリ色分け（[APPEARANCE.md](./APPEARANCE.md)） |
| 画像 | ✅ 記事カード（OG）と本文セクション画像を**ビルド時に自動生成**。作品画像は未使用（下記の返答待ち） |
| 記事の生成（セッション経由） | ✅ `/article` で実行。**API課金なし**。品質ゲートまで検証済み |
| 記事の生成（API経由） | 🔶 実装済みだが**実通信は未検証**（APIキー未設定） |
| 自動デプロイ | ✅ main への push で Cloudflare Pages が自動ビルド |
| 定期実行 | ❌ 未着手（GitHub Actions は書いてあるが動作未確認） |

### 動作確認済みのコマンド

```bash
npm run collect                 # 配信状況の変化を収集（API消費）
/article                        # このセッションで記事を執筆（API課金なし）
npm run write -- --emit         #   ↑を手動でやる場合: プロンプト書き出し
npm run write -- --apply        #   ↑ response.md を検証して記事にする
npm run write -- --dry-run      # プロンプトだけ表示（無料）
npm run preview                 # 収集データが記事としてどう見えるか（API消費なし）
npm run catalogs                # 対象国のサービス一覧
npm run typecheck
cd site && npm run build        # サイトのビルド
```

### 記事生成の2経路

生成手段は2つあるが、**検証・frontmatter組み立て・書き出しは共通コード**（`finalize()`）を通る。
生成手段だけが差し替わる設計なので、どちらを使っても品質ゲートは必ず効く。

| 経路 | コマンド | 費用 | 使いどころ |
|---|---|---|---|
| セッション執筆 | `/article` | **0円** | 手動運用・テンプレ調整中 |
| LLM API | `npm run write` | 約$0.11/本 | GitHub Actions での定期実行（P3） |

---

## 2. ドキュメントの地図

| 読むべきとき | ファイル |
|---|---|
| **他ジャンルのブログを増やしたい** | **[NEW-THEME.md](./NEW-THEME.md)** |
| **背景・バナー・ロゴ・OG画像・カテゴリ色・記事内の画像** | **[APPEARANCE.md](./APPEARANCE.md)** |
| ブラウザ（github.dev）で記事やデザインを直す | [EDITING.md](./EDITING.md) |
| 全体の設計・なぜその選択をしたか | [../DESIGN.md](../DESIGN.md) |
| セットアップ・コマンド一覧 | [../README.md](../README.md) |
| ドメイン取得・GitHub・Cloudflare の操作手順 | [../DEPLOY.md](../DEPLOY.md) |
| 記事の構成・文体を変えたい | `theme-packs/streaming-jp/templates/leaving.md` ほか |

---

## 3. 次にやること（優先順）

### ⏳ 返答待ち（2026-08-23 時点・これが再開の起点）

**Movie of the Night（配信API提供元）に、ポスター画像の再ホスト可否を照会中。**
先方の問い合わせフォーム（https://www.movieofthenight.com/contact ）から送信済み。

**照会した内容**

1. ビルド時にポスター画像を取得し、変換して**自分のドメインから配信してよいか**
   （規約の「streaming availability data を再配布してはならない」に当たるかの確認）
2. 許可される場合、契約終了時には保存した画像を消す義務があるという理解でよいか
3. 失効する画像URLの推奨リフレッシュ間隔

**なぜ聞いているか**

記事本文のセクション画像を、いまの**文字だけのカード**から**作品のポスター**に
差し替えたい。ただし規約に再ホストの明示が無いため、実装前に確認している。

**返答が来たらどうするか**

| 返答 | 対応 |
|---|---|
| **再ホスト可** | `site/scripts/make-sections.mjs` に画像取得を足す。`horizontalBackdrop`（文字なしのシーン風アート）が横長の枠に最も合う。**枠・日付・見出し・作品の選定ロジックはそのまま**、文字の部分だけ絵に差し替える |
| **不許可** | いまのテキスト版が最終形。**追加作業なし**。この項目を消すだけでよい |

**どちらでも「枠＋テキスト」は残すこと。** ポスターが取れない作品や、
URL失効時に画像だけ欠けても記事が崩れないようにするため。

**判明済みの制約（返答に関わらず効く）**

- 画像URLの有効期限は6〜12ヶ月。手元のデータは **2027-03-19** まで
- 帯域は無料プランで **1GB/月**
- 契約終了後は画像を使用できない
- 素材は揃っている（収集済み1,089件の**100%に posterUrl あり**）

> **作中キャプチャ（本編の場面写真）は使えない。** 調査済み。
> APIが返すのはポスターとキーアートのみ、Wikidata/Commons にも無い（実測0件）、
> 自前のスクリーンショットは商用サイトでは引用の要件を満たさない。
> 経緯は [APPEARANCE.md の9節](./APPEARANCE.md#9-記事ごとのカード画像)。

### すぐ

1. **`mihoudairader.com` を Cloudflare Pages に割り当てる**
   **左メニューに `Pages` は無い**（`Compute & AI` の下の `Workers & Pages`）。
   メニューを探さず `https://dash.cloudflare.com/?to=/:account/pages/view/brog-ez1/domains`
   を直接開く。Custom domains → Set up a domain。
   Cloudflare Registrar で取得済みなのでDNSは自動。
   詰まったときの原因は [DEPLOY.md の4節](../DEPLOY.md#4-独自ドメインを割り当てる)。
2. **`site/src/pages/contact.astro` に実在する連絡先を設定**
   未設定だとページに警告が出る。Googleフォームが最も手軽。
   AdSense審査で連絡手段の存在が確認されるため公開前に必須。
3. **`.env` に `ANTHROPIC_API_KEY` を入れて `npm run write` を実通信で検証**
   プロンプト組み立てまでは確認済みだが、生成〜検証〜書き出しの通しは未検証。

### そのあと

4. 記事タイプ `ranking` を追加（`arrivals` と `ended` は実装済み）
   → `theme-packs/streaming-jp/article-types/ended.ts` が最も新しい実装例
5. `upcoming` を収集の既定から外すか判断する
   → 全実行・全サービスで**0件**が続いており、月12リクエストの空振り。
     API側が返し始める可能性はあるので、四半期に一度 `--kinds upcoming` で手動確認する運用も可
6. `bench.ts`（同じ素材を各LLMに流してコスト・品質・検証通過率を比較）
6. GitHub Actions で定期実行＋PR自動作成（P3）
7. 記事20〜30本たまったら AdSense 申請（P4）

### サイトの改善余地（自覚済み）

- 記事一覧のページネーションなし（記事が増えたら必要）
- 関連記事の内部リンクが未実装
- セクション画像を記事に挿し込む `npm run sections -- --write` は手動実行
  （ビルドが記事ファイルを書き換えるのを避けたため。画像の生成自体は自動）
- `2026-08-leaving` は古い形式で書かれた記事（3列の表・`###` の小見出し）。
  現行テンプレートは4列を指定している。読めてはいるので放置している

---

## 4. 落とし穴（すべて実際に踏んだもの）

### データソース

- **TMDB と Watchmode は使えない。** 無料枠が**非商用限定**で、広告・アフィリエイト収入は
  規約上「商用利用」に該当する。商用ライセンスは TMDB $149/月、Watchmode $349/月。
  → Streaming Availability API は無料枠でも商用利用を明示的に許可している唯一の選択肢。
- **このAPIは日本語に対応していない**（`output_language` は en/es/fr/tr/de のみ）。
  タイトルは英語で返る。邦題は **Wikidata（CC0）** から引いている。
- **邦題をLLMに推測させてはいけない。** 邦題は翻訳ではなく配給時に決まる固有名詞。
  `Paul → 宇宙人ポール`、`Ghost → ゴースト/ニューヨークの幻`。
  推測すると外れ、SEOが機能しない。verify で機械的に禁止している。
- **U-NEXT / Hulu / DMM TV はこのAPIに存在しない。** 作品別の配信状況を裏付けるには
  月2.2万円が最低ライン。代わりに「検索リンク方式」で導線だけ作っている。

### 日付

- **開発機はJST、CIとCloudflareはUTC。** `Date` のローカル系ゲッターを使うと
  日付が1日ずれ、「8月3日終了」が「8月4日」になる。実際に一度作り込んで検出した。
  → 日付整形と月別集計は必ず `pipeline/core/datetime.ts` を経由する。

### LLM

- **`temperature` を送ると Claude Opus 5 / Sonnet 5 は 400 を返す。**
  他社に合わせて共通インターフェースに含めると Anthropic 側が壊れる。
  文体の制御はプロンプトで行う。
- **frontmatter をLLMに書かせない。** 日付・出典・カテゴリはデータから機械的に組む。
  LLMが書くのはタイトル・説明文・本文だけ。
- **出力形式はJSONではなく区切り記号方式。** 長いMarkdownをJSON文字列に入れると
  エスケープ事故が起きる。
- **BOM と CRLF は必ず剥がす。** Windowsのエディタや PowerShell の `Out-File` は
  既定でBOMを付ける。付いていると `^TITLE:` が一致せず、内容は正しいのにパースが失敗する。
  `\r` を残すとタイトル末尾に混入して frontmatter が壊れる。
  → `parseArticle()` で正規化済み。他の入力を扱うときも同じ処理を入れること。

### インフラ

- **GitHub は実メールを含む push をブロックする（GH007）。Privateリポジトリでも働く。**
  → noreply アドレス（`<数値ID>+<ユーザー名>@users.noreply.github.com`）を使う。
  数値IDは `https://api.github.com/users/<ユーザー名>` の `id`。
- **ブラウザ認証は時間制限のある環境では通らない**（`ERR_CONNECTION_RESET`）。
  通常のPowerShellウィンドウから `git push` する。
- **Cloudflare の Build output directory は Root directory からの相対パス。**
  Root=`site` なら出力は `dist`（`site/dist` と書くと404になる）。
- **Cloudflare は Pages を Workers に統合中。** 新規作成UIは Workers に誘導される。
  Pages の作成画面は `dash.cloudflare.com/?to=/:account/pages/new/provider/github`。
- Astro 7 は **Node 22.12.0 以上**。`site/.node-version` で固定済み。

### その他

- **Wikidata のラベルにゼロ幅文字が混入することがある**（実例: `ブレイキング・コップス2`）。
  スラッグ生成で壊れるので正規化してから保存している。
- **APIレスポンスの `service` はオブジェクト**（文字列ではない）。
  ドキュメントからは読み取れず、実通信で初めて分かった。

### Markdown と画像（2026-08-23 に踏んだもの）

- **日本語では `**強調**` が成立しないことがある。**
  CommonMark は前後の文字種で開閉を判定するため、`〜します。**次の文` のように
  閉じ記号の直前が句点だと閉じられず、`**` がそのまま画面に出る。
  → `〜します**。次の文` と書く。**品質ゲートが自動検出して公開を止める**
  （`pipeline/core/verify.ts` の `unpairedEmphasis`）。
- **`#` で始まる行はそのまま本文として公開される。**
  Markdown にコメント記法は無い。記事にメモを書き残さないこと。
  実際に11行が公開されていた。気づきはテンプレートに書く。
- **SVG の `@font-face` も `FONTCONFIG_FILE` も効かない**（どちらも実測）。
  画像生成でシステムフォントに依存すると、Cloudflare のビルド環境（Linux）で
  日本語が豆腐になる。→ **opentype.js で文字をパスに変換**し、フォントを同梱している。
- **Astro は `src/pages/_*` を無視する。** 検証用ページの名前を `_` で始めると
  ビルドされず、原因が分かりにくい。
- **`widths` に元画像より大きい数値を書くとビルドが落ちる**（`astro:assets`）。

---

## 5. 費用の現状

| 項目 | 月額 |
|---|---|
| ドメイン `mihoudairader.com` | 約125円（年1,500円） |
| Cloudflare Pages | 0円 |
| GitHub（Private） | 0円（Actions無料枠2,000分に対し使用見込み約40分） |
| Streaming Availability API | 0円（無料枠500req/月に対し設計消費約250） |
| LLM（月15本想定） | 約$1.7（Claude Sonnet 5） |

**実質の固定費はドメイン代だけ。**

---

## 6. 収益化の見通し（下方修正済み）

当初は U-NEXT 等の高単価ASP案件（1件1,000〜1,500円）を主力に見込んでいたが、
**APIがこれらのサービスをカバーしていないため、データで裏付けた導線は作れない。**

現実的な構成:

| 手段 | 位置づけ |
|---|---|
| Amazonアソシエイト（Prime Video） | 主力。単価は低いが導線が自然 |
| Disney+ のASP案件 | 新着配信（月16件前後）と配信終了済み記事で訴求できる。終了予定は取れない |
| Apple TV+ のASP案件 | 収集が月2〜3件しかなく、記事への露出はほぼ期待できない |
| U-NEXT等のASP案件 | 検索リンク方式で一般導線としてのみ |
| AdSense | 記事20〜30本たまってから |

**収益化のスピードは当初想定より遅い**と見ておくこと。
