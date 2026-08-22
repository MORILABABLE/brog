# 見た目を変える（背景・ロゴ・バナー・OG画像）

最終更新: 2026-08-22

> 記事の文面や色を直したいだけなら [EDITING.md](./EDITING.md)。
> こちらは**背景グラフィック・ロゴ・ヘッダーバナー・SNS共有画像**の手順書。

---

## いま何がどうなっているか

**濃いブルーの地に点を敷き、その上にバナーと本文を浮かせている。**
地の色はヘッダーバナー（暗い映画館の写真）と地続きに見えるよう合わせてある。

```
┌──────────────────────────────┐
│ ヘッダー（白・--bg）                 │
├──────────────────────────────┤
│ ・ ┌────────────────────┐ ・ │
│ ・ │ ヘッダーバナー（全ページに出る）  │ ・ │  ← src/assets/header-banner.png
│ ・ └────────────────────┘ ・ │
│ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ │  ← 背景グラフィック（body）
│ ・ ┌────────────────────┐ ・ │
│ ・ │ 本文カード（.content-card） │ ・ │  ← 白く浮いている
│ ・ │ 記事・カード一覧はこの中       │ ・ │
│ ・ └────────────────────┘ ・ │
│ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ ・ │
├──────────────────────────────┤
│ フッター（紺・--footer-bg）           │
└──────────────────────────────┘
```

**背景（点と地色）は画像ファイルではなく CSS で描いている。** 理由は3つ。

1. サイトはライト/ダーク両対応。画像だと明暗2枚とメディアクエリが必要になる
2. 背景は全ページに乗る。画像だと表示速度（LCP）に直撃し、広告収入にも響く
3. CSS なら数百バイトで済み、`--accent` などの既存の色変数と揃えられる

> **ライトモードでも地は暗い。** 文字は必ず白いカードの中に置くこと。
> カードの外に直接テキストを置くと、`--text`（ほぼ黒）のままで読めなくなる。
> フッターだけは地の上に載るので、専用の明るい色（`--footer-text`）を持たせてある。

| 変えたいもの | ファイル | 節 |
|---|---|---|
| 背景の濃さ・色・柄 | `site/src/styles/global.css` | [1](#1-背景の色と濃さを変える) [2](#2-背景の柄を変える) [3](#3-背景をやめる) |
| 本文カードの見た目 | `site/src/styles/global.css` | [4](#4-本文カードを調整するやめる) |
| ロゴ・ファビコン | `site/public/favicon.svg` | [5](#5-ロゴファビコンを差し替える) |
| ヘッダーバナー | `site/src/assets/header-banner.png` | [6](#6-ヘッダーバナーを差し替える) |
| SNS共有画像 | `site/public/og-default.jpg` | [7](#7-og画像sns共有画像を差し替える) |
| カテゴリバッジの色 | `site/src/styles/global.css` | [8](#8-カテゴリバッジの色を変える) |

---

## 1. 背景の色と濃さを変える

`site/src/styles/global.css` の先頭にツマミがある。

```css
:root {
  --bg-tint: #1b3a6e;                      /* 地の色 */
  --dot-color: rgba(174, 208, 255, 0.13);  /* 点の色 */
  --dot-gap: 22px;                         /* 点の間隔 */

  --footer-bg: #16305c;                    /* フッターの地。--bg-tint より少し沈める */
  --footer-text: #bccbe4;                  /* フッターの文字 */
  --footer-link: #9dc4ff;                  /* フッターのリンク */
  --footer-border: rgba(255, 255, 255, 0.12);
}
```

**ライトとダークの2箇所にある。必ず両方直すこと。**
片方だけ変えると、もう一方の配色で背景が浮いたり沈んだりする。

| やりたいこと | 直す値 |
|---|---|
| 地をもっと濃くしたい | `--bg-tint` を `#142c55` などに下げる。`--footer-bg` も一段暗い値に合わせる |
| 地を明るくしたい | `--bg-tint` を `#28518f` などに上げる |
| 青みを落として黒に寄せたい | `--bg-tint` を `#1a2430` などに寄せる |
| 淡いブルーに戻したい | `--bg-tint: #eef4fd` ＋ `--dot-color: rgba(31,111,235,0.22)`。**その場合はフッターの色も明るく戻すこと**（[下記](#フッターだけ元の明るい色に戻す)） |
| 点を目立たせたい | `--dot-color` の末尾 `0.13` を `0.20` などに上げる |
| 点をまばらにしたい | `--dot-gap` を `28px` `32px` と広げる |

ダーク側の既定値はこちら。

```css
--bg-tint: #0b1d3a;
--dot-color: rgba(110, 168, 254, 0.14);
--footer-bg: #091728;
```

> **地が暗いので、点は「明るい色」で置いている。** 暗い地に暗い点を置くと何も見えない。
> 地を淡い色に戻すときは、点も暗い色に戻す必要がある。

### フッターだけ元の明るい色に戻す

`site/src/components/Footer.astro` の `footer { }` を戻す。

```css
footer {
  border-top: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--text-muted);
}
```

同じファイルの `footer a { color: var(--footer-link); }` を消し、
`nav a { color: var(--footer-text); }` を `var(--text-muted)` に戻す。

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

**狭い画面（47rem 以下）ではカードとバナーを全幅に戻している。**
スマホで本文の横幅を削るほうが、背景が見えることより損だという判断。
そのぶん**スマホでは背景の紺がほとんど見えない**（フッター手前の余白だけ）。
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

## 6. ヘッダーバナーを差し替える

いま入っているのは `site/src/assets/header-banner.png`（1200 × 463・2.59:1）。
`site/src/layouts/BaseLayout.astro` から**全ページ**に出している。

### 差し替え手順

**1.** 新しい画像を `site/src/assets/header-banner.png` に**同じファイル名で**上書きする。

> **ファイル名は1文字も違ってはいけない。**
> とくに `header-banner .png` のような**拡張子の前のスペース**は見た目で気づけず、
> `Could not resolve '../assets/header-banner.png'` でビルドが落ちる。
> 名前を変えたい場合は `BaseLayout.astro` の `import` 行も一緒に直すこと。

> **`public/` ではなく `src/assets/` に置くこと。**
> `src/assets/` の画像だけがビルド時に WebP へ変換され、
> 複数サイズの `srcset` と `width`/`height` が自動で付く。
> 実際に効いている（605KB の PNG → 配信時 15〜27KB の WebP）。

**2.** 縦横比を変えた場合は `site/src/layouts/BaseLayout.astro` の `widths` を直す。

```astro
<Image
  class="site-banner"
  src={banner}
  alt={OG_IMAGE.alt}
  widths={[736, 1200]}          {/* 元画像の幅を超える数値は指定できない */}
  sizes="(max-width: 47rem) 100vw, 736px"
  loading="eager"
  fetchpriority="high"
/>
```

**3.** 画像内の文言を変えたなら `site/src/config.ts` の `OG_IMAGE.alt` も直す
（バナーの `alt` はここを共有している）。

### 書き出しの寸法

| | 値 |
|---|---|
| 表示される幅 | 最大 **736px**（本文カードと同じ幅） |
| 書き出す幅 | **1200px 以上**（`widths` に元画像の幅を超える数値は書けない） |
| 形式 | PNG または JPG。**WebP への変換はビルドが自動でやる** |
| 縦横比 | 現在は 2.59:1 → デスクトップで **736 × 284** |

### 高さの話

バナーは**全ページの一番上**に載るので、高いほど本文が下に押し下げられる。

| 縦横比 | デスクトップでの高さ |
|---|---|
| 1.91:1（OGPと同じ比率） | 385px ← 記事ページでは重い |
| **2.59:1（現在）** | **284px** |
| 3:1 | 245px |
| 4:1 | 184px |

**絵を差し替えずに高さだけ詰めたい**場合は、
`site/src/styles/global.css` の `.site-banner` にこう足す。

```css
.site-banner {
  aspect-ratio: 3 / 1;           /* 736 × 245 になる */
  object-fit: cover;             /* はみ出した上下を切る */
  object-position: center;       /* 切る位置 */
}
```

> **トリミングすると絵の上下が切れる。**
> 現在の絵はほぼ全面を使っているので、切ると丸ロゴかキャッチコピーが欠ける。
> `object-position` を `center 30%` のように動かして残す位置を調整するか、
> **その比率で描き直すほうが結果はよい。**
> 確認は `npm run dev` で実際に見るのが早い。

### 注意

- **`loading="eager"` と `fetchpriority="high"` は外さないこと。**
  バナーは画面の一番上に出るので、遅延読み込みにすると表示速度の評価が落ちる
- **`alt` は画像の中身を書く。** バナーにキャッチコピーが**画像として**
  入っているなら、その文言をそのまま `alt` に書く（読み上げと検索の両方に効く）
- **トップページだけに出したい**なら、`BaseLayout.astro` の `<Image>` を
  `site/src/pages/index.astro` の `<BaseLayout>` の中へ移す

---

## 7. OG画像（SNS共有画像）を差し替える

X や Slack にURLを貼ったときに出る画像。
いまは**ヘッダーバナーから機械的に作っている**（`site/public/og-default.jpg`・61KB）。

> バナーは 2.59:1 だが、OGPの推奨は **1.91:1**。
> そのまま出すと SNS 側で左右を切られてキャッチコピーが欠けるので、
> 上下に「バナー自身を拡大してぼかしたもの」を継ぎ足して 1200 × 628 にしている。
> 単色で埋めると継ぎ目が帯として見えるため。

### バナーを差し替えたら作り直す

```powershell
cd C:\Users\grate\brog\site
node scripts/make-og.mjs
```

バナーの幅が 1200px でない場合や、バナーが 628px より高い場合は
スクリプトが理由を出して止まる。その場合は手で作る。

### 別の絵を使いたい場合

**1.** 画像編集ソフトで **1200 × 630** で作る。

**2.** `site/public/og-default.jpg` に**同じファイル名で**上書きする
（以降 `make-og.mjs` を流すと上書きされるので、使うのをやめること）。
ファイル名や寸法を変える場合は `site/src/config.ts` も直す。

```ts
export const OG_IMAGE = {
  path: '/og-default.jpg',
  width: 1200,
  height: 628,
  alt: '観とこう｜主要動画サービスの見放題配信タイトルは観れるうちに',
} as const
```

**3.** `alt` も実際の画像の内容に合わせて直す。
**この `alt` はヘッダーバナーと共有している**ので、両方に合う文言にすること。

> **写真は JPEG にする。** PNG のままだと1MB近くになる。
> `public/` の画像はビルドで最適化されないので、ここだけは手で軽くする必要がある。
> バナー元画像（`src/assets/`）は PNG のままでよい（ビルドが WebP にする）。

### 注意

- **文字は中央寄りに置く。** SNSによって上下左右が切られる
- **文字は大きく。** タイムラインでは実寸の半分以下で表示される
- **反映は遅い。** 各SNSがキャッシュを持つため、差し替え後も古い画像が出続けることがある。
  X なら Card Validator、Facebook なら Sharing Debugger でキャッシュを更新できる

---

## 8. カテゴリバッジの色を変える

記事一覧と記事冒頭に出る「配信終了予定」「新着配信」などのタグ。
**読者が文字を読む前に、観られるのか観られないのかを判別できるようにするための色分け**です。

| バッジ | 色 | 意味 |
|---|---|---|
| 配信終了予定 | アンバー | まだ観られる。急ぐ意味がある |
| 配信終了済み | グレー | もう観られない。急かす対象ではない |
| 新着配信 | ブルー | 新しく入った |
| ランキング | パープル | — |

色は `site/src/styles/global.css` の `:root` にまとまっています。

```css
--cat-leaving-bg: #fbeedb;   /* 背景 */
--cat-leaving-fg: #8a4d08;   /* 文字 */
--cat-ended-bg: #e9ecf0;
--cat-ended-fg: #55606d;
--cat-arrivals-bg: #e8f0fe;
--cat-arrivals-fg: #1a5fd0;
--cat-ranking-bg: #efe8fc;
--cat-ranking-fg: #6535bb;
```

**ライトとダークの2箇所にあります。必ず両方直してください。**
ダーク側は地が暗いので、文字を明るく・背景を沈める方向で組んであります。

### 変えるときに守ること

- **文字と背景のコントラスト比を 4.5:1 以上に保つ。**
  現在の8組はすべて 5:1 以上を実測で確認済みです。淡い色同士にすると読めなくなります
- **色だけに意味を持たせない。** バッジには必ずラベル文字を併記します。
  色覚特性のある読者や、印刷・モノクロ表示では色が届きません

### カテゴリを増やしたとき

`:root` に1組（`--cat-<スラッグ>-bg` / `-fg`）を足し、同じファイルの下のほうにある
バッジの定義にも1ブロック足します。

```css
.badge[data-category='新しいスラッグ'] {
  background: var(--cat-新しいスラッグ-bg);
  color: var(--cat-新しいスラッグ-fg);
}
```

**足し忘れても壊れません。** 指定の無いカテゴリは既定のアクセント色で表示されます。

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
| ライセンスを確認していない写真素材 | **現在のヘッダーバナーの映画館写真も、出所と商用可否を確認しておくこと** |
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

---

## 困ったとき

### 画像を差し替えたのに古いまま表示される

**`npm run dev` でだけ起きる。** 開発サーバーの画像URL（`/_image?href=...`）は
ファイルを差し替えても変わらないので、ブラウザが古い画像を持ち続ける。

1. ブラウザで**ハードリロード**（Windows: `Ctrl` + `Shift` + `R`）
2. それでも直らなければ dev を止めてキャッシュを消し、開き直す

```powershell
cd C:\Users\grate\brog\site
# dev サーバーを Ctrl+C で止めてから実行する
Remove-Item -Recurse -Force node_modules\.vite, .astro -ErrorAction SilentlyContinue
npm run dev
```

> **本番では起きない。** ビルド後のファイル名には内容のハッシュが入る
> （`header-banner.BuN91i8f_276sbD.webp`）ので、中身が変われば URL も変わる。
> ただし `public/` に置いたもの（`og-default.jpg`・favicon）はファイル名が
> 固定なので、本番でもブラウザやSNSのキャッシュが残ることがある。

### `Could not resolve '../assets/header-banner.png'` でビルドが落ちる

`site/src/assets/` のファイル名が `header-banner.png` と**完全一致していない。**
よくあるのは**拡張子の前の半角スペース**（`header-banner .png`）で、
見た目では気づけない。ファイル一覧で名前を確認して直す。

### `widths` に元画像より大きい数値を指定してビルドが落ちる

`BaseLayout.astro` の `widths={[736, 1200]}` は**元画像の幅を超えられない。**
バナーを 1200px 未満で書き出したなら、この数値を下げる。
