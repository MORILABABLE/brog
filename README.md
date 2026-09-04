# brog

テーマを差し替えられる自動ブログ基盤。第一作のテーマは動画配信（日本）。

| 目的 | 読むファイル |
|---|---|
| **ブラウザで記事・デザインを編集する** | **[docs/EDITING.md](./docs/EDITING.md)** |
| **ショート動画の台本を直す・カット画像を作る** | **[shorts/README.md](./shorts/README.md)** |
| **背景・ロゴ・バナー・OG画像を変える** | **[docs/APPEARANCE.md](./docs/APPEARANCE.md)** |
| **記事の軸・タイトルの決まりと根拠** | **[docs/ARTICLE-RULES.md](./docs/ARTICLE-RULES.md)** |
| **作業を再開する / 引き継ぐ** | **[docs/HANDOVER.md](./docs/HANDOVER.md)** |
| **他ジャンルでブログを増やす** | **[docs/NEW-THEME.md](./docs/NEW-THEME.md)** |
| **検索流入を増やす（施策と根拠）** | **[docs/GROWTH.md](./docs/GROWTH.md)** |
| **どの検索語を狙うか・新しい記事ジャンル（考察）** | **[docs/KEYWORDS.md](./docs/KEYWORDS.md)** |
| **作品ページを実装する（設計）** | **[docs/WORK-PAGES.md](./docs/WORK-PAGES.md)** |
| **U-NEXT の収集（APIの外側）** | **[docs/UNEXT.md](./docs/UNEXT.md)** |
| **翌月のラインナップを先出しで書く** | **[docs/ANNOUNCEMENTS.md](./docs/ANNOUNCEMENTS.md)** |
| 設計の全体像・判断の理由 | [DESIGN.md](./DESIGN.md) |
| ドメイン・GitHub・Cloudflare の操作 | [DEPLOY.md](./DEPLOY.md) |

現在のフェーズ: **P1（サイト土台）完了** — 公開手順は **[DEPLOY.md](./DEPLOY.md)**

```
brog/
├ pipeline/      収集パイプライン（テーマ非依存）
├ theme-packs/   テーマ定義（差し替え単位）
├ data/          収集済みイベント・台帳・邦題キャッシュ
├ shorts/        ショート動画の台本（記事と同時に生成・手で詰める）
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
| `new` | 新規配信開始 | `arrivals`（ジャンル別）／`arrivals-service`（サービス別） |
| `removed` | 配信終了済み | `ended`（配信終了予定を取れないサービスのみ） |
| `expiring` | **配信終了予定（日付付き）** | `leaving`（サービス別） |
| `upcoming` | 配信開始予定 | `upcoming`（サービス×ジャンルの先出し記事）／`arrivals` 末尾の「これから配信開始予定」 |

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
npm run collect                        # 直近7日の new / removed / expiring / upcoming
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

ワークフローは3本ある。**見に行く先と頻度が違うので分けてある。**

| ワークフロー | いつ | 何をするか |
|---|---|---|
| `collect` | 毎週 火・金 04:00 JST | 配信APIから変化を収集 |
| `collect-unext` | 毎週 火・金 06:00 JST | U-NEXT を実ブラウザで収集 |
| **`announce`** | **毎月 25〜31日 05:00 JST** | **翌月ラインナップの告知が出たら取り込む**（→ [docs/ANNOUNCEMENTS.md](./docs/ANNOUNCEMENTS.md)） |

`announce` は「出ているか」を先に判定し、記事1本ぶんの本数が出た日にだけ
取り込んで通知する。出ていない日（404）は静かに終わる。

### 更新の通知（サイトには出ない）

収集しただけでは何が増減したか分からないので、収集のたびに**Issue が立ち、
GitHub からメールが届く**。中身は次の4つ。

- サービス×種別の件数（取りこぼしの兆候に気づくため）
- **まもなく見放題配信開始**（7日以内に始まる作品名・開始日・あと何日）
- **新たに判明した配信終了予定**（作品名・終了日・残り日数）
- API無料枠の消費（`data/api-usage.json` に月別で記録）

「まもなく見放題配信開始」だけは**差分ではなく在庫**から出す。告知は月に一度しか
出ないので、差分で送ると公表された日の1通にしか載らず、実際に配信が始まる日には
何も届かない（→ [docs/ANNOUNCEMENTS.md](./docs/ANNOUNCEMENTS.md) の 4-4）。
そのため**収集の変化が0件の日でも、その日から始まる作品があれば Issue が立つ**
（同じ日に二度は立たない）。それ以外で変化が0件の回は Issue を作らない。

追加のシークレット登録は不要で、
ワークフローの `permissions: issues: write` と `GITHUB_TOKEN` だけで動く。

```bash
npm run notify -- --dry-run       # 送らずに本文を確認する（APIも状態も触らない）
npm run notify -- --all           # 収集済みの全件を対象にする
```

> 通知が届かないときはリポジトリの Watch 設定を見る。
> 本文で `@` メンションしているので、通常は購読状態に関わらず届く。

**通知先を増やすには** `pipeline/notify/channels/` に1ファイル足して
`pipeline/notify/index.ts` の表に1行足すだけ（`NOTIFY_CHANNEL=github-issue,discord` のように併用可）。
通知の中身を組み立てる `pipeline/core/digest.ts` はデータソースも通知先も知らないので、
U-NEXT 等を将来足しても**通知側は無改修**で新サービスを含む。

---

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run collect` | 配信状況の変化を収集して記録 |
| `npm run collect:unext` | **U-NEXT の新着・配信終了予定を収集する（APIキー不要）**→ [docs/UNEXT.md](./docs/UNEXT.md) |
| `npm run collect:announce` | **各社が前月末に出す翌月ラインナップの告知を取り込む**→ [docs/ANNOUNCEMENTS.md](./docs/ANNOUNCEMENTS.md) |
| `npm run collect:announce -- --check` | 告知が出ているかだけ見る（何も書かない・API消費なし） |
| `npm run unext:refresh` | U-NEXT の作品台帳を取り直す（**終了日の変更を見つける**） |
| `npm run unext:menu` | U-NEXT のジャンル・カテゴリIDを調べる |
| `npm run unext:ng` | **U-NEXT のアフィリエイトで扱えない作品の一覧を作る**（TBS／日テレ／FOD）。月1回でよい → [docs/AFFILIATE.md 12節](./docs/AFFILIATE.md) |
| `npm run check:unext` | **ビルド済みのサイトを U-NEXT のガイドラインで検査する**（禁止表現・掲載NG作品・必須文言）。`cd site && npm run build` のあとに実行する |
| `npm run notify` | **前回以降の変化を運用者に通知する（Issue→メール）。API消費なし** |
| `npm run notify -- --dry-run` | 送らずに通知本文だけ表示する |
| `npm run research` | **これから書く記事の作品を日本語版 Wikipedia で下調べする（無料・キー不要）**。作風・評判・広がり方を事実で書くための素材 → [templates/writing.md](./theme-packs/streaming-jp/templates/writing.md) |
| `npm run enrich` | 収集済みイベントに Wikidata の情報を後追いで足す（無料・APIキー不要）。原語・制作会社・**監督・出演者の日本語表記** |
| `npm run write -- --list` | **作れる記事と素材件数の一覧**。あわせて**どの記事にも載っていない素材**を締切の近い順に出す（→ [docs/HANDOVER.md 4節](./docs/HANDOVER.md)）。**前月ぶんで宙に浮いた素材も別枠で出る**（月末に始まり翌月に収集された作品） |
| `npm run write -- --refresh` | **公開済みの記事のうち、いまのデータと食い違っているもの**を急ぐ順に出す（見放題終了予定 → 見放題終了 など）。API消費なし → [docs/EDITING.md](./docs/EDITING.md) |
| `npm run write -- --refresh --emit` | そのうち1本ぶんのプロンプトを書き出す。**前の版の本文が付く**（書き直しは差し替え） |
| `npm run write -- --register --type … --slug …` | 公開済みの記事を**控え**（`data/articles.json`）に登録する。2026-09-02 より前の記事だけ一度必要 |
| `npm run retire` | **月が過ぎた記事の名乗り直しを一覧する**（`配信終了予定` → `配信終了済み`）。書き換えない・API消費なし |
| `npm run retire -- --write` | 実際に書き換える。**frontmatter の `category` と `tags` の2行だけ**で、本文もタイトルも触らない。毎日 GitHub Actions が自動で回している（`.github/workflows/retire.yml`）ので、手で打つ必要は普段ない |
| `/article` | **このセッションで記事を執筆（API課金なし）** |
| `/refresh` | **このセッションで書き直しをまとめて回す（API課金なし）** |
| `npm run write -- --type <記事> [--genre <ジャンル>] --emit` | プロンプトを `data/draft/prompt.md` に書き出す |
| `npm run write -- --apply` | `data/draft/response.md` を検証して記事にする |
| `npm run write -- --type <記事> [--genre <ジャンル>]` | LLM APIで生成して書き出す（課金あり） |
| `npm run write -- ... --dry-run` | プロンプトだけ表示（無料） |
| `npm run preview` | 収集済みデータが記事としてどう見えるかを表示（API消費なし） |
| `cd site && npm run shorts` | **ショート動画のカット画像を台本から作る（1080×1920）**→ [shorts/README.md](./shorts/README.md) |
| `npm run refresh:images` | **作品ポスターのURLを取り直す（6ヶ月ごと）**→ [docs/APPEARANCE.md 11節](./docs/APPEARANCE.md#11-作品ポスターの取り扱い許諾取り直し契約終了) |
| `npm run refresh:images -- --dry-run` | 取り直す対象だけ表示（API消費なし） |
| `npm run catalogs` | 対象国のサービス一覧と theme.yaml の解決結果 |
| `npm run probe -- /changes country=jp ...` | APIの生レスポンスを表示（フィールド名の検証用） |
| `npm run typecheck` | 型チェック |

## 記事の種類

`npm run write -- --list` が唯一の一覧。現在は6タイプ。

| 記事 | 軸 | 内容 |
|---|---|---|
| `leaving --service <社>` | サービス | 今月見放題が終了**する**作品（Netflix / Prime Video / U-NEXT） |
| `ended --service <社>` | サービス | 今月見放題が終了**した**作品（終了予定を取得できないサービス＝現在は Disney+） |
| `arrivals-service --service <社>` | サービス | 今月見放題配信が始まった作品（Netflix / Prime Video / U-NEXT） |
| `arrivals --genre <ジャンル>` | ジャンル | 同・アニメ / 洋画・海外ドラマ / 邦画・国内ドラマ |
| `upcoming --genre <ジャンル> --service <社>` | 主題 | **配信開始予定**。各社が前月末に公表する翌月ラインナップを、配信が始まる前にジャンル別で出す → [docs/ANNOUNCEMENTS.md](./docs/ANNOUNCEMENTS.md) |
| `special --kind … --topic …` | 主題 | **特報**。書きたい主題と時期をそのつど指定して出す |

**記事は必ず軸を1本だけ名乗る。** サービス軸の記事に他社を混ぜない。
サービスを横断してよいのは**ジャンル軸と主題軸だけ**で、
**配信終了はサービス軸だけ**にする（ジャンル別の終了記事は作らない）。
同じ作品が他社でも同じ日に終わるときだけ、**表を足さない一文の相互参照**は許す
（書き方は [docs/EDITING.md](./docs/EDITING.md)）。恒久的に横断させたいなら主題軸で1本立てる。
タイトルは初回も更新版も `【2026年9月】…` で始め、更新日は本数の直後に置く。

    初回　 【2026年9月】Netflixで見放題配信が終了予定の作品36本｜007シリーズ5作
    更新版 【2026年9月】Netflixで見放題配信が終了予定の作品42本【9月12日更新】｜追加は踊る大捜査線

決まりは [`templates/naming.md`](./theme-packs/streaming-jp/templates/naming.md)、
根拠と実測は **[docs/ARTICLE-RULES.md](./docs/ARTICLE-RULES.md)**。
品質ゲートが機械的に検査する（`shared.ts` の `titleIssues()`）。

**同じ月・同じ軸の記事を2本作らない。** 2回目からは同じスラッグを書き直す（更新版）。
記事が増えるのではなく、記事が育つ。

**特報**は「ユーザーが明示的に作りたい時期・内容」を、月次記事と同じテンプレ・
同じ品質ゲートで作るための記事タイプ。`/article` に指示を渡せば作れる。

```bash
npm run write -- --type special --kind expiring --topic "「007」シリーズ" --slug 007-netflix --match "007" --month 2026-09 --emit
```

配信開始は月に300〜400本あり1記事に収まらないので、ジャンルでも分けている。
振り分けは Wikidata の原語（`data/origins.json`）と API の `originalTitle` で機械的に行う
（`theme-packs/streaming-jp/genres.ts`）。判定できない作品は記事に出さない
（実測で終了予定の16〜27%・配信開始の22%。**だからジャンル軸は主にできない**）。

**`leaving` と `ended` は別カテゴリで、混ぜてはいけない。**
前者はまだ観られる（急ぐ意味がある）、後者はもう観られない（他サービスを探す）で、
読者に渡すものが正反対だから。`ended` は「お見逃しなく」「今のうちに」といった
表現を検出すると**公開を止める**（`article-types/shared.ts` の `MISLEADING_AFTER_END`）。

**記事の種類を増やすときに触るのは、テンプレートと記事タイプの2ファイルだけ。**
CLI もスラッシュコマンドも変えなくてよい。手順は
`theme-packs/streaming-jp/article-types/index.ts` の冒頭にある。

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
解決できないのは Wikidata に項目が無い新作。結果は `data/titles.json` にキャッシュされ、
二度は問い合わせない。

**Wikidata で解決できなくても、日本の作品なら原語表記が使える**（2026-09-01 追加）。
API の `originalTitle` は日本の作品にかぎり**日本語表記のまま返る**ので、
邦題が取れていない作品にはこれを充てる（`pipeline/core/events.ts` の `withJapaneseTitle`）。

```
MOBILE SUIT GUNDAM HATHAWAY The Sorcery of Nymph Circe
  → 機動戦士ガンダム 閃光のハサウェイ キルケーの魔女   （原語表記から）
```

充てるのは**ひらがな・カタカナを含むものだけ**。原語表記は「原語」であって日本語とは
限らず、漢字だけの題は中国語と見分けがつかないため（実測: 早春晴朗）。
どちらも取れなければ**原題のまま扱う**（捏造しない）。

## 対象サービスの制約と、U-NEXT等への導線

日本で API から取得できるのは8社（`npm run catalogs` で確認）。
**U-NEXT・Hulu・DMM TV は含まれない。**

採用しているのは **Netflix / Prime Video / Disney+ / Apple TV+** の4社。

**ただし `expiring`（配信終了予定）が実際に返るのは Netflix と Prime Video の2社だけ。**
2026年8月の実測（6回の収集・1,089件）では Disney+ と Apple TV+ の expiring は0件だった
（取得上限による打ち切りではない）。したがって:

| サービス | 配信終了予定 | 扱い |
|---|---|---|
| Netflix / Prime Video | 取れる | `leaving` で**終了前**に知らせる |
| Disney+ | 取れない | `ended` で**終了後**にまとめ、他サービスへの導線を出す |
| Apple TV+ | 取れない | 更新が月2〜3件と少なく、記事にならない |

`upcoming`（配信開始予定）は4社とも0件で、`arrivals` の「これから配信開始予定」節は
APIの素材では一度も出力されていない。詳細は `theme-packs/streaming-jp/theme.yaml` の catalogs 節。

**この穴は各社の告知で埋めている（2026-08-28〜）。** 配信各社は前月末に翌月の
ラインナップを自社サイトで告知しているので、そこから作品名・配信開始日・独占区分だけを
読み取り、`kind: upcoming` として記録する（`npm run collect:announce`）。
配信が始まる前に「9月から配信開始」の記事を書けるのはこの経路だけ。
画像も Wikidata と配信APIを経由して**従来と同じ許諾済みの経路**で用意する。

- 何が動いているか・各社の告知の出方 → **[docs/ANNOUNCEMENTS.md](./docs/ANNOUNCEMENTS.md)**

対象外の Hulu / DMM TV には**検索リンク方式**で導線を作る。
作品別の配信状況を取れるAPIは月2.2万円〜（TMDB商用）で見合わないため、
「配信中」と主張せず各社のサイト内検索へ作品名を渡すリンクだけを出す。

```
▸ 他サービスで探す： [U-NEXT] [Hulu] [DMM TV]
```

規約上クリーンで、誤情報にもならず、読者にとっては1クリックで確認できる。
URLは `theme.yaml` の `search_links` にあり、ASPのディープリンクに差し替えれば成果計測もできる。

### U-NEXT だけは自前で取っている（2026-08-25〜）

**U-NEXT は検索リンクの段階を卒業した。** このAPIに無いのは変わらないが、
新着・配信終了予定・見放題かポイントかを**自前で収集している**（`npm run collect:unext`）。
配信終了日まで取れるので、`leaving` を U-NEXT 単独で書ける。

- 何が動いているか・データの形 → **[docs/UNEXT.md](./docs/UNEXT.md)**
- なぜそうしてよいのか・法務上の整理 → [docs/SOURCES-UNEXT-HULU.md](./docs/SOURCES-UNEXT-HULU.md)

**Hulu には同じことをしない。** 利用規約 第3条(3) が自動化手段でのアクセスを
明示的に禁止しているため。技術的には U-NEXT より簡単だが、やらない。

## 記事生成について

生成手段は2つあり、**どちらも同じ品質ゲートを通る**。

### A. このセッションで書く（API課金なし・推奨）

```
/article
```

Claude Code が素材を読んで執筆し、検証まで通す。API料金がかからない。
手動でやる場合は同じことを3ステップで:

```bash
npm run write -- --emit     # data/draft/prompt.md を書き出す
# prompt.md を読んで記事を書き、data/draft/response.md に保存
npm run write -- --apply    # 検証して site/ に書き出す
```

**画像はビルド時に自動生成される**（`site/package.json` の `prebuild`）。
SNS用のカード画像と、本文の小段落に挟むセクション画像の2種類。
文字はフォントをパスに変換しているので、Windows でも Cloudflare のビルド環境（Linux）でも
同じ絵になる。詳細は [docs/APPEARANCE.md](./docs/APPEARANCE.md#9-記事ごとのカード画像)。

**新しく記事を書いたときだけ、本文への画像の挿し込みを1回実行する。**

```bash
cd site && npm run sections -- --write
```

画像自体はビルドが作るが、記事ファイルへの `![…]()` の追記はここでしか行わない
（ビルドが記事を書き換えるのを避けるため）。何度実行しても結果は同じ。

### 公開済みの記事を書き直す（2026-09-02〜）

```
/refresh
```

**終了日が過ぎるのは、収集の差分に一度も出てこない出来事。** 予告した日に何かが届く
わけではなく、ただ過ぎるだけなので、差分を見ていても気づけない。
月を名乗らないURLを書き直し続ける記事（`series` の保存版）は、
**書き直すまでタイトルもバッジも表の全行も「終了予定」と言い続ける。**

```bash
npm run write -- --refresh          # どれが書き直しどきかを並べる（API消費なし）
npm run write -- --refresh --emit   # いちばん急ぐ1本のプロンプトを書き出す
```

判定に使うのは**記事の控え**（`data/articles.json`）。記事を書き出すたびに
「どの指示で作ったか」（`--topic` / `--match` など）が記録される。
これらは人が決めた値で**記事のどこにも残らない**ので、控えが無いと書き直せない。

> **書き直しは「差し替え」であって「書き下ろし」ではない。**
> **あらすじも、一度調べた作品の特徴も、書き直す必要はない。**
> **「見放題が終了した状態」で読んでも違和感が出ないところだけを直して、記事を遷移させる。**
> `--emit` は**同じスラッグの記事があれば前の版の本文をプロンプトに載せる**
> （シリーズの書き直しだけでなく**月次記事の更新版も同じ**）。
> 変えるのは①事実が変わって嘘になった箇所と、②今回はじめて素材に入った作品だけ。
> 決まりは [docs/EDITING.md](./docs/EDITING.md) と
> [`templates/series.md`](./theme-packs/streaming-jp/templates/series.md)。

**毎日の通知（Issue）にも同じ一覧が出る。** 顔ぶれが変わった日にだけ届くので、
書き直すまで毎日鳴り続けることはない。

### 「終了しました」と書く前に、他社を見る（2026-09-02〜）

シリーズ記事が「見放題配信が終了した」に切り替わる判定は、
**その記事が選んだ素材だけ**を見ている。他社での配信開始は素材に入らないので、
**Netflixで終了・Amazon Prime Videoでは配信開始を観測したまま**の作品があると、
記事は「終了しました」と書いてしまう。**公開後に誤りになりうる唯一の形。**

品質ゲート（`--apply`）と `--refresh`、そして**毎日の通知**が同じ検査を掛ける
（`pipeline/core/cross-service.ts`）。

> ★ **「他社で配信中」とは言わない。** 当サイトが持っているのは変化の観測であって
> 現在の在庫ではない（Disney+ と Apple TV+ は終了予定を返さず、終了の観測も遅れる）。
> **検査は warn で、公開は止めない。** 渡すのは「確かめる材料」まで。

### ショート動画の台本も同時にできる（2026-08-25〜）

`/article` で記事を書くと、**同じ素材からショート動画（30秒）の台本のたたき台**が
`shorts/<スラッグ>.md` にできる。カット割り・テロップ・概要欄まで入っている。

```powershell
cd site && npm run shorts     # 台本からカット画像を作る（1080×1920）
```

**フックは記事で見つけた「まとまり」そのもの**（同じ日に終わる同一シリーズなど）で、
それは記事を書いた時点で分かっている。だから記事と同時に作るのがいちばん安く正確になる。

| 記事タイプ | 台本 | 理由 |
|---|---|---|
| `leaving` | 付く | 締切があるのでショートに最も向く |
| `arrivals` | 付く | まとまりが強い月は成立する |
| `ended` | **付かない** | 「もう観られない」を30秒で誤解なく伝える型が無い |

**台本は記事の品質ゲートを通らない。** 別ファイル（`data/draft/short.md`）に書き、
検査はすべて警告どまり。台本の不備で記事の公開が止まるのは優先順位が逆だから。

> **作品ポスターは動画に使えない。** 使えるのは自前生成の画像だけ。
> 理由は [docs/APPEARANCE.md 11節](./docs/APPEARANCE.md#ポスターは動画に使わない2026-08-25-決定)。
> 台本の直し方・素材の可否は [shorts/README.md](./shorts/README.md)。

### B. LLM API で生成する

```bash
npm run write
```

1記事あたり約$0.11（Claude Sonnet 5）。定期実行を自動化する場合はこちら。
**この経路では台本を作らない**（台本には別の指示が要り、2度目の呼び出しになるため）。

> **どちらの経路でも `verify` を必ず通る。** 生成手段だけが差し替わり、
> 検証・frontmatter組み立て・書き出しは共通のコードを使う。

**テンプレートを調整するときは `npm run write -- --dry-run`。**
LLMを呼ばずにプロンプトだけ表示するので、何度試しても無料。

記事の構成・文体・禁止事項は `theme-packs/streaming-jp/templates/` にある
（`leaving.md` / `arrivals.md`、共通の文言は `fixed-phrases.md`）。
**これらを編集すれば全記事の構成が変わる。コードは触らなくてよい。**

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
