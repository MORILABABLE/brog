# ブラウザで編集する（github.dev）

最終更新: 2026-08-21

> 記事テンプレートの編集・本番URL・デプロイ手順は、このファイルの後半にある。
> [記事テンプレートを編集する](#記事テンプレートを編集する) ／
> [本番サイトのURL](#本番サイトのurl) ／
> [記事を公開する（デプロイ）](#記事を公開するデプロイ)

ターミナルを使わずに、記事もデザインもブラウザ上で編集できる。

---

## 開き方

1. https://github.com/MORILABABLE/brog を開く
2. キーボードで **`.`（ピリオド）** を押す

ブラウザ上に **VS Code** が開く。インストール不要、無料、スマホのブラウザでも動く。

> URLを直接開いてもよい: https://github.dev/MORILABABLE/brog

---

## 保存とデプロイの流れ

github.dev には「保存」ボタンが無く、**コミットが保存にあたる。**

1. ファイルを編集する（自動で下書き保存される）
2. 左端の **ソース管理**（枝分かれのアイコン）を開く
3. 変更ファイルの **＋** を押してステージする
4. 上のメッセージ欄に何をしたか書く（例: `記事の文面を修正`）
5. **✓ Commit & Push** を押す

コミットすると **Cloudflare が自動でビルドし、数分でサイトに反映される。**

> **ビルドが失敗しても公開中のサイトは壊れない。**
> Cloudflare は成功したビルドだけを公開するので、失敗した場合は
> 前の状態が維持される。「反映されない」だけで済む。
> 失敗の有無は GitHub のコミット一覧に ✅ / ❌ で表示される。

---

## 記事を編集する

```
site/src/content/posts/2026-08-leaving.md
```

ファイルの先頭に `---` で囲まれた部分がある。ここは**構造化データ**なので形式を崩さないこと。

```markdown
---
title: '【2026年8月】…'          ← 記事タイトル（変更可）
description: '…'                 ← 検索結果の説明文（30〜160字）
pubDate: 2026-08-09              ← 公開日（YYYY-MM-DD）
category: 'leaving'              ← leaving / arrivals / ranking のいずれか
tags: ['Netflix', '配信終了']
sources:                          ← 出典。消さないこと（API利用規約上の義務）
  - label: '…'
    url: '…'
dataAsOf: 2026-08-09             ← 配信情報の基準日
---

ここから下が本文。自由に編集してよい。
```

**注意点**

- `description` が30字未満または160字超だと**ビルドが落ちる**
- `category` は3つのいずれか以外を書くと**ビルドが落ちる**
- `sources` を消すと**ビルドが落ちる**（帰属表示は規約上の義務）
- 引用符 `'` を本文中で使うぶんには問題ない。frontmatter 内で使うときは `''` と2つ重ねる

## 記事を削除する

左のエクスプローラーでファイルを右クリック → **Delete** → コミット。

---

## デザインを編集する

> **背景グラフィック・ロゴ・ヘッダーバナー・OG画像**を変えるなら
> 専用の手順書がある → **[APPEARANCE.md](./APPEARANCE.md)**

| 変えたいもの | ファイル |
|---|---|
| **色・文字サイズ・余白・全体の見た目** | `site/src/styles/global.css` |
| **背景グラフィック・本文カード** | `site/src/styles/global.css`（[APPEARANCE.md](./APPEARANCE.md)） |
| サイト名・タグライン・説明文 | `site/src/config.ts` |
| ヘッダー（上部のメニュー） | `site/src/components/Header.astro` |
| フッター（下部の表記） | `site/src/components/Footer.astro` |
| トップページの構成 | `site/src/pages/index.astro` |
| 記事ページの構成 | `site/src/pages/posts/[...slug].astro` |
| 記事一覧のカード | `site/src/components/PostCard.astro` |
| ページ全体の枠・SEO設定 | `site/src/layouts/BaseLayout.astro` |
| 運営者情報・プライバシーポリシー等の文面 | `site/src/pages/about.astro` など |

### 色を変える例

`site/src/styles/global.css` の先頭に色の定義がまとまっている。

```css
:root {
  --bg: #ffffff;          /* 背景色 */
  --text: #1a1d21;        /* 文字色 */
  --accent: #1f6feb;      /* リンク・強調色 */
  ...
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216;        /* ダークモードの背景色 */
    ...
  }
}
```

**ライトモードとダークモードの2箇所**があるので、両方直すこと。
片方だけ変えると、もう一方の配色で読めなくなることがある。

---

## 変更を確認する

github.dev には**プレビュー機能もビルド機能も無い。**確認する方法は3つ。

| 方法 | 手間 | わかること |
|---|---|---|
| コミットして本番で見る | 数分待つ | 確実。失敗しても現行サイトは無事 |
| Markdownのプレビュー | 即座 | 記事の見た目のみ（デザインは反映されない） |
| ローカルで `npm run dev` | ターミナルが必要 | 完全。編集しながら即座に反映 |

記事の文面だけなら本番で確認して問題ない。
**デザインを大きく変えるときはローカルの `npm run dev` を推奨する。**
壊れていることに気づくのが早く、試行錯誤の回数も稼げる。

```powershell
cd C:\Users\grate\brog\site
npm run dev
```
→ http://localhost:4321/ 。ファイル保存で自動反映。Ctrl+C で停止。

---

## 記事を新しく作る場合

**手で作らず、パイプラインで生成すること。**
frontmatter を手書きすると日付や出典を間違えやすく、
それは記事の信頼性を直接損なう。

```
/article
```

このコマンドで収集済みデータから記事を生成できる（API課金なし）。
詳細は [../README.md](../README.md) を参照。

---

## ローカルとの同期

github.dev で編集した内容は GitHub 上にある。
ローカルで作業を再開するときは、**先に取り込むこと。**

```powershell
cd C:\Users\grate\brog
git pull
```

これを忘れて両方で編集すると、後で統合作業が必要になる。

収集は GitHub Actions で**毎週 火・金の 04:00 JST に自動実行**され、
`data/` の更新がそのままコミットされる。手元に無い変更が増えていることがあるので、
作業前の `git pull` は習慣にしておく。

---

# 記事テンプレートを編集する

毎月の配信終了記事を「どう書くか」は、**コードではなく Markdown 3枚**で決まっている。
この3枚はプログラムを触らずに編集してよい。

| 変えたいもの | ファイル |
|---|---|
| **記事の構成・文体・禁止事項** | `theme-packs/streaming-jp/templates/leaving.md` |
| **毎月そのまま使う固定文言** | `theme-packs/streaming-jp/templates/fixed-phrases.md` |
| **お手本として見せる文例** | `theme-packs/streaming-jp/templates/examples/leaving-excerpt.md` |

## それぞれの役割

### leaving.md — 構成と文体

リード → 終了日順のまとまり → その他の注目作 → 全終了作品リスト → 他のサービスで探す → まとめ、
という記事の骨格と、文体のルールが書いてある。

「セクションの最後は『〜しましょう』で締める」「記号は全角に統一する」
「記事の作り方の解説を書かない」といった方針はここを直す。

### fixed-phrases.md — 固定文言

**言い換えずに毎月そのまま使う文言**だけを集めたファイル。
`{月}` `{サービス}` `{基準日}` `{本数}` の部分が実際の値に置き換わる。

| キー | 使われる場所 |
|---|---|
| `lead-first-sentence` | 本文の1文目（`【9月終了】…65本が見放題終了対象です。`） |
| `lead-closer` | リードの最後の1文（`シリーズや名作を…観ておきましょう！`） |
| `other-services-intro` | 「他のサービスで探す」の冒頭 |
| `attribution` | 記事の末尾（API利用規約上の義務） |

> **ここを直すと、記事を書くときの指示と、書いたあとの検査の両方が同時に変わる。**
> 文言の出典が1か所なので、片方だけ古いまま残ることがない。

### examples/leaving-excerpt.md — お手本

「こう書けていれば正解」という文例。2026年8月号から4か所を抜粋し、
それぞれ**なぜ良いのか**を添えてある。記事を書くときに参考として渡される。

内容ではなく**書き方**の手本なので、作品名や日付は毎月置き換わる前提。

## コードを触る必要があるもの

| 変えたいもの | ファイル | 場所 |
|---|---|---|
| 1記事に載せる上限本数 | `theme-packs/streaming-jp/article-types/leaving.ts` | `MAX_ITEMS` |
| 素材の選び方・並び順 | 同上 | `select()` |
| 品質チェックの内容 | 同上 | `verify()` |
| 対象サービス・タイムゾーン | `theme-packs/streaming-jp/theme.yaml` | — |
| `/article` の手順書 | `.claude/commands/article.md` | — |

## 品質チェックの見方

`npm run write -- --apply` のときに2種類の指摘が出る。

| 表示 | 意味 |
|---|---|
| `[NG]` | **公開を止める。** 誤情報・規約違反・固定文言の欠落など |
| `[警告]` | 止めない。文体の指摘なので、判定が外れることもある |

よく出る警告は「セクションの最後が視聴を促す形で終わっていません」。
段落そのものが「どれから観るべきか」の助言になっていれば、無視してよい。

---

# 本番サイトのURL

| 見たいもの | URL |
|---|---|
| トップページ | https://mitokou.com |
| 2026年9月の配信終了記事 | https://mitokou.com/posts/2026-09-leaving |
| 2026年8月の配信終了記事 | https://mitokou.com/posts/2026-08-leaving |
| 配信終了カテゴリの一覧 | https://mitokou.com/category/leaving |
| サイトマップ（Search Console用） | https://mitokou.com/sitemap-index.xml |

## 記事URLの決まり方

記事のURLは**ファイル名がそのまま**になる。

```
site/src/content/posts/2026-09-leaving.md
                       └─────┬─────┘
https://mitokou.com/posts/2026-09-leaving
```

末尾にスラッシュは付かない（`site/astro.config.mjs` の `build.format: 'file'` による）。

> 独自ドメインをまだ繋いでいない場合は、Cloudflare Pages が発行する
> `https://<プロジェクト名>.pages.dev` で同じ内容が見られる。
> プロジェクト名は Cloudflare ダッシュボード → **Workers & Pages** で確認できる。

> ドメインを変えるときに直すのは2か所だけ。
> `site/src/config.ts` の `SITE.url` と `site/public/robots.txt` の `Sitemap:` 行。

---

# 記事を公開する（デプロイ）

## 全体の流れ

```
収集 ──→ 記事生成 ──→ ビルド確認 ──→ commit & push
                                          ↓
                            Cloudflare Pages が自動ビルド
                                          ↓
                                    本番に反映（数分）
```

**手動でファイルをアップロードする作業は無い。** push が公開のトリガー。

## 手順

### 1. データを集める（通常は不要）

週2回自動で走っているので、普段は飛ばしてよい。
最新の状況が欲しいときだけ実行する。

```powershell
cd C:\Users\grate\brog
npm run collect
```

> APIの無料枠は **500リクエスト/月**。自動実行で月250ほど使うので、
> 手動実行は必要なときだけにする。

### 2. 記事を書く

Claude Code のセッションで:

```
/article
```

ターミナルで手順を分けたい場合:

```powershell
npm run write -- --emit --month 2026-09     # 指示と素材を書き出す
                                             # data/draft/prompt.md を読んで記事を書き、
                                             # data/draft/response.md に保存する
npm run write -- --apply                    # 検証して site/ に書き出す
```

`--month` を省略すると**当月**が対象になる。
**9月の記事を8月のうちに書く**ときは `--month 2026-09` を付ける。
終了予定の記事は月に入る前に出したほうが読者に役立つので、こちらが基本。

`[NG]` が出たら `data/draft/response.md` を直して `--apply` をやり直す。

### 3. 壊れていないか確認する

```powershell
cd C:\Users\grate\brog\site
npm run build
```

frontmatter のスキーマ検証もここで走る。**通らなければ push しない。**

見た目まで確認するなら:

```powershell
cd C:\Users\grate\brog\site
npm run dev
```
→ http://localhost:4321/posts/2026-09-leaving

### 4. 公開する

```powershell
cd C:\Users\grate\brog
git add -A
git commit -m "2026年9月の配信終了記事を追加"
git push
```

数分で本番に反映される。

## 反映されたか確認する

| 見る場所 | 分かること |
|---|---|
| GitHub のコミット一覧 | ✅ / ❌ でビルドの成否 |
| Cloudflare → Workers & Pages → 該当プロジェクト → **Deployments** | ビルドログ。失敗の原因はここに出る |
| https://mitokou.com/posts/2026-09-leaving | 実際に公開された記事 |

> **ビルドが失敗しても公開中のサイトは壊れない。**
> Cloudflare は成功したビルドだけを公開するので、「反映されない」だけで済む。

## 公開した記事を書き直す

手順は同じでよい。`data/draft/response.md` を直して `--apply` すると
**同じファイルが上書きされる**（`2026-09-leaving.md`）。
そのまま commit & push すれば本番も更新される。

URL（スラッグ）は変わらないので、検索エンジンの評価も引き継がれる。

本文を少し直すだけなら、`site/src/content/posts/2026-09-leaving.md` を
直接編集してもよい。github.dev からでも同じ。

## やってはいけないこと

- **frontmatter を手書きで新規作成しない。** 日付や出典を間違えると記事の信頼性を直接損なう
- **ビルドを通さずに push しない。** 落ちる原因のほとんどは frontmatter
- **`data/` 以下を手で消さない。** 台帳（`ledger.json`）が壊れると、
  一度記事にした作品を再び記事にしてしまう
- **`sources` と末尾の提供元表記を消さない。** API利用規約上の義務

5. 今後の手順

作業を始める前に必ずこれを打つ習慣にしてください。自動収集が回っているので、放っておくと必ずズレます。

直した手順

公開するときは、pull を commit の後に入れてください。

cd C:\Users\grate\brog

git add -A                   # 変更を対象に含める
git commit -m "何をしたか"    # 手元の履歴に刻む（まだ外に出ない）
git pull                     # ← ここ。GitHub側の変更を取り込む
git push                     # GitHubに送る → Cloudflareが自動ビルド

先にコミットしておけば、自分の変更は履歴に確保済みなので pull が安全に走ります。この順なら push が拒否されることもありません。

---