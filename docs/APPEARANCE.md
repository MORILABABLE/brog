# 見た目を変える（背景・ロゴ・バナー・OG画像）

最終更新: 2026-08-22

> 記事の文面や色を直したいだけなら [EDITING.md](./EDITING.md)。
> こちらは**背景グラフィック・ロゴ・ヘッダーバナー・SNS共有画像**の手順書。

---

## いま何がどうなっているか

サイトの背景は**画像ファイルではなく CSS で描いている。**
淡いブルーの地に点を敷き、その上に本文を白いカードで浮かせている。

```
┌──────────────────────────────┐
│ ヘッダー（不透明・--bg）              │  ← 点は見えない
├──────────────────────────────┤
│ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ │  ← 背景グラフィック（body）
│ ・ ┌────────────────────┐ ・ │
│ ・ │ 本文カード（.content-card） │ ・ │  ← 白く浮いている
│ ・ │ 記事・カード一覧はこの中       │ ・ │
│ ・ └────────────────────┘ ・ │
│ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ │
├──────────────────────────────┤
│ フッター（不透明・--bg-subtle）       │  ← 点は見えない
└──────────────────────────────┘
```

**画像ファイルにしなかった理由**は3つ。

1. サイトはライト/ダーク両対応。画像だと明暗2枚とメディアクエリが必要になる
2. 背景は全ページに乗る。画像だと表示速度（LCP）に直撃し、広告収入にも響く
3. CSS なら数百バイトで済み、`--accent` などの既存の色変数と揃えられる

| 変えたいもの | ファイル | 節 |
|---|---|---|
| 背景の濃さ・柄 | `site/src/styles/global.css` | [1](#1-背景の濃さを変える) [2](#2-背景の柄を変える) [3](#3-背景をやめる) |
| 本文カードの見た目 | `site/src/styles/global.css` | [4](#4-本文カードを調整するやめる) |
| ロゴ・ファビコン | `site/public/favicon.svg` | [5](#5-ロゴファビコンを差し替える) |
| ヘッダーバナー | `site/src/assets/` + `index.astro` | [6](#6-ヘッダーバナーを入れる) |
| SNS共有画像 | `site/public/og-default.png` | [7](#7-og画像sns共有画像を差し替える) |

---

## 1. 背景の濃さを変える

`site/src/styles/global.css` の先頭にツマミが3つある。

```css
:root {
  --bg-tint: #eef4fd;                     /* 地の色 */
  --dot-color: rgba(31, 111, 235, 0.22);  /* 点の色 */
  --dot-gap: 22px;                        /* 点の間隔 */
}
```

**ライトとダークの2箇所にある。必ず両方直すこと。**
片方だけ変えると、もう一方の配色で背景が浮いたり沈んだりする。

| やりたいこと | 直す値 |
|---|---|
| もっと淡くしたい | `--dot-color` の末尾 `0.22` を `0.12` などに下げる |
| もっとはっきりさせたい | 同じ数字を `0.30` などに上げる |
| 点をまばらにしたい | `--dot-gap` を `28px` `32px` と広げる |
| 地の青みを強くしたい | `--bg-tint` を `#e8f0fd` などに寄せる |
| 地の青みを消したい | `--bg-tint` を `#f6f7f9`（既存の `--bg-subtle` と同じ）にする |

ダーク側の既定値はこちら。

```css
--bg-tint: #0a0d12;
--dot-color: rgba(110, 168, 254, 0.16);
```

> **ダークは点を「明るく」する。** ライトと同じ発想で暗い点を置くと、
> 暗い地に暗い点で何も見えなくなる。

---

## 2. 背景の柄を変える

点を描いているのは `body` のこの1行。

```css
background-image: radial-gradient(var(--dot-color) 1px, transparent 1.3px);
```

差し替え例。`--dot-gap` が `background-size` に効いているので、間隔はそのまま使える。

**細い格子（方眼紙）**

```css
background-image:
  linear-gradient(var(--dot-color) 1px, transparent 1px),
  linear-gradient(90deg, var(--dot-color) 1px, transparent 1px);
```

**斜めのストライプ**

```css
background-image: repeating-linear-gradient(
  45deg,
  var(--dot-color) 0 1px,
  transparent 1px 12px
);
```

もっと凝った柄が欲しいときは **Hero Patterns**（heropatterns.com・CC0）で
色と濃さを決めて CSS をコピーし、この行と差し替える。
`background-size` の指定も一緒に付いてくるので、その場合は `--dot-gap` の行を消す。

---

## 3. 背景をやめる

`site/src/styles/global.css` の `body` を元に戻す。

```css
body {
  margin: 0;
  background: var(--bg);   /* ← background-color / -image / -size の3行と差し替え */
  color: var(--text);
  font-size: 16px;
  overflow-x: hidden;
}
```

このとき[本文カードもやめる](#4-本文カードを調整するやめる)と、改修前の見た目に完全に戻る。

---

## 4. 本文カードを調整する／やめる

```css
.content-card {
  margin: 1.6rem auto 0;              /* ヘッダーとの間隔 */
  padding: 0.6rem 1.9rem 2.2rem;      /* カード内側の余白 */
  border-radius: 14px;                /* 角の丸み */
}
```

**狭い画面（47rem 以下）ではカードを解除して全幅に戻している。**
スマホで本文の横幅を削るほうが、背景が見えることより損だという判断。
この挙動は同じファイルの `@media (max-width: 47rem)` で変えられる。

**カードをやめる**なら `site/src/layouts/BaseLayout.astro` の1行を戻す。

```astro
<main id="main" class="wrap">        <!-- content-card → wrap -->
```

---

## 5. ロゴ（ファビコン）を差し替える

いま入っているのは**仮のマーク**（青い角丸に再生三角）。自作ロゴができたら差し替える。

置いてあるファイルは3つ。

| ファイル | 用途 |
|---|---|
| `site/public/favicon.svg` | 本体。モダンブラウザはこれを使う |
| `site/public/favicon-32.png` | SVG非対応の古いブラウザ向け |
| `site/public/apple-touch-icon.png` | iOS のホーム画面追加用（180×180） |

### ターミナルが使える場合

`favicon.svg` を上書きしてから、PNG を焼き直す。

```powershell
cd C:\Users\grate\brog\site
node scripts/make-icons.mjs
```

### ブラウザだけで完結させたい場合

**RealFaviconGenerator**（realfavicongenerator.net）にロゴ画像を入れ、
出てきたファイルから上の3つと同じ名前のものを `site/public/` にアップロードする。

> **アップロードは github.dev ではなく github.com から。**
> リポジトリのページで `site/public` を開き、
> **Add file → Upload files**（1ファイル25MBまで）。

### ロゴをヘッダーにも出す

`site/src/components/Header.astro` を編集する。ロゴが SVG なら
**そのままコンポーネントとして読める**（画像タグではなくインライン展開される）。

```astro
---
import { SITE, CATEGORIES } from '../config'
import Logo from '../assets/logo.svg'
---

<a class="brand" href="/">
  <Logo width={26} height={26} aria-hidden="true" />
  <span>{SITE.name}</span>
</a>
```

```css
.brand {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}
```

> **SVG のロゴは `fill="currentColor"` / `stroke="currentColor"` で作ると得。**
> ダークモードで文字色に自動追従するので、明暗2枚を用意せずに済む。

---

## 6. ヘッダーバナーを入れる

### 書き出しの寸法

| | 値 |
|---|---|
| 表示される幅 | 最大 **675px**（本文カードの内側） |
| 書き出す幅 | **1350px 以上**（Retina 用に2倍） |
| 推奨サイズ | **1400 × 350**（4:1） |
| 形式 | PNG または JPG。**WebP への変換はビルドが自動でやる** |

### 手順

**1.** 画像を `site/src/assets/banner.png` に置く。

> `public/` ではなく **`src/assets/`** に置くこと。
> `src/assets/` の画像だけがビルド時に WebP へ変換され、
> 複数サイズの `srcset` と `width`/`height` が自動で付く。

**2.** `site/src/pages/index.astro` を編集する。

```astro
---
import { Image } from 'astro:assets'
import { getCollection } from 'astro:content'
import BaseLayout from '../layouts/BaseLayout.astro'
import PostCard from '../components/PostCard.astro'
import { SITE } from '../config'
import banner from '../assets/banner.png'

const posts = (await getCollection('posts', ({ data }) => !data.draft)).sort(
  (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
)
---

<BaseLayout title={SITE.name} description={SITE.description}>
  <Image
    class="site-banner"
    src={banner}
    alt=""
    widths={[675, 1350]}
    sizes="(max-width: 47rem) calc(100vw - 2.3rem), 675px"
    loading="eager"
    fetchpriority="high"
  />

  <section class="hero">
    ...
```

**3.** 同じファイルの `<style>` に足す。

```css
.site-banner {
  display: block;
  width: 100%;
  height: auto;
  margin-top: 1.1rem;
  border-radius: var(--radius);
}
```

### 注意

- **`loading="eager"` と `fetchpriority="high"` を付ける。**
  バナーは画面の一番上に出るので、遅延読み込みにすると表示速度の評価が落ちる
- **`alt` は中身で決める。** 飾りなら `alt=""`、
  バナーにサイト名やキャッチコピーが**画像として**入っているなら、その文言を `alt` に書く
- **全ページに出したい**なら `index.astro` ではなく
  `site/src/layouts/BaseLayout.astro` の `<Header />` の直後に置く。
  ただし記事ページの読み込みも遅くなるので、トップだけを勧める

---

## 7. OG画像（SNS共有画像）を差し替える

X や Slack にURLを貼ったときに出る画像。いま入っているのは**仮のもの**。

**1.** 画像編集ソフトで **1200 × 630** で作る（この寸法は各SNS共通の推奨値）。

**2.** `site/public/og-default.png` に**同じファイル名で**上書きする。
ファイル名を変える場合は `site/src/config.ts` の `OG_IMAGE.path` も直す。

```ts
export const OG_IMAGE = {
  path: '/og-default.png',
  width: 1200,
  height: 630,
  alt: '観とこう｜配信終了前に、観とこう。',
} as const
```

**3.** `alt` も実際の画像の内容に合わせて直す。

### 注意

- **文字は中央寄りに置く。** SNSによって上下左右が切られる
- **文字は大きく。** タイムラインでは実寸の半分以下で表示される
- **反映は遅い。** 各SNSがキャッシュを持つため、差し替え後も古い画像が出続けることがある。
  X なら Card Validator、Facebook なら Sharing Debugger でキャッシュを更新できる

---

## 画像ファイルの置き場所

| 置き場所 | 最適化 | 使うもの |
|---|---|---|
| `site/src/assets/` | **される**（WebP変換・srcset自動） | 記事やページに `<Image>` で載せる画像 |
| `site/public/` | されない（そのまま配信） | favicon、OG画像、CSSの `url()` から参照する素材 |

**判断基準はひとつ。`<Image>` で読むなら `src/assets/`、
URLで直接指す必要があるなら `public/`。**

### 環境について（確認済み）

- 画像最適化（sharp）はインストール済み。Cloudflare のビルド環境（Linux）でも動く
- `.gitattributes` で画像はバイナリ指定済み。改行変換で壊れることはない
- `/_astro/` 配下（最適化後の画像）には `site/public/_headers` で永久キャッシュを設定済み

---

## 素材のライセンス（重要）

**このサイトは広告を載せる＝商用サイト。** 素材は必ず商用利用可のものを使う。

### 使ってはいけないもの

| | 理由 |
|---|---|
| 映画・ドラマのポスター、場面写真、キービジュアル | 著作権。配信ブログで最も起きやすい事故 |
| Netflix / Disney+ / Prime Video / Apple TV+ のロゴ | 商標＋各社ブランドガイドライン。サービス名は**テキストのまま**が安全 |
| Canva の無料素材を「ロゴ・商標として単独で」使う | Canva のライセンス上禁止（デザインの一部ならOK） |

### 使える無料素材

| サイト | 内容 | ライセンス |
|---|---|---|
| unDraw（undraw.co） | イラスト。色を `--accent` に合わせて書き出せる | 帰属不要・商用可 |
| Hero Patterns（heropatterns.com） | 背景パターンSVG | CC0 |
| Unsplash / Pexels | 写真 | 帰属不要・商用可 |
| O-DAN（o-dan.net） | 上記を日本語で横断検索 | 各サイトの規約に従う |
| Lucide / Tabler Icons | アイコン | ISC / MIT |
| Google Fonts | フォント | OFL |

> **日本語Webフォントは重い（数MB）。** ロゴに使いたい場合は、
> Google Fonts で組んだ文字を**アウトライン化して SVG に埋める**。
> Webフォントの読み込みがゼロになる。

---

## 確認方法

github.dev にはプレビュー機能が無い。**デザインを変えたときはローカルで確認すること。**

```powershell
cd C:\Users\grate\brog\site
npm run dev
```

→ http://localhost:4321/ 。ファイル保存で即座に反映。Ctrl+C で停止。

| 見るべき点 | どうやって |
|---|---|
| ダークモード | OSの設定を切り替える（またはブラウザの開発者ツールで強制） |
| スマホ幅 | 開発者ツールの端末エミュレーション。**47rem 以下でカードが解除される** |
| 横スクロールが出ていないか | 画面を狭めて左右に振ってみる |

ビルドが通るかどうかは次で確認できる。

```powershell
npm run build
```

> **ビルドが失敗しても公開中のサイトは壊れない。**
> Cloudflare は成功したビルドだけを公開する。
