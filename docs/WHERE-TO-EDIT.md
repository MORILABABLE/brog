# どこを直せばいいか（早見表）

**「画面のここを変えたい」から、開くファイルを引くための一覧。**
理由や手順まで知りたくなったら、各行の末尾にある詳しい文書へ。

- 見た目の作り込み（背景・ロゴ・OG画像・記事内の画像）… [APPEARANCE.md](./APPEARANCE.md)
- ブラウザで記事を直す手順 … [EDITING.md](./EDITING.md)
- なぜその作りにしたか … [../DESIGN.md](../DESIGN.md)

パスはすべてリポジトリの直下（`C:\Users\grate\brog`）からの位置。


--------------------------------------------------------------------------
## まず覚える2つ

    site/src/styles/global.css   色・寸法・余白・文字の大きさ。**見た目の8割はここ**
    site/src/config.ts           サイト名・URL・説明文・カテゴリ名・ジャンル名・帰属表示の文言

`global.css` は**先頭の `:root` にツマミがまとまっている。**
その下は場所ごとのスタイル。ダークモードの色は同じファイルの
`@media (prefers-color-scheme: dark)` にもう一組あるので、**色は必ず両方直す。**


--------------------------------------------------------------------------
## 画面の場所から引く

上から下、外から内の順。

    ヘッダー（サイト名・メニュー・記事検索窓）
      → site/src/components/Header.astro
      メニューの項目   → site/src/config.ts の CATEGORY_HUBS
                         ★ CATEGORIES ではない。カテゴリは4つ、メニューは3つ
      メニューを押すと開くサービス名
                       → site/src/config.ts の SERVICE_HUBS（4サービス）
                         ★ 記事が出ないサービスは並べない（Hulu・Apple TV+）
                         ★ 開くかどうかは CATEGORY_HUBS の serviceMenu
                           行き先は /category/<ハブ>/<サービス>
      記事検索窓       → site/src/components/PostSearch.astro
                         ★ 常設ページの「作品検索」(WorkSearch.astro) とは別物
      並び             → サイト名だけ左、メニューと検索窓は右
                         （Header.astro の .inner / .brand）

    左の枠 ＝ 常設枠（「新着配信・終了一覧」）
      見た目・並び        → site/src/components/LeftRail.astro
      何を並べるか        → site/src/lib/evergreen.ts の EVERGREEN_PAGES
      カードの見出し・日付 → site/src/lib/evergreen.ts の evergreenTitle / evergreenStamp

    本文カード（白い箱）
      幅・角丸・余白 → site/src/styles/global.css の .content-card と --max-width

    右の追従枠（ジャンルから探す＋最新記事＋PR枠）
      → site/src/components/FollowRail.astro
      ジャンル枠（最新記事の上）→ site/src/components/GenreRail.astro
                       ★ **いまは何も描画されない。** config.ts の
                         GENRE_NAV_ENABLED が false のあいだ HTMLを1バイトも出さない
                         （ジャンル軸の記事が各ジャンル1本ずつしか無いため）。
                         true にすると、この枠と /genre/<スラッグ> が**一緒に**出る
      ★ 「サービスから探す」は 2026-08-27 に廃止。
        同じ導線はヘッダーのメニューにある（枠は1200px未満で消えるため）

    フッター（運営者情報・出典・著作権）
      → site/src/components/Footer.astro

    3カラムの配置そのもの
      → site/src/styles/global.css の .layout
         1200px(75rem)以上で3カラム、752px(47rem)以下でスマホ表示に切り替わる

> 左右の枠は**狭い画面では消える**。スマホで確認するときは出ない。


--------------------------------------------------------------------------
## ページの種類から引く

    記事ページ           → site/src/pages/posts/[...slug].astro
    常設ページ（終了予定） → site/src/pages/leaving/[service].astro
    常設ページ（新着）     → site/src/pages/arrivals/[service].astro
    サービス別まとめ       → site/src/pages/service/[service].astro
                            記事は frontmatter の tags で拾う。
                            ★ タグの文字列は config.ts の SERVICE_HUBS と完全一致が要る
    カテゴリ一覧          → site/src/pages/category/[category].astro
                            ★ 生成されるのは CATEGORY_HUBS の3枚だけ。
                              /category/ended は public/_redirects で
                              /category/leaving へ転送している
                            ★ 常設ページのカードはここには出さない（2026-08-27）
    ジャンル一覧          → site/src/pages/genre/[genre].astro
                            記事は frontmatter の **genre** で拾う（tags ではない）。
                            拾い方は site/src/lib/genre-pages.ts
                            ★ GENRE_NAV_ENABLED が false のあいだ**1枚も生成されない**。
                              リンク元（GenreRail.astro）も同じフラグで消えるので404にならない
    カテゴリ×サービス      → site/src/pages/category/[category]/[service].astro
                            ヘッダーのメニューを開いて選んだ先。
                            serviceMenu のハブ × SERVICE_HUBS ぶん自動で増える。
                            記事も常設ページも0件なら noindex
                            （判定は site/src/lib/service-pages.ts）
                            ※ いまは全ページに中身がある
    トップページ          → site/src/pages/index.astro
    運営者情報・規約など   → site/src/pages/about.astro / privacy.astro / contact.astro
    見放題の増減（統計）   → site/src/pages/stats.astro

    全ページ共通の外枠（head・OGP・構造化データ）
      → site/src/layouts/BaseLayout.astro


--------------------------------------------------------------------------
## 表の中の作品リンク

記事の表も常設ページの表も、作品名がリンクとサムネイルになっている。
**同じ形のHTMLを2か所が別々に出しているので、片方だけ直すと段差が出る。**

    どこへ飛ばすか      → site/src/lib/work-links.ts の resolveUrl()
                          （作品ページの直リンクと検索の使い分け。**方針はここだけ**）
    記事の表に貼る処理  → site/plugins/rehype-work-links.ts
                          ビルド時にセルの中身が作品名と完全一致したら <a> で包む
                          ★ astro.config.mjs で rehype-affiliate より**前**に置くこと
    常設ページの表      → site/src/components/WorkTable.astro
    見た目（共通）      → site/src/styles/global.css の .work-link / .work-thumb
    サムネイルの用意    → site/scripts/make-thumbs.mjs
    画像が無いとき      → site/scripts/genre-art.mjs（ジャンル別の汎用画像）

> **記事にURLは書かれていない。** 記事側は素の作品名だけを書き、
> リンクはビルド時に貼る。送り先やトラッキングIDを変えても
> **記事を作り直さなくてよい**のはこのため。


--------------------------------------------------------------------------
## カード（一覧に並ぶ横長のやつ）

    記事のカード       → site/src/components/PostCard.astro
    常設ページのカード → site/src/components/EvergreenCard.astro
    左の正方形サムネ   → site/src/components/Thumb.astro
    見出しの上の画像   → site/src/components/LeadImage.astro
                         ★ いま使っているのは常設ページだけ。
                           個別記事の冒頭は 2026-08-25 に非表示にした
                           （戻し方は posts/[...slug].astro のコメント）

> **記事のカードと常設ページのカードは同じ体裁にしてある。**
> 片方だけ直すと一覧の中で段差が出る。どちらのファイルにも同じ注意書きがある。


--------------------------------------------------------------------------
## 個別ページの末尾（共通で出るもの）

記事ページの本文より下は、`site/src/pages/posts/[...slug].astro` に上から順に並んでいる。

    1. Amazonへの導線   → site/src/components/AmazonCta.astro
                          文面はカテゴリで変わる（終了記事に「見放題で探す」と出さない）
    2. 広告枠           → site/src/components/AdSlot.astro
                          PUBLIC_ADSENSE_CLIENT 未設定なら何も描かれない
    3. 出典             → 中身は記事の frontmatter `sources`
                          並べ方は [...slug].astro の <section class="sources">
    4. タグ             → 記事の frontmatter `tags`
                          ★ ジャンル（アニメ／洋画／邦画）は**タグではなくバッジ**で出す。
                            見出し下の日付の左、カテゴリバッジの隣。
                            出どころは frontmatter の `genre`、見た目は
                            global.css の `.badge.genre`
    5. フッター         → site/src/components/Footer.astro（全ページ共通）

**記事本文の中**の定型文（「他のサービスで探す」の前置きなど）は記事側ではなくテンプレート。

    → theme-packs/streaming-jp/templates/fixed-phrases.md

常設ページの末尾（出典・関連リンク・注記）は共通部品ではなく、
`leaving/[service].astro` と `arrivals/[service].astro` の中に直接書いてある。
**片方だけ直すと文言がずれる。**


--------------------------------------------------------------------------
## 文字の大きさ

    サイト全体の基準 → global.css の body { font-size: 16px }
                      ほかはすべて rem 指定なので、ここを変えると全部が動く
    見出し           → global.css の h1 / h2 / h3
    本文の段落       → global.css の .prose p
    表              → global.css の .prose table / th / td
    カードの中       → 各コンポーネントの <style>（PostCard / EvergreenCard / LeftRail）

目安として、この配色・寸法で使っている大きさ。

    0.68rem  バッジ、常設枠の更新日
    0.86rem  常設枠のサービス名、出典
    1.15rem  カードの見出し


--------------------------------------------------------------------------
## フォント

    画面に出る文字 → global.css の font-family
                     端末に入っているフォントを使う。**Webフォントは読み込んでいない**
                     （日本語Webフォントは数MBあり、表示速度に直撃するため）

    画像に焼く文字 → site/scripts/fonts/（Zen Kaku Gothic New・SIL OFL 1.1）
                     カード画像・セクション画像の中の文字はこれ。
                     **差し替えるときは OFL.txt も一緒に入れ替えること**

> 画像の中の文字は**すべてパスに変換**している。そうしないと日本語フォントの無い
> Cloudflare のビルド環境で豆腐（□□□）になる。詳細は APPEARANCE.md の9節。


--------------------------------------------------------------------------
## 画像の置き換え

### 人が差し替えるもの

    ファビコン・ロゴ
      → site/public/favicon.svg を上書き
      → そのあと `cd site && node scripts/make-icons.mjs`（PNG版を作り直す）

    SNS共有画像（サイト共通のOG画像）
      → 元画像 site/src/assets/header-banner.png を差し替え
      → そのあと `cd site && node scripts/make-og.mjs`
      → 出力 site/public/og-default.jpg

    常設枠のサービス画像（いまは N / A / D の頭文字タイル）
      → site/src/assets/services/netflix.png など、キーと同じ名前で置くだけ
      → 置かなければ頭文字タイルのまま。壊れない

    記事一覧のカードの左サムネイルを手で決めたいとき
      → その記事の frontmatter `heroImage` に好きなパスを書く
      → 画像は site/public/ に置く（例: heroImage: '/my-hero.jpg'）
      → **手で書いた値は自動処理が上書きしない**
      ★ 記事ページの冒頭には出ない（2026-08-25 に非表示）。出るのは一覧カードだけ

### 自動で作られるもの（触らなくてよい）

    記事ごとのカード画像（OG） → site/scripts/make-cards.mjs   → public/cards/
    本文中のセクション画像     → site/scripts/make-sections.mjs → public/sections/
    作品ポスター               → site/scripts/posters.mjs       → public/sections/posters/
    記事のヘッダー画像         → site/scripts/make-sections.mjs → public/heroes/
                                 （使い道は一覧カードの左サムネイルのみ）
    表の作品サムネイル         → site/scripts/make-thumbs.mjs   → public/thumbs/
    ジャンル別の汎用画像       → site/scripts/genre-art.mjs     → public/thumbs/genre-*.webp

いずれも `npm run build` の前に自動で走る。git には入れない（毎回作り直すため）。
絵柄そのものを変えたいときは、出力先ではなく**生成スクリプトの方**を直す。

### 置き場所の使い分け

    site/src/assets/  … ビルドで最適化される（WebP変換・複数サイズ）
                        ページに <Image> で載せる画像はこちら
    site/public/      … 最適化されない。そのまま配信される
                        favicon、OG画像、frontmatter から URL で指す画像はこちら


--------------------------------------------------------------------------
## 画像の寸法

    記事カード（OG）  → site/scripts/make-cards.mjs 先頭の W / H
                        ★ site/src/config.ts の CARD_IMAGE も同時に直すこと
    セクション画像    → site/scripts/make-sections.mjs 先頭の W / H
    ショートのカット  → site/scripts/make-shorts.mjs 先頭の W / H / SAFE
                        ★ SAFE は YouTube の再生UIが重なる余白。--guides で目視できる
    ポスターの表示    → global.css の img[src^='/sections/posters/'] の max-height
    表のサムネイル    → global.css の .work-thumb
                        ★ 3か所と揃える（rehype-work-links.ts / WorkTable.astro の
                          THUMB、make-thumbs.mjs の THUMB は表示の2倍）
    常設ページの先頭  → site/src/components/LeadImage.astro の max-height
                        （個別記事の冒頭画像は非表示。APPEARANCE.md 12節）
    サイト共通のOG    → site/src/config.ts の OG_IMAGE（make-og.mjs の出力と揃える）


--------------------------------------------------------------------------
## 色

すべて `site/src/styles/global.css` の `:root`。

    --bg / --text / --text-muted   基本の地色と文字色
    --accent / --accent-soft       リンクとボタンの青
    --border                       罫線
    --bg-tint / --dot-color / --dot-gap   背景の紺と点々
    --footer-bg / --footer-text    フッター（地の上に直接載るので専用色）
    --cat-*-bg / --cat-*-fg        カテゴリバッジ4色

**ダークモードの同じ変数が下の @media にある。必ず両方直す。**
カテゴリを増やしたときは `.badge[data-category='…']` の行も足す。


--------------------------------------------------------------------------
## 文言（コードの中にある文字）

    サイト名・キャッチコピー・説明文 → site/src/config.ts の SITE
    カテゴリの表示名（バッジ）        → site/src/config.ts の CATEGORIES
    メニューと一覧ページの構成        → site/src/config.ts の CATEGORY_HUBS
    メニューに出すサービス名          → site/src/config.ts の SERVICE_HUBS
    出典の表記                       → site/src/config.ts の ATTRIBUTION
    常設ページのタイトルの形          → site/src/lib/evergreen.ts
    記事の定型文                     → theme-packs/streaming-jp/templates/fixed-phrases.md
    記事の構成そのもの                → theme-packs/streaming-jp/templates/*.md
    記事タイトルの形・軸の決まり      → theme-packs/streaming-jp/templates/naming.md
    特報の構成・文体                  → theme-packs/streaming-jp/templates/special.md
    ショート台本の構成・尺・禁止事項  → theme-packs/streaming-jp/templates/short-script.md
    ショートの締め・概要欄の型        → 同 fixed-phrases.md の short- で始まるキー
    出来上がった台本（手で直す）      → shorts/*.md（→ shorts/README.md）


--------------------------------------------------------------------------
## 直したあと

```powershell
cd C:\Users\grate\brog\site
npm run dev     # http://localhost:4321/ 保存すると即反映。Ctrl+C で停止
npm run build   # 本番と同じ手順で通るか確認
```

確認するとき見る点。

    ダークモード          OSの設定を切り替える
    スマホ幅              開発者ツールの端末エミュレーション（47rem以下で1カラム）
    左右の枠              1200px以上でないと出ない
    横スクロールが出ないか 画面を狭めて左右に振る


--------------------------------------------------------------------------
## 触ると広く壊れるもの

    site/src/layouts/BaseLayout.astro   全ページの外枠。head・OGP・構造化データ
    site/src/config.ts                  ほぼ全ページが読む
    site/src/lib/events-data.ts         常設ページのデータ読み込み。壊れるとビルドが止まる
    site/src/content.config.ts          記事の形の検査。ここを緩めると壊れた記事が公開される

**ビルドが失敗しても、公開中のサイトは壊れない。**
Cloudflare は前回成功したものを出し続ける。落ち着いて直せばよい。
