# ブラウザで編集する（github.dev）

最終更新: 2026-08-09

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

| 変えたいもの | ファイル |
|---|---|
| **色・文字サイズ・余白・全体の見た目** | `site/src/styles/global.css` |
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
