# src/assets — 最適化される画像の置き場所

ここに置いた画像を `astro:assets` の `<Image>` で読み込むと、
**ビルド時に WebP へ変換され、複数サイズの `srcset` と `width`/`height` が自動で付く。**

```astro
---
import { Image } from 'astro:assets'
import banner from '../assets/header-banner.png'
---
<Image src={banner} alt="" widths={[736, 1200]} sizes="(max-width: 47rem) 100vw, 736px" />
```

> `widths` に**元画像の幅を超える数値は書けない**（ビルドが落ちる）。

いま入っている `header-banner.png` は**画面には出していない**（2026-08-24 に非表示）。
ただし **OG画像（SNS共有画像）の元**なので消さないこと
（`site/scripts/make-og.mjs` が読む）。経緯と差し替え手順は
[docs/APPEARANCE.md の6節](../../../docs/APPEARANCE.md#6-ヘッダーバナーいまは表示していない)。

`public/` に置いた画像は**最適化されない**（そのまま配信される）。使い分けは次のとおり。

| 置き場所 | 最適化 | 使うもの |
|---|---|---|
| `src/assets/` | される | 記事・ページに `<Image>` で載せる写真やバナー |
| `public/` | されない | favicon、OGP画像、CSSの `url()` から参照する背景素材 |

詳しい手順とファイル形式の指針は [docs/APPEARANCE.md](../../../docs/APPEARANCE.md)。
