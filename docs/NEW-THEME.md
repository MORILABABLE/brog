# 新しいテーマでブログを増やす

最終更新: 2026-08-02

第一作は動画配信（`streaming-jp`）だが、この基盤はテーマを差し替えられるように作ってある。
別ジャンルで2本目を立ち上げるときの手順書。

---

## 0. 先に決めること：どの形で増やすか

3つの選択肢がある。**2本目なら A を推奨する。**

| | 方式 | 手間 | 向くとき |
|---|---|---|---|
| **A** | **リポジトリごと複製**（推奨） | 小 | 2本目。テーマ同士が独立していてよい |
| B | 1リポジトリで複数テーマ | 中 | 3本以上。運用を一箇所にまとめたい |
| C | パイプラインをnpmパッケージに切り出す | 大 | 5本以上。本格的に量産する |

### なぜ2本目は A なのか

**テーマごとに独立しているものが多いため。**

- サイト名・ドメイン・Cloudflareプロジェクト（`site/src/config.ts` と Cloudflare の設定）
- 収集データ（`data/`）
- APIキー（テーマによって使うAPIが違う）
- 記事テンプレート・記事タイプ

共有できるのはパイプラインのコードだけ。複製すればコードは重複するが、
**片方の改修がもう片方を壊さない**という利点の方が大きい。

3本目を作る段階になったら B か C を検討する。そのとき必要になる作業は下の
「B を選ぶ場合に必要な改修」に書いてある。

---

## 1. 手順（方式A）

### 1-1. リポジトリを複製する

GitHub で `brog` を開き **Use this template**（または Fork ではなくローカルから）：

```powershell
cd C:\Users\grate
git clone https://github.com/MORILABABLE/brog.git brog-<新テーマ>
cd brog-<新テーマ>
Remove-Item .git -Recurse -Force
git init
git symbolic-ref HEAD refs/heads/main
```

`.git` を消して作り直すのは、**第一作の履歴を持ち込まないため**。
新しいリポジトリを GitHub 上に作り、[DEPLOY.md](../DEPLOY.md) の手順で push する。

### 1-2. 前テーマの残骸を消す

```powershell
Remove-Item data -Recurse -Force
Remove-Item site\src\content\posts\*.md -Force
Remove-Item theme-packs\streaming-jp -Recurse -Force
```

### 1-3. テーマパックを作る

```
theme-packs/<新テーマ>/
├ theme.yaml                 収集対象・言語・タイムゾーン
├ article-types/*.ts         記事タイプ
└ templates/*.md             記事の構成・文体・禁止事項
```

`.env` に `THEME=<新テーマ>` を追加する（未設定だと `streaming-jp` を探して落ちる）。

### 1-4. 収集ソースを実装する

`pipeline/sources/<新ソース>.ts` に `Source` インターフェースを実装する。

```ts
export interface Source {
  readonly name: string
  collectChanges(opts: CollectOptions): Promise<ChangeEvent[]>
  collectWorks(query: WorkQuery): Promise<Work[]>
}
```

`Work` と `ChangeEvent` はテーマ非依存の器（`pipeline/sources/types.ts`）。
テーマ固有の情報は `work.meta` に入れる。

> **ソース選定で必ず確認すること**: **無料枠が商用利用を許可しているか。**
> 第一作では TMDB / Watchmode が「無料枠は非商用限定」で、広告収入が
> 規約上の商用利用に当たるため使えなかった。利用規約の
> commercial use の項を**実装前に**読むこと。

`pipeline/cli/collect.ts` の `new StreamingAvailabilitySource(...)` を差し替える。

### 1-5. サイトを設定する

| ファイル | 変更内容 |
|---|---|
| `site/src/config.ts` | サイト名・タグライン・説明・URL・運営者名 |
| `site/src/config.ts` の `CATEGORIES` | 記事カテゴリ（記事タイプと対応させる） |
| `site/src/content.config.ts` | frontmatter スキーマ（`category` の enum を合わせる） |
| `site/src/pages/about.astro` | データの取得元・記事作成方針 |
| `site/src/pages/privacy.astro` | データ提供元の表記 |
| `site/src/pages/contact.astro` | 連絡先 |
| `site/src/components/Footer.astro` | 帰属表示（新ソースの規約に合わせる） |
| `site/public/robots.txt` | サイトマップURL |

### 1-6. デプロイ

ドメインを取得し、Cloudflare Pages に新しいプロジェクトとして接続する。
手順は [DEPLOY.md](../DEPLOY.md) と同じ。**Root directory は `site`**。

---

## 2. 触らなくていいもの（テーマ非依存）

以下はテーマを知らない。**そのまま再利用できる。**

```
pipeline/
├ llm/                     LLM抽象化（3プロバイダ）
│  ├ types.ts  pricing.ts  index.ts
│  └ providers/{anthropic,gemini,openai-compatible}.ts
├ core/
│  ├ datetime.ts           タイムゾーン安全な日付処理
│  ├ events.ts             イベントログ＋台帳
│  ├ article.ts            記事の組み立て・LLM出力のパース
│  ├ verify.ts             共通の品質ゲート
│  └ search-links.ts       検索リンク生成
├ sources/types.ts         Source / Work / ChangeEvent
├ sources/wikidata.ts      ※作品タイトル向け。他ジャンルでは不要かも
└ theme.ts                 テーマパック読み込み
```

`site/` の以下も再利用できる：
`layouts/BaseLayout.astro`（SEO・構造化データ）、`components/*`、
`styles/global.css`、`utils/date.ts`、`pages/posts/[...slug].astro`、
`pages/category/[category].astro`、`pages/rss.xml.ts`

---

## 3. B を選ぶ場合に必要な改修

1リポジトリで複数テーマを同時運用するには、**現状のままでは動かない。**

### 問題: `data/` がテーマ別に分かれていない

```ts
// pipeline/core/events.ts（現状）
export const EVENT_DIR = join('data', 'events')
export const LEDGER_PATH = join('data', 'ledger.json')
```

`THEME=xxx` を切り替えても保存先が同じなので、**テーマ間でイベントと台帳が混ざる。**
第一作では1テーマしか無いため問題になっていないが、2テーマ目を同居させると壊れる。

### 必要な変更

```ts
// パスをテーマキーで分ける
export function eventDir(themeKey: string) {
  return join('data', themeKey, 'events')
}
export function ledgerPath(themeKey: string) {
  return join('data', themeKey, 'ledger.json')
}
```

影響する呼び出し元：

| ファイル | 関数 |
|---|---|
| `pipeline/core/events.ts` | `appendEvents` / `readEvents` / `loadLedger` / `saveLedger` |
| `pipeline/cli/collect.ts` | 上記の呼び出し（`theme.key` を渡す） |
| `pipeline/cli/write.ts` | 同上 |
| `pipeline/cli/preview.ts` | 同上 |

> `data/titles.json`（IMDb ID → 邦題のキャッシュ）は**テーマ非依存なので分ける必要はない。**
> 作品を扱う別テーマがあれば、むしろ共有した方が問い合わせが減る。

### サイトも分ける必要がある

`site/` は1テーマ分の設定しか持てない。複数テーマなら
`site-<テーマ>/` のように分け、Cloudflare にもテーマごとにプロジェクトを作る。

---

## 4. テーマ選定のチェックリスト

第一作で判明した「後から効いてくる」条件。**着手前に確認すること。**

- [ ] **データソースの無料枠が商用利用を許可しているか**
      （許可していないと収益化の時点で詰む。実装後に気づくと作り直しになる）
- [ ] **日本語のデータが得られるか**
      得られない場合、権威あるソース（Wikidata等）で補えるか。
      **LLMに翻訳させて済ませようとしないこと**（固有名詞は推測が効かない）
- [ ] **更新頻度がテーマとして成立するか**
      週2〜3本の記事が作れるだけの変化があるか
- [ ] **「変化」を検知できるか**
      新着・終了・更新などのイベントが取れるか。静的なデータだけだと記事が続かない
- [ ] **競合が放置している切り口があるか**
      第一作では「配信終了の追跡」がそれだった。網羅性で勝負しない
- [ ] **商標をドメイン・サイト名に含めていないか**
- [ ] **アフィリエイト案件が存在するか**（収益化する場合）

---

## 5. 第一作から学んだ設計原則

新テーマでも守る価値があるもの。

1. **事実はLLMに書かせない。** 日付・出典・カテゴリはデータから機械的に組み立てる。
   LLMが書くのはタイトル・説明文・本文だけ。
2. **固有名詞は権威あるソースから引く。** 解決できなければ原文のまま出す。
   推測させると外れ、SEOも信頼性も失う。
3. **品質ゲートを必ず通す。** 通らない記事は公開しない。
   verify で機械的に検出できることだけを見る（文章の良し悪しは人間が見る）。
4. **記事の構成はテンプレートファイルに置く。** コードに埋めない。
   テンプレを編集するだけで全記事の構成が変わる状態を保つ。
5. **日付処理は専用モジュールを経由する。** 環境のタイムゾーンに依存させない。
6. **持っていないデータについて断定しない。** 「配信中」と書けないなら
   検索リンクを置く。誤情報より不便の方がまし。
