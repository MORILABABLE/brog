# brog

テーマを差し替えられる自動ブログ基盤。第一作のテーマは動画配信（日本）。

| 目的 | 読むファイル |
|---|---|
| **作業を再開する / 引き継ぐ** | **[docs/HANDOVER.md](./docs/HANDOVER.md)** |
| **他ジャンルでブログを増やす** | **[docs/NEW-THEME.md](./docs/NEW-THEME.md)** |
| 設計の全体像・判断の理由 | [DESIGN.md](./DESIGN.md) |
| ドメイン・GitHub・Cloudflare の操作 | [DEPLOY.md](./DEPLOY.md) |

現在のフェーズ: **P1（サイト土台）完了** — 公開手順は **[DEPLOY.md](./DEPLOY.md)**

```
brog/
├ pipeline/      収集パイプライン（テーマ非依存）
├ theme-packs/   テーマ定義（差し替え単位）
├ data/          収集済みイベント・台帳・邦題キャッシュ
└ site/          Astro サイト（独立した npm プロジェクト）
```

`site/` は独立した npm プロジェクト。ビルドは `cd site && npm install && npm run build`。
Cloudflare Pages の Root directory には **`site`** を指定する（DEPLOY.md 参照）。

---

## P0 でやっていること

配信状況の変化を収集し、重複を除いて追記ログに貯める。

```
Streaming Availability API
   /changes ──→ 台帳で重複除外 ──→ data/events/{YYYY-MM}.jsonl
                                    data/ledger.json
```

| change_type | 意味 | 記事タイプ |
|---|---|---|
| `new` | 新規配信開始 | A: 新着告知 |
| `removed` | 配信終了済み | C-1: 事後まとめ |
| `expiring` | **配信終了予定（日付付き）** | C-2: 終了告知 |
| `upcoming` | 配信開始予定 | 先出し告知 |

収集と執筆を分けているのは、APIリクエストを節約しつつ
**記事生成だけを何度でもやり直せる**ようにするため。

---

## セットアップ

### 1. API キーを取得（無料・支払い情報不要）

https://developers.movieofthenight.com/ で登録し、API キーを取得する。

> **なぜこのAPIか**: TMDB と Watchmode は無料枠が**非商用限定**で、
> 広告やアフィリエイトを載せるサイトでは規約違反になる（TMDB規約 2.A で
> 広告収入が明示的に商用利用と定義されている）。
> Streaming Availability API は無料枠でも商用利用を明示的に許可している唯一の選択肢。
> 詳細は [DESIGN.md 3章](./DESIGN.md#3-データソースの選定重要な決定調査済み)。

**無料枠は 500リクエスト/月。** 本パイプラインの設計消費は約250/月。

### 2. 依存をインストールして .env を用意

```bash
npm install
cp .env.example .env      # PowerShell なら: Copy-Item .env.example .env
```

`.env` の `STREAMING_API_KEY=` にキーを貼る。

### 3. 対象サービスのIDを確定させる

```bash
npm run catalogs
```

日本で利用可能なサービス一覧と、`theme.yaml` の設定がどう解決されたかが出る。

**`MISS` が出たサービスは `theme-packs/streaming-jp/theme.yaml` の `id` を修正する。**
Netflix / Prime Video / Disney+ 以外（U-NEXT / Hulu / DMM TV）の ID は未検証なので、
ここで実際の登録名に合わせる必要がある。

### 4. 収集してみる

```bash
npm run collect                        # 直近7日の new / removed / expiring
npm run collect -- --days 14
npm run collect -- --kinds new,expiring
```

`data/events/{YYYY-MM}.jsonl` に変化が追記され、`data/ledger.json` に既出として記録される。
**同じ変化は二度と拾わない**ので、何度実行しても記事が重複しない。

---

## GitHub Actions で自動化する

1. GitHub にリポジトリを作成して push
2. Settings → Secrets and variables → Actions で `STREAMING_API_KEY` を登録
3. Actions タブから `collect` を手動実行して疎通確認

以降は毎週 火・金 の 04:00 JST に自動収集し、変化があれば自動コミットされる。

---

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run collect` | 配信状況の変化を収集して記録 |
| `npm run write -- --dry-run` | **プロンプトだけ表示（LLMを呼ばない・無料）** |
| `npm run write` | 記事を生成して `site/src/content/posts/` に書き出す |
| `npm run preview` | 収集済みデータが記事としてどう見えるかを表示（API消費なし） |
| `npm run catalogs` | 対象国のサービス一覧と theme.yaml の解決結果 |
| `npm run probe -- /changes country=jp ...` | APIの生レスポンスを表示（フィールド名の検証用） |
| `npm run typecheck` | 型チェック |

---

## 邦題について

**API は日本語に対応していない**（`output_language` は en/es/fr/tr/de のみ）。
タイトルは英語で返るため、**Wikidata（CC0・キー不要）から正式な邦題を引いている。**

```
Paul          → 宇宙人ポール          （「ポール」ではない）
The Northman  → ノースマン 導かれし復讐者
Ghost         → ゴースト/ニューヨークの幻
```

邦題は翻訳ではなく配給時に決まる固有名詞なので、**LLMに推測させてはいけない。**

実測の解決率（81件）: 映画 85% / シリーズ 41% / 合計 **73%**。
解決できないのは Wikidata に項目が無い新作。**残りは原題のまま扱う**（捏造しない）。
結果は `data/titles.json` にキャッシュされ、二度は問い合わせない。

## 対象サービスの制約と、U-NEXT等への導線

日本で API から取得できるのは8社（`npm run catalogs` で確認）。
**U-NEXT・Hulu・DMM TV は含まれない。**

採用しているのは **Netflix / Prime Video / Disney+ / Apple TV+** の4社。
この4社はすべて `expiring`（配信終了予定）に対応している。

対象外の U-NEXT / Hulu / DMM TV には**検索リンク方式**で導線を作る。
作品別の配信状況を取れるAPIは月2.2万円〜（TMDB商用）で見合わないため、
「配信中」と主張せず各社のサイト内検索へ作品名を渡すリンクだけを出す。

```
▸ 他サービスで探す： [U-NEXT] [Hulu] [DMM TV]
```

規約上クリーンで、誤情報にもならず、読者にとっては1クリックで確認できる。
URLは `theme.yaml` の `search_links` にあり、ASPのディープリンクに差し替えれば成果計測もできる。

## 記事生成について

**まず `npm run write -- --dry-run` を実行する。** LLMを呼ばずにプロンプトだけを表示するので、
テンプレートを直すたびに課金せずに調整できる。

記事の構成・文体・禁止事項は `theme-packs/streaming-jp/templates/leaving.md` にある。
**このファイルを編集すれば全記事の構成が変わる。コードは触らなくてよい。**

frontmatter（日付・カテゴリ・出典・基準日）は**収集データから機械的に組み立てる**。
LLMが書くのはタイトル・説明文・本文だけ。日付や出典をLLMに任せると誤りが混入し、
それは記事の信頼性を直接壊すため。

LLMの差し替えは `.env` の3行を書き換えるだけ:

```bash
LLM_PROVIDER=anthropic       LLM_MODEL=claude-sonnet-5
LLM_PROVIDER=gemini          LLM_MODEL=<モデルID>
LLM_PROVIDER=openai-compat   LLM_MODEL=deepseek-chat  LLM_BASE_URL=https://api.deepseek.com/v1
```

## 日付の扱い（重要）

開発機は JST、GitHub Actions は **UTC**。`Date` のローカル系ゲッターを使うと
日付が1日ずれ、「8月3日終了」が「8月4日」になる。

**日付の整形と月別集計は必ず `pipeline/core/datetime.ts` を経由すること。**
基準タイムゾーンは `theme.yaml` の `utc_offset_minutes`（日本 = 540）。

## トラブルシューティング

APIのレスポンス形状を確認したいとき：

```bash
npm run probe -- /changes country=jp change_type=expiring item_type=show catalogs=netflix
```

※ 実行するたびに無料枠を1消費する。

---

## テーマの差し替え

`theme-packs/` 配下のディレクトリを差し替えるだけ。
パイプライン側のコードはテーマの中身を知らない。

```bash
THEME=別のテーマ名 npm run collect
```

---

## 帰属表示の義務

API の利用規約により、**サイトと各記事**に以下の表示が必要（`verify` で機械的に強制する予定）。

> 配信情報は Streaming Availability API by Movie of the Night 提供
> https://www.movieofthenight.com/about/api

また、取得データを API・DB・エクスポートの形で他者に再配布することは禁止されている。
記事として公開する分には問題ない。
