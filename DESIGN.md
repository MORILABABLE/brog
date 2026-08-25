# 自動ブログ基盤 — 設計仕様書

最終更新: 2026-08-01

## 0. プロジェクトの位置づけ

「決まったテーマの情報をAIが自動収集 → 定型テンプレで記事化 → サイトへ自動公開」を回す基盤。

**第一作のテーマは動画配信（streaming-jp）だが、テーマは差し替え可能な設計とする。**
コアのパイプラインはテーマを一切知らず、`theme-packs/` 配下を差し替えるだけで別テーマのブログが立ち上がる。

---

## 1. 確定仕様

| 項目 | 決定 |
|---|---|
| 第一テーマ | 動画配信サービスの新着告知＋ランキング解説＋配信終了告知（日本向け） |
| 対象サービス | **Netflix / Amazon Prime Video / Disney+ / Apple TV+ の4社**（U-NEXT・Hulu・DMM TV はAPI非対応。3.2 参照） |
| 作品範囲 | 映画＋ドラマ＋アニメ（`show_type`: movie / series） |
| 更新頻度 | 新着 週2 ＋ ランキング 週1 ＋ 配信終了 隔週1 ＝ **月約15本** |
| **データソース** | **Streaming Availability API**（Movie of the Night）。無料枠で開始 → 収益化後にPro |
| 公開先 | Astro（静的サイト）＋ Cloudflare Pages |
| 公開フロー | **PR承認制**（AIが下書きPRを作成 → 人がマージ → 本番公開） |
| LLM | プロバイダ差し替え可能（Claude / Gemini / OpenAI互換）。開発基準は Claude Sonnet 5 |
| 収益化 | ASPアフィリエイト（主力）＋ Amazonアソシエイト ＋ AdSense |
| ドメイン | **`mihoudairader.com`**（見放題レーダー）。選定理由は [DEPLOY.md](./DEPLOY.md#取得したら) を参照 |
| サイト名 | **見放題レーダー** — 「消える前に、気づける。」 |
| サーバー | 不要（静的サイト＋GitHub Actions）。必要なのは独自ドメインのみ |

---

## 2. アーキテクチャ

```
┌──────────────────────────────────────────────────────┐
│  GitHub Actions (cron)                               │
│                                                      │
│  collect ──→ write ──→ verify ──→ PR作成             │
│    │           │          │                          │
│  /changes   LLM(差替可)  品質ゲート                  │
│  ledger重複除外          （落ちたらPRを作らない）    │
└──────────────────────────────────────────────────────┘
                        ↓ マージ
              Cloudflare Pages → 本番公開
```

収集と執筆を分離しているのは、**APIリクエストを節約しつつ記事生成だけを何度でもやり直せる**ようにするため。
収集結果は `data/events/*.jsonl` に貯まり、執筆はそこを読む。

### ディレクトリ構成

```
brog/
├ pipeline/                          ← コア（テーマ非依存・再利用資産）
│  ├ theme.ts                        テーマパック読み込み
│  ├ sources/
│  │  ├ types.ts                     Source / Work / ChangeEvent インターフェース
│  │  └ streaming-availability.ts    アダプタ
│  ├ llm/                            （P2）
│  │  ├ types.ts                     LLMProvider インターフェース
│  │  └ providers/
│  │     ├ anthropic.ts              Claude
│  │     ├ gemini.ts                 Gemini
│  │     └ openai-compatible.ts      OpenAI / DeepSeek / Groq / OpenRouter / Ollama
│  ├ notify/                         運用者への通知（読者には出さない）
│  │  ├ types.ts                     Channel インターフェース
│  │  ├ state.ts                     どこまで通知したかの記録
│  │  └ channels/
│  │     ├ github-issue.ts           Issue を立てる → GitHubがメールする
│  │     └ console.ts                標準出力（--dry-run の実体）
│  ├ core/
│  │  ├ events.ts                    イベントログ＋台帳（重複防止）
│  │  ├ digest.ts                    通知本文の組み立て（ソース・通知先を知らない）
│  │  ├ api-usage.ts                 API無料枠の消費量を月別に記録
│  │  ├ write.ts                     （P2）記事生成
│  │  ├ verify.ts                    （P2）品質ゲート
│  │  └ publish.ts                   （P3）ブランチ作成→PR作成
│  ├ bench.ts                        （P2）プロバイダ横断の品質・コスト比較
│  └ cli/
│     ├ collect.ts                   変化を収集
│     ├ notify.ts                    収集結果を運用者に通知
│     ├ catalogs.ts                  対象国のサービス一覧（ID確定用）
│     └ probe.ts                     生レスポンス確認
│
├ theme-packs/
│  └ streaming-jp/                   ← 第一作（差し替え単位）
│     ├ theme.yaml                   国・言語・対象サービス
│     ├ article-types/               （P2）
│     ├ templates/                   （P2）記事テンプレ
│     └ ranking-themes.yaml          （P2）ランキングのお題プール
│
├ site/                              ← Astro（P1）
│  └ src/
│     ├ content/posts/*.md
│     ├ components/AdSlot.astro      広告枠（env フラグでON/OFF）
│     └ pages/
│        ├ index.astro
│        ├ posts/[slug].astro
│        ├ category/[cat].astro
│        ├ privacy.md                ← AdSense必須
│        ├ about.md                  ← AdSense必須
│        └ contact.md                ← AdSense必須
│
├ data/
│  ├ events/{YYYY-MM}.jsonl          収集した変化の追記ログ
│  ├ ledger.json                     既出作品・既出お題の台帳
│  ├ notify-state.json               どこまで通知したか
│  └ api-usage.json                  API無料枠の月別消費（概算）
│
└ .github/workflows/
   ├ collect.yml                     収集（週2）
   ├ new-arrivals.yml                （P3）新着告知（週2）
   ├ ranking.yml                     （P3）ランキング（週1）
   ├ leaving.yml                     （P3）配信終了（隔週1）
   └ refresh.yml                     （P3）鮮度チェック（月1）
```

---

## 3. データソースの選定（重要な決定・調査済み）

### 3.1 なぜ TMDB を使わないか

当初 TMDB を前提に設計していたが、**規約上使えないことが判明した**。

TMDB API 利用規約 Section 2.A:
> "The license in Paragraph 1.A above does not permit any commercial use"
> "...or for driving traffic or generating revenue for a website...**including from advertising displayed on or by the website**"

**広告収入・アフィリエイト収入は明確に商用利用に該当する。** 商用ライセンスは $149/月〜。
Watchmode も同様に無料枠は非商用限定。

### 3.2 採用: Streaming Availability API (Movie of the Night)

https://docs.movieofthenight.com/

**無料枠でも商用利用が明示的に許可されている唯一の選択肢。**

TERMS.md:
> "The API User can use the data provided for commercial purposes."

| プラン | 料金 | リクエスト/月 |
|---|---|---|
| **Free** | **$0** | **500** |
| Pro | $39 | 25,000 |
| Ultra | $59 | 100,000 |

**方針: Free で開始 → アフィリエイトが回り出したら Pro へ。**
動画配信の入会案件は1件1,000〜1,500円なので、**月4〜6件の成約で $39 を回収**できる。

### 3.2.1 日本のカバレッジ（実測・2026-08-01）

`npm run catalogs` で確認した、日本で取得可能な8社:

```
apple / crunchyroll / curiosity / disney / mubi / netflix / prime / zee5
```

**U-NEXT・Hulu・DMM TV は存在しない。** 当初想定していた高単価ASP案件
（U-NEXT等、1件1,000〜1,500円）の「この作品はU-NEXTで配信中」という
データ裏付けのある導線は作れない。収益設計への影響は 7章 に反映済み。

採用は **Netflix / Prime Video / Disney+ / Apple TV+ の4社**。
crunchyroll（日本でのサービス提供有無が不明）、mubi・curiosity・zee5（ニッチ）は保留。

**幸い、採用4社はすべて `expiring` に対応している。**
当初想定（6社中3社のみ）より条件が良く、配信終了告知を全対象サービスで書ける。

### 3.3 義務: 帰属表示

サイトフッターと**各記事**に以下を表示する必要がある（`verify` で機械的に強制する）。

> 配信情報は Streaming Availability API by Movie of the Night 提供
> https://www.movieofthenight.com/about/api

データの再配布（API化・DB提供・データエクスポート）は禁止。記事にする分には問題ない。

### 3.4 `/changes` エンドポイント — 設計を単純化する鍵

配信の開始・終了が専用エンドポイントで取れる。**全カタログを毎日走査して差分を取る必要がない。**

| change_type | 意味 | 使う記事タイプ |
|---|---|---|
| `new` | 新規配信開始 | タイプA（新着告知） |
| `removed` | 配信終了済み | タイプC-1（事後まとめ） |
| **`expiring`** | **配信終了予定（日付付き）** | **タイプC-2（終了告知）** |
| `upcoming` | 配信開始予定 | 先出し告知 |

**制約**: `expiring` / `upcoming` は **Netflix / Prime Video / Disney+ / Apple TV / Max / Mubi のみ**対応。
U-NEXT・Hulu・DMM TV は事後の `removed` しか取れない。
この制約は `theme.yaml` の `supports_upcoming` に持たせている。

ページングはカーソル方式、**25件/ページ**。

### 3.5 リクエスト予算

| 用途 | 月間リクエスト |
|---|---|
| 変化の収集（`new`/`removed`/`expiring`、週2回） | 約200 |
| ランキング素材（`/shows/search/filters`、週1回） | 約20 |
| 予備 | 約30 |
| **合計** | **約250 / 500** |

無料枠の半分。`MAX_PAGES_PER_CALL` で1回の実行が枠を食い潰さないようにしている。

**収集頻度を上げる余地は小さい。** 週3回（約375）までは収まるが、週4回以上・毎日は
枠を割る。実測では Prime Video が終了予定を出す猶予が11日あるので（[HANDOVER](./docs/HANDOVER.md)）、
週2回でも取りこぼさない。**頻度は上げず、収集結果の届け方を足す**方針を取っている（3.9）。

消費量は `data/api-usage.json` に月別で積んでいる。429 が返ってから気づくのを避けるため、
アダプタがリクエスト数を数え、収集が途中で落ちても `finally` で必ず記録する。
あくまで自己申告の概算なので、正確な残量は提供元のダッシュボードで見ること。

### 3.6 邦題の解決（Wikidata）

**API の `output_language` は en / es / fr / tr / de のみ。日本語は非対応。**
タイトル・あらすじが英語で返るため、そのままでは日本語ブログとして成立しない
（読者は邦題で検索するので、英題のままではSEOが機能しない）。

**解決策: Wikidata から正式な邦題を引く。**

- **CC0** — 商用利用に制約がない（TMDBと違ってここが決定的）
- APIキー不要・無料
- IMDb ID (P345) → 取りこぼしを TMDB ID (P4947/P4983) で再照会

**LLMに翻訳させない。** 邦題は翻訳ではなく配給時に決まる固有名詞なので推測が効かない。

| 原題 | LLMが誤りやすい | 正解（Wikidata） |
|---|---|---|
| Paul | ポール | **宇宙人ポール** |
| The Northman | ノースマン | **ノースマン 導かれし復讐者** |
| Ghost | ゴースト | **ゴースト/ニューヨークの幻** |

#### 実測の解決率（2026-08-01・81件）

| 種別 | 解決率 |
|---|---|
| 映画 | 50/59（85%） |
| シリーズ | 9/22（41%） |
| 合計 | **59/81（73%）** |

解決できないのは Wikidata に項目自体が無い新作（特に配信開始直後のオリジナル作品）。
**解決できなかったものは原題のまま扱い、LLMに邦題を捏造させないこと**（verifyで強制）。
時間が経てば Wikidata 側に項目ができるため、`refresh` ジョブで再解決する。

結果は `data/titles.json` にキャッシュし、同じ作品を二度問い合わせない。
Wikidata のラベルにはゼロ幅文字が混入することがあるため正規化してから保存する。

### 3.7 対象外サービスへの導線（検索リンク方式）

U-NEXT / Hulu / DMM TV の作品別配信状況を自動取得する手段を調査した結果：

| ソース | 3社カバー | 商用利用 | 費用 |
|---|---|---|---|
| Streaming Availability（採用中） | ✗ | ✓ | $0〜39/月 |
| TMDB | ✓ | 要商用ライセンス | **$149/月** |
| Watchmode | 一部 | 無料枠は非商用 | **$349/月** |
| JustWatch | ✓ | 大口パートナーのみ | 商談 |

**作品別配信状況をデータで裏付けるには月2.2万円が最低ライン。** 現段階では見合わない。

**採用: 検索リンク方式。**「配信中」と主張せず、各社のサイト内検索へ作品名を渡すリンクだけを出す。

- 他社データを一切使わないので**規約上クリーン**
- 断定しないので**誤情報にならない**
- 読者は1クリックで確認できるため**実用性はむしろ高い**
- ASPのディープリンクに差し替えれば成果計測もできる
- 追加APIコスト**ゼロ**

URLは `theme.yaml` の `search_links` に持たせ、**2026-08-01 に実測で疎通確認済み**。

```
U-NEXT  https://video.unext.jp/freeword?query={query}
Hulu    https://www.hulu.jp/search?q={query}
DMM TV  https://tv.dmm.com/search/?keyword={query}
（疎通確認済み・未採用: Lemino, ABEMA）
```

検索クエリは邦題を優先し、解決できていなければ原題を使う。
邦題に含まれるスラッシュ（例: ゴースト/ニューヨークの幻）は検索でヒットしにくいため空白に開く。

#### 却下した案

**LLMに配信状況を調べさせる。** 配信状況は頻繁に変わりLLMの知識は古いため誤情報を量産する。
邦題を Wikidata から引くのと同じ理由で、事実は権威あるソースから取る。

**DMM公式アフィリエイトAPI**（無料・DMM TVのみ）は保留。
ドキュメントが年齢認証ゲートの内側にあり見放題判定の可否を確認できないうえ、
アダルト系（FANZA）と一体の基盤のため **AdSense審査へのリスク**が残る。

---

## 3.8 日付の扱い（横断的な規律）

開発機は JST、GitHub Actions は **UTC** で動く。
`Date` のローカル系ゲッターを使うと日付が1日ずれ、
**「8月3日終了」の作品が8月4日と表示される**（実際に一度作り込んで検出・修正した）。

- 日付の整形と月別集計は必ず `pipeline/core/datetime.ts` を経由する
- 基準タイムゾーンは `theme.yaml` の `utc_offset_minutes`（日本 = 540）
- 実装は「UTCタイムスタンプにオフセットを足し、**UTC系ゲッターで読む**」
- JST・UTC 両環境で出力が一致することを確認済み

---

## 3.9 運用者への通知（サイトには出さない）

収集は自動で回るが、**何が増減したかを人が知る手段が無かった。**
サイトの常設ページには出るものの、能動的に見に行かないと気づけず、
実質「記事を作るときに初めて分かる」状態だった。

そこで収集の下流に通知層を1枚足している。**記事でもページでもない、運用専用の出口。**

```
sources/*  →  data/events/*.jsonl  →  ┬→ site/      読者向け（既存）
                                      └→ notify/    運用者向け（追加）
```

### 設計上の要点

**通知層はデータソースを知らない。** 読むのは `ChangeEvent` の列だけで、
`core/digest.ts` に API 名は一度も出てこない。将来 U-NEXT 等を別アダプタで
足しても、`theme.yaml` の `catalogs` に1行増えるだけで通知側は無改修で新サービスを含む。
収集ソースを差し替え可能にしたのと同じ発想を、出口側にも通している。

**「何を書くか」と「どこへ送るか」を分ける。** `core/digest.ts` が件名と本文だけを返し、
`notify/channels/*` が届け方を持つ。通知先を増やすときに触るのは
`channels/` に1ファイルと `notify/index.ts` の表の1行だけ（LLMプロバイダと同じ形）。

**APIを消費しない。** 通知は `data/events` を読むだけなので、
収集頻度を上げずに可視性だけを上げられる（3.5 の予算に影響しない）。

**収集とは別コマンドにする。** 収集が成功して通知だけ失敗したときに、
収集をやり直さずに通知だけ再送できる。ワークフロー側もコミットを `if: always()` にして、
通知の不調で収集ぶんが捨てられないようにしている。

### 通知先に GitHub Issue を選んだ理由

| | |
|---|---|
| 追加の秘密情報が要らない | Actions の `GITHUB_TOKEN` だけで動く。SMTPパスワードやWebhook URLのように失効して静かに止まるものが無い |
| 結果としてメールで届く | GitHubが購読者に送る。スマホのGitHubアプリにも出る |
| 流れて消えない | あとから遡れて、対応したら閉じられる |
| **規約上の安全** | privateリポジトリ内で完結する。第三者の手に渡らないので、8章の再配布禁止に触れない |

**LINEオープンチャットは採らない。** 外部から自動投稿する経路が存在せず
（代替に使われていた LINE Notify は2025年3月末で終了）、かつ参加リンクで
他者が入れる場に収集データをまとめて流すのは、**8章の再配布禁止に触れるおそれがある。**
自分だけが受け取るメール・privateなIssue・自分専用のチャットは「他者に提供」に当たらない。

### 通知しないもの

- **記事の作成タイミング** — 運用ルール（前月20〜22日に作る）は HANDOVER に文章で残す
- **1件ずつの速報** — 収集は週2回なので、まとめて1通でよい
- 変化0件の回 — Issue を作らない（ノイズにしない）

---

## 4. LLM抽象化レイヤー

差し替えを本当に効かせるため、**プロバイダ固有機能を一切使わない**。

| 使わない | 代わりに |
|---|---|
| Web検索ツール | Streaming Availability API を自前で取得 |
| tool use / function calling | JSONを文字列で出力させ **zod で検証** |
| プロバイダ固有のキャッシュ・思考モード形式 | 使わない。必要ならアダプタ内部に隠蔽 |

```ts
export interface LLMProvider {
  name: string
  generate(req: {
    system: string
    prompt: string
    maxTokens: number
    json?: boolean
  }): Promise<{
    text: string
    usage: { inputTokens: number; outputTokens: number }
    costUsd: number      // プロバイダ比較のため必須
  }>
}
```

### アダプタは3つで足りる

- `anthropic.ts` — Claude
- `gemini.ts` — Gemini
- `openai-compatible.ts` — **OpenAI / DeepSeek / Groq / OpenRouter / Together / Ollama（ローカル）を全部カバー**

### 切り替え方法（環境変数のみ）

```bash
LLM_PROVIDER=anthropic       LLM_MODEL=claude-sonnet-5
LLM_PROVIDER=gemini          LLM_MODEL=<モデルID>
LLM_PROVIDER=openai-compat   LLM_BASE_URL=https://api.deepseek.com/v1  LLM_MODEL=deepseek-chat
```

### 実装上の注意（実装時に判明）

- **`temperature` をインターフェースに含めない。** Claude Opus 5 / Sonnet 5 は
  サンプリングパラメータを送ると **400 を返す**。他社に合わせて渡す設計にすると
  Anthropic 側が壊れる。文体の制御はプロンプトで行う。
- **`budget_tokens` は廃止済み。** 思考の深さは `output_config.effort` で制御する。
  共通インターフェースでは `effort: low|medium|high` として抽象化し、
  Gemini では `thinkingBudget` にマップしている。
- **Anthropic アダプタは公式SDKを使う。** 抽象化はアダプタの境界で保たれるため、
  内部でSDKを使っても差し替え可能性は損なわれない。リトライと型付きエラーが得られる分堅い。
- **料金表を持つのは Anthropic だけ。** 他社は変動が速く確実な表が無いため、
  推測値で誤った比較を出すより `LLM_PRICE_INPUT` / `LLM_PRICE_OUTPUT` で明示させ、
  未設定なら「不明」と正直に報告する。
- Claude Sonnet 5 は **2026-08-31 まで導入価格 $2/$10**（通常 $3/$15）。
  期間判定して適用しているため、コスト表示は実額に一致する。

### bench.ts

同じ収集データを各プロバイダに流し、**出力・コスト・検証通過率**を並べて比較する。
開発は Claude Sonnet 5 で品質の天井を作り、そこから安いモデルがどこまで迫れるかを数字で判断する。

---

## 5. 記事タイプ

`ArticleType` インターフェースで実装され、差し替え・追加が可能。

> **`leaving` はサービス別に分割した（2026-08-23）。**
> 当初はジャンル別（アニメ / 洋画 / 邦画）を検討したが、実測で**成立しないと分かった**。
> 配信終了は洋画ライブラリの入れ替えが主因で、邦画が慢性的に枯れる。
>
> | | 合計 | アニメ | 洋画 | 邦画 |
> |---|---|---|---|---|
> | leaving 9月 | 65 | 6 | 47 | **3** |
> | leaving 8月 | 147 | 41 | 78 | **11** |
> | ended 8月 | 76 | 16 | 52 | **3** |
>
> サービス別なら 9月＝ Netflix 35 / Prime Video 30 で両方成立する。
> さらに **Googleサジェストの実測で「配信終了予定␣」の候補10件が10件ともサービス名**
> （netflix / アマプラ / プライムビデオ / …）で、検索需要とも軸が一致している。
> ジャンル分類は原語不明で判定できない作品が月9〜17件出て捨てられるが、
> サービスは100%確実に分かる、という副次的な利点もある。
>
> バリアントのCLIフラグは記事タイプごとに変えられる（`variantFlag` / `variantNoun`）。
> `arrivals` は `--genre`、`leaving` は `--service`。

### 5-1. 常設ページ（LLM不使用）

記事とは別に、**URLが固定で中身だけが更新されるページ**を持つ。

```
/leaving/netflix        Netflix で終了予定の作品を全部
/leaving/prime-video    Prime Video で終了予定の作品を全部
/arrivals/netflix       Netflix で直近60日に見放題入りした作品
/arrivals/prime-video   同上
/arrivals/disney-plus   同上
/stats                  月ごとに何本増えて何本減ったか（定点観測）
```

月次記事が公開時点のスナップショットなのに対し、こちらは `collect` のたびに
全件が入れ替わる。**被リンクと検索評価が1つのURLに集中する**のが狙い。

出すのは「作品名・日付・評価」という事実だけなので**文章生成が要らない**。
生成コストゼロ、誤情報のリスクゼロ、品質ゲートも不要。
実装は `site/src/lib/events-data.ts` に集約し、
リポジトリ直下の `data/events/*.jsonl` をビルド時に直接読む。

**月次記事の取りこぼしを埋める役割もある。** Prime Video は終了の11日前にしか
終了予定を出さないため、月次記事はどう頑張っても月後半分を落とす（4節の落とし穴）。
常設ページは収集のたびに追従するのでそこが埋まる。

#### 薄いページを作らない

`/arrivals/apple-tv` は**あえて作っていない**。収集期間を通して `new` が1件しか
無かったため。1件だけのページは薄いページの量産になり、検索評価とAdSense審査の
両方で不利になる。件数が増えたら `ARRIVALS_SERVICES` に足す。

#### `/stats` は「観測できた数」であって「起きた数」ではない

ここが他にまねできない資産である一方、**統計の体裁をした誤情報になりやすい**。

- 収集を始めた月より前は出さない。観測していないので数えられない
  （2026-07 は収集開始前なので除外している）
- 進行中の月は「集計中」と明示する。月末まで増えるため
- 収集間隔より短い期間だけ配信された作品は取りこぼす、とページ本文に明記する

この区別を曖昧にした瞬間に、このページは価値ではなく負債になる。

```ts
export interface ArticleType {
  id: string
  category: 'leaving' | 'arrivals' | 'ranking'
  select(events: ChangeEvent[], ledger: Ledger, ctx: ArticleContext): ChangeEvent[]
  buildPrompt(items: ChangeEvent[], ctx: ArticleContext): { system: string; prompt: string }
  tags(items: ChangeEvent[], ctx: ArticleContext): string[]
  slug(ctx: ArticleContext): string
  verify(md: string, items: ChangeEvent[]): string[]
}
```

### frontmatter はLLMに書かせない（重要な設計判断）

日付・カテゴリ・出典・基準日は**収集データから機械的に組み立てる**。
LLMに任せると誤った日付や出典が混入し、それは記事の信頼性を直接壊す。
**LLMが書くのはタイトル・説明文・本文の3つだけ。**

出力形式は JSON ではなく区切り記号方式を使う。

```
TITLE: ...
DESCRIPTION: ...
---BODY---
（Markdown本文）
```

長いMarkdown本文をJSON文字列に入れるとエスケープ事故が起きやすいため。
形式が崩れていればパースが `null` を返し、記事化を中止する。

### 記事構成はテンプレートファイルに持つ

`theme-packs/streaming-jp/templates/leaving.md` に記事の構成・文体・禁止事項を書き、
プロンプト組み立て時に読み込んで注入する。
**テンプレートを編集すれば全記事の構成が変わり、コードは触らなくてよい。**

### 5.1 タイプA — 新着配信告知（週2）

ソース: `change_type=new`

```markdown
# 【2026年8月1日】Netflix・Prime Video ほか 今週の配信開始作品まとめ

リード：今週◯本が追加。注目はこの3本。

## Netflix
### 作品カード（各作品）
  ポスター / 邦題 / 公開年 / ジャンル / 評価
  あらすじ要約（AI）
  ★ 一言コメント（AI）        ← 独自性
  ★ こんな人におすすめ（AI）  ← 独自性

## Amazon Prime Video / Disney+ / U-NEXT / Hulu / DMM TV
（同上）

## 今週の一本（500字の深掘り）  ← 独自性の核

> 配信情報は Streaming Availability API by Movie of the Night 提供（2026年8月1日時点）
```

### 5.2 タイプB — テーマ別ランキング解説（週1）

ソース: `/shows/search/filters`（ジャンル・評価・年代で絞り込み）

```markdown
# Netflixで観られる密室スリラー映画ベスト10

リード：★選定基準を明示（評価◯以上・年代・尺 等）
        ← 独自性であり、SEOの信頼性シグナル

## 10位 … 1位
  基本情報 / あらすじ / ★なぜランクインしたか / ★こんな人におすすめ / 配信サービス

## 比較表
## まとめ
```

**ランキング根拠の明示は、AI生成コンテンツがGoogleに評価されるための実質的な条件。**

お題は `ranking-themes.yaml` にプールし、順に消化＋台帳で既出管理。

### 5.3 タイプC — 配信終了（隔週1）

**C-1 事後まとめ** — ソース: `change_type=removed`（全6サービス対応）

```markdown
# 【2026年8月】Netflix・Prime Video ほか 配信終了した作品まとめ

## 今月終了した作品（サービス別・作品カード）
## 惜しまれる1本（深掘り）                    ← 独自性
## 他サービスで今も観られる代替作品            ← ★アフィリエイト導線として最強
```

**C-2 終了予告** — ソース: `change_type=expiring`（Netflix / Prime Video / Disney+ のみ）

```markdown
# 【8月中に終了】Netflixから消える前に観ておきたい作品

## 終了日順に一覧（終了日は API が返す確定情報）
## 各作品：あらすじ / なぜ観るべきか / 他サービスでの配信状況
```

> C-1 / C-2 の「他サービスで今も観られる」セクションは、
> 「Netflixで終了 → U-NEXTでは配信中」という形で**高単価ASP案件への自然な導線**になる。
> 収益面で最も強い記事タイプ。

---

## 6. 品質ゲート（verify）

**これを通らない記事はPRを作らない。**

### 共通ルール
- frontmatter 必須項目（title / description / date / category / tags / sources）
- 本文 2,000字以上（AdSense対策）
- **帰属表示（Movie of the Night）の存在チェック** ← 規約上の義務
- 情報の時点注記があるか
- 既存記事とのタイトル類似度チェック（重複防止）
- 禁止語・過度な断定表現のチェック

### タイプ固有ルール
- 新着告知: 作品数が下限（3本）以上／全作品にポスターURLがあるか
- ランキング: 順位が10件揃っているか／選定基準セクションの存在／比較表の存在
- 配信終了: 終了日の記載があるか／代替作品セクションの存在

---

## 7. 収益化

> **前提が変わった点**: API の日本カバレッジに U-NEXT・Hulu・DMM TV が無いため（3.2.1）、
> 当初主力に見込んでいた高単価ASP案件を「この作品はU-NEXTで配信中」という
> データ裏付き導線として使えない。収益構成を以下に組み直した。

| 手段 | 単価 | 位置づけ |
|---|---|---|
| **U-NEXT / Hulu の入会案件**（VC・afb） | 917〜1,320円/件 | **主力**。検索リンク方式で導線化（3.7）。配信状況は主張せず「探す手段」を提供する |
| **Amazonアソシエイト** | 紹介料＋Prime無料体験 500円/件 | 対象4社で唯一提携できる。24時間クッキーが実体 |
| AdSense | 数十〜数百円/日 | 記事が溜まってから |
| DMM TV の入会案件 | 1,539〜1,691円/件 | **当面見送り**。FANZA同一基盤でAdSense審査にリスク（3.7） |
| Apple TV+ / Disney+ の入会案件 | 1,299〜1,720円/件 | **現在提携できない**（下記）。実績が出てから再挑戦 |

> **前提の訂正（2026-08-23 調査）**
> 当初この表は「Apple TV+ / Disney+ は対象サービスなのでデータ裏付きで訴求できる」
> と書いていたが、**両社とも提携できない**ことが判明した。
> Disney+ はクローズド案件（実績者のみ招待）、Apple TV+ は招待制。
> **Netflix に至っては公式のアフィリエイトプログラムが存在しない。**
>
> 結果として、**収益の主戦場は「対象4社」ではなく「対象外3社」になった。**
> データを持っている4社のうち金になるのは Amazon だけで、
> 「探す先」として出している U-NEXT / Hulu のほうが単価が桁違いに高い。
> API に無いから諦めた3社が収益では主力になるという逆転が起きている。
>
> 提携状況の一覧・実装・落とし穴は **[docs/AFFILIATE.md](./docs/AFFILIATE.md)**。

**「他サービスで今も観られる代替作品」セクションは対象4社の範囲では成立する**
（例: 「Netflixで8月終了 → Prime Videoでは配信中」→ Amazonアソシエイト）。
収益面で最も強い記事タイプであることは変わらない。

### AdSense審査の要件（Phase 4）
- 独自ドメイン（サブドメイン不可）
- 記事20〜30本以上、各2,000字以上 → **週3本ペースで約2ヶ月**
- プライバシーポリシー / 運営者情報 / お問い合わせ の3ページ必須
- **審査通過まで広告コードは入れない**（`AdSlot` は env フラグでOFF）

### SEO作り込み
- 構造化データ JSON-LD（Article / BreadcrumbList / ItemList）
- サイトマップ・RSS 自動生成
- 関連記事の自動内部リンク
- OG画像の自動生成

---

## 8. 法務・規約上の注意

- **商標**: サイト名・ドメインに `netflix` `amazon` 等を含めない。記事内での言及は問題ない
- **帰属表示**: Movie of the Night への表記とリンクをサイトと各記事に必須（verifyで強制）
- **再配布禁止**: 取得データをAPI・DB・エクスポートとして他者に提供しない
- **著作権**: あらすじは要約とし全文転載しない
- **画像**: 作品ポスターの**再ホストは提供元の許諾済み**（2026-08-25、"Yes, you can."）。
  ビルド時に取得して自ドメインから配信する。**最低6ヶ月ごとの取り直し**が推奨されている
  （`npm run refresh:images`）。無料枠は帯域 1GB/月＝実測でビルド1回あたり3.3MB。
  取得した画像は git に入れない（契約終了時に消せなくなるため）。
  運用は [docs/APPEARANCE.md 11節](./docs/APPEARANCE.md#11-作品ポスターの取り扱い許諾取り直し契約終了)

---

## 9. コスト

| 項目 | 開始時 | 収益化後 |
|---|---|---|
| 独自ドメイン | 年1,500円 | 年1,500円 |
| Cloudflare Pages | 無料 | 無料 |
| GitHub Actions | 無料枠内 | 無料枠内 |
| Streaming Availability API | **無料**（500req/月） | **$39/月**（25,000req/月） |
| LLM（月15本） | Sonnet: $2〜5／Gemini Flash: $0.3〜1 | 同左 |

**開始時の月額コスト: ドメイン代（月125円）＋ LLM代（数百円）のみ**

---

## 10. フェーズ計画

| | 内容 | 完了条件 |
|---|---|---|
| **P0** ✅ | 収集パイプライン（Source抽象＋SAアダプタ＋邦題解決＋台帳） | 完了。実データ81件を取得済み |
| **P1** ✅ | Astro土台＋必須3ページ＋実データ記事1本 | 完了。ビルド通過（型エラー0）。残るはドメイン取得とデプロイ操作 |
| **P2** 🔶 | LLM抽象化＋write/verify＋記事テンプレ | 配信終了タイプは完了。新着・ランキングと `bench.ts` が残 |
| **P3** | GitHub Actions＋PR自動化＋refresh | 週3回、自動でPRが届く |
| **P4** | 記事20〜30本蓄積 → AdSense申請 → ASP登録 → 広告ON | 収益化開始 |

---

## 11. 主要リスクと対策

| リスク | 対策 |
|---|---|
| 無料枠500req/月を超える | `MAX_PAGES_PER_CALL` で1実行の上限を固定。超えそうならPro($39)へ |
| `expiring` が3サービスしか取れない | 大手3社が読者の主関心。他3社は `removed` の事後報告で補う |
| ~~API側のフィールド名が想定と違う~~ | **検証済み**。`service` がオブジェクトだった点を修正して疎通確認済み |
| 邦題が解決できない作品がある（27%） | 原題のまま扱う。**LLMに捏造させない**（verifyで強制）。refreshで後日再解決 |
| 対象が4社に減り記事の網羅性が落ちる | 「配信終了告知」は4社すべてで書ける。網羅性でなく切り口で勝負する方針は不変 |
| AI量産記事がGoogleに評価されない | 選定基準の明示・独自コメント・比較表・鮮度管理で付加価値を担保 |
| 競合が強い（映画.com, Filmarks 等） | 「終了告知」と「テーマ別の切り口」で差別化。網羅性では勝負しない |
| LLM差し替えで品質が落ちる | `bench.ts` で定量比較＋verifyゲートで下限を担保 |
| 同じ作品を何度も記事にする | `data/ledger.json` で (サービス, 種別, 作品ID) を既出管理 |
