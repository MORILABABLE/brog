# アフィリエイト

最終更新: 2026-08-23

収益化の実装と、提携状況の調査結果。

**いま何が動いていて、何を人手でやる必要があるか**をここに集約する。
設計思想は [DESIGN.md 7節](../DESIGN.md#7-収益化)、日々の作業は [HANDOVER.md](./HANDOVER.md)。

---

## 1. いまの状態

**Phase A（実装）は完了し、Amazon は稼働中**（2026-08-23 に `PUBLIC_AMAZON_TAG` 設定済み）。
残るのは ASP の提携（Phase B）。

| | 状態 |
|---|---|
| リンクの体裁（`rel="sponsored"` / `target`） | ✅ ビルド時に自動付与 |
| Amazon のトラッキングID付与 | ✅ ビルド時に自動付与（IDは記事に焼き込まない） |
| LinkSwitch（U-NEXT / Hulu の自動変換） | ✅ 実装済み・**PID未設定なので未稼働** |
| 広告（PR）表記 | ✅ **表示中** |
| Amazon規約の固定文 | ✅ **表示中** |
| プライバシーポリシー | ✅ 追記済み |
| Amazon への導線（記事末尾・トップ） | ✅ **表示中** |
| 右の追従枠（1280px以上） | ✅ **表示中**（6節 Phase D） |
| 常設ページの作品別リンク | ✅ `/leaving/<サービス>` に実装済み（6節 Phase C） |
| ASPへの登録・提携申請 | ❌ 未着手（Phase B） |

> **未設定なら「PR」表記も含めて一切描画されない。**
> 実際には広告リンクが1本も無いのに「PR」と出すのは、景品表示法上むしろ不正確なため。
> 判定は `site/src/config.ts` の `AFFILIATE_ENABLED` 1か所に寄せてある。

---

## 2. 有効化の手順（人手）

`site/.env` に書くだけ。コードは触らない。

```bash
# Amazonアソシエイト
PUBLIC_AMAZON_TAG=xxxxx-22

# バリューコマース LinkSwitch（Phase B の提携承認後）
PUBLIC_VC_LINKSWITCH_PID=000000000
```

Cloudflare Pages に載せる場合は、**Pages プロジェクトの環境変数**にも同じものを設定する
（`.env` はリポジトリに入らないため）。
`Settings → Environment variables` で Production / Preview の両方に入れる。

### Amazon のトラッキングIDの調べ方

アソシエイト・セントラル → 右上のアカウント名 → **トラッキングIDの管理**。
`xxxxx-22` の形。複数作れるので、このサイト専用のIDを1つ作ると成果を分離して見られる。

### LinkSwitch を入れる前に必ずやること

VC管理画面の**ブロック設定**で、以下を自動変換の対象外にする。

| 除外するもの | 理由 |
|---|---|
| **Amazon** | アソシエイトのタグと**二重計上**になる。規約違反になりうる |
| **DMM** | AdSense審査のリスク回避のため、当面アフィリエイト対象外（下記 5-3） |

> コード側にも `src/lib/affiliate.ts` の `EXCLUDED_HOSTS` があるが、
> **LinkSwitch の変換はVC側で走るので、管理画面の設定が本体**。
> コード側の除外は `rel` の付け方を変えるだけで、変換自体は止められない。

---

## 3. 提携できるもの・できないもの（2026-08-23 調査）

**対象4社のうち3社は現在提携できない。** これが収益設計の前提。

| サービス | 可否 | ASP | 単価 |
|---|---|---|---|
| **Amazon Prime Video** | ✅ | Amazonアソシエイト（直） | ビデオ購入/レンタルの紹介料 ＋ Prime無料体験 500円/件 |
| Netflix | ❌ **公式プログラムが存在しない** | — | — |
| Disney+ | 🔶 クローズド案件（実績者のみ招待） | アクセストレード / afb / Link-A | 1,299〜1,720円 |
| Apple TV+ | 🔶 招待制（Partnerize経由） | Apple Services Performance Partner | 映画・TV 7% |
| **U-NEXT** | ✅ 審査ゆるめ | afb・バリューコマース 1,320円 / アクセストレード 1,200円 | **最有力** |
| **DMM TV** | ✅ | afb 1,691円 / もしも 1,539円 | 高単価だが当面見送り（5-3） |
| **Hulu** | ✅ 審査は厳格化傾向 | afb 917円 / JANet 850円 | |
| ABEMAプレミアム | ✅ | afb 591円 ほか | |
| dアニメストア | ✅ | 各社 235〜299円 | 低単価。労力に見合わない |

TELASA・Lemino・FOD・TVer・楽天TV もプログラムなし。

> **収益の主戦場は「対象4社」ではなく「対象外3社」。**
> データを持っている4社のうち金になるのは Amazon だけで、
> 「探す先」として出している U-NEXT / Hulu は単価が桁違いに高い。
> API に無いから諦めた3社が、収益では主力になるという逆転が起きている。

---

## 4. 実装の地図

| ファイル | 役割 |
|---|---|
| `site/src/lib/affiliate.ts` | **方針の単一の置き場**。対象ホスト・除外ホスト・URL組み立て・`rel` の決定 |
| `site/plugins/rehype-affiliate.ts` | ビルド時に本文のリンクを書き換える（tag付与・`rel`・`target`） |
| `site/astro.config.mjs` | 上のプラグインを配線。`loadEnv` でIDを読む |
| `site/src/config.ts` | `AFFILIATE` / `AFFILIATE_ENABLED` |
| `site/src/components/LinkSwitch.astro` | VCのJSタグ。`<head>` に入る |
| `site/src/components/AffiliateNotice.astro` | 「PR」表記 |
| `site/src/components/AmazonCta.astro` | Amazon への導線。文面が記事カテゴリで変わる |
| `site/src/components/FollowRail.astro` | 本文右の余白に置く追従枠。中身は1広告主だけ |
| `site/src/lib/search-links.ts` | 各サービスの検索URL。**theme.yaml と同内容**。片方だけ直さない |
| `site/src/pages/leaving/[service].astro` | 常設ページ。rehype を通らないので tag と rel をページ側で付ける |
| `site/src/styles/global.css` の `.layout` | 追従枠の配置と出し分け（1280px未満では従来と同一） |
| `site/src/components/Footer.astro` | Amazon規約の固定文 |
| `site/src/pages/privacy.astro` | アフィリエイトの開示 |

### 収益経路が2つあり、性質がまったく違う

```
Amazon   URL に tag= を付けるだけ。JS不要。
         クリックから24時間、その訪問者の「あらゆる購入」が成果になる。
         → 見放題作品を観るだけでは1円にもならない。クッキーが本体。

その他   バリューコマース LinkSwitch（JS）が、ブラウザ側で
         通常リンクをアフィリエイトリンクに変換する。
         → 記事本文を1文字も書き換えずに成果計測できる。
           自動生成した記事にそのまま効くのが採用理由。
```

---

## 5. 落とし穴（同じ穴に落ちないために）

### 5-1. `rel="noreferrer"` を付けてはいけない

ASP と Amazon は**リファラで成果を判定する**。
`noreferrer` を付けると成果が計上されない。`noopener` だけならリファラは送られる。
`src/lib/affiliate.ts` の `relFor()` がこれを分けている。外部リンク一律で
`noopener noreferrer` にしないこと。

### 5-2. LinkSwitch の `vc_pid` は `window` に直接代入する

Astro の `define:vars` はスクリプトを IIFE で包む。
`var vc_pid = ...` と書くと関数スコープに閉じ込められ、
グローバルを読む `vcdal.js` から見えなくなる。
**タグの読み込みだけは成功するので、「入れたのに成果が出ない」という気づきにくい壊れ方をする。**
`LinkSwitch.astro` は `window.vc_pid = pid` と書いてある。変えないこと。

### 5-3. DMM TV は意図的にアフィリエイト対象外

DMM は FANZA と同一基盤のため、**AdSense審査へのリスク**が残る
（[DESIGN.md 3.7](../DESIGN.md) に既出）。単価は最高（afb 1,691円）だが、
AdSense を通すまでアフィリエイト化しない、と 2026-08-23 に判断した。

読者向けの検索リンクとしては有用なので**リンク自体は残している**。
解禁するときは `src/lib/affiliate.ts` の `EXCLUDED_HOSTS` から `tv.dmm.com` を消し、
`AFFILIATE_HOSTS` に移し、VC管理画面のブロック設定も外す。

### 5-4. `markdown.rehypePlugins` は Astro 7 で非推奨

動作はするが、将来のメジャーで削除される予定。移行先は
`markdown.processor` に `@astrojs/markdown-remark` の `unified({ rehypePlugins })` を渡す形。
**Astro を上げてビルドが落ちたらここを疑う。**

> なお、この機能を使うために `@astrojs/markdown-remark` を導入している。
> Astro 7 の既定プロセッサ（Sätteri）は unified ベースではないため、
> プラグインを使うにはこの追加が必須だった。
> **導入前後で出力HTMLを全記事比較し、差分は `&amp;` → `&#x26;`（同じ文字の別表記）
> 1箇所のみであることを確認済み**（2026-08-23）。表示・意味に影響はない。

### 5-5. 広告表記は「冒頭」に置く

景品表示法（2023-10-01施行のステマ規制）は、
**一般消費者が分かりやすい位置**への明記を要求する。
本文を読み進めた先ではなく記事冒頭に置くこと。`AffiliateNotice` は
`posts/[...slug].astro` でタイトル直下に配置してある。下に動かさない。

---

## 6. Phase B 以降の計画

### Phase B — ASPへの登録と提携申請

1. **バリューコマース**と**afb**に登録（この2つで U-NEXT / Hulu / ABEMA を押さえられる）
2. **Link-A** にも登録する（2026-08-23 追加）
3. U-NEXT → Hulu → ABEMA の順に提携申請
4. 承認後、`PUBLIC_VC_LINKSWITCH_PID` を設定

> **Link-A を足した理由（実測）**
> 競合の [VOD比較記事](https://www.noiat.co.jp/internet/vod_comparison/) の外部リンクを数えたところ、
> **73本が `cl.link-ag.net`**（Link-A）だった。同ページの他の経路は
> ドコモ系22本、Impact系9本、Netflixは素のリンク7本。
> **VOD特化のメディアが主力に据えているASPが Link-A** ということになる。
> DMM TV もここ経由だが、DMM は当面対象外（5-3）なので、
> こちらの狙いは **U-NEXT と Disney+**。

> **記事数が足りないと審査に落ちる。** afb・バリューコマースはサイトの体裁と記事数を見る。
> 2026-08-23 時点で記事は6本。**10〜15本に増やしてから申請する**こと。
> Phase A は審査不要なので先に動かし、記事を積みながら申請する。

### Phase C — 作品ごとの Amazon リンク（常設ページは実装済み）

**常設ページ `/leaving/<サービス>` には既に入っている**（2026-08-23）。
作品1行ごとに U-NEXT / Hulu / DMM TV / Amazon の検索リンクが並ぶ。

> ★ 常設ページは `.astro` なので **rehype-affiliate を通らない**。
> `tag=` と `rel` はページ側で `withAmazonTag()` / `relFor()` を呼んで付けている。
> 記事本文（Markdown）とは経路が違うので、方針を変えるときは**両方直す**。
> URLテンプレートは `site/src/lib/search-links.ts`（theme.yaml と同じ内容を持つ）。

**残っているのは月次記事の本文側。** いまの Amazon 導線は記事単位（末尾のCTA）で、
作品ごとではない。配信終了記事の「この作品はレンタルなら観られる」を
作品行ごとに出せると効果が大きい。

必要な変更:

1. `theme-packs/streaming-jp/theme.yaml` に Amazon を追加
   （`search_links` ではなく別キーにする。**「他のサービスで探す」は対象外4社のための節**で、
   Amazon は対象内かつ「見放題ではなくレンタル・購入」なので意味が違う）
2. `templates/*.md` と `fixed-phrases.md` に節の文言を追加
3. `article-types/*.ts` の品質ゲートを更新
   （現在は `U-NEXT|Hulu|DMM` の存在をチェックしている。Amazon 行を足すなら条件を見直す）
4. 既存記事は `/article` で再生成（**API課金なし**）

> ラベルは「Amazon（レンタル・購入）」のように**見放題と混同しない書き方**にすること。
> 見放題が終わった作品に「Amazonで配信中」と書くと誤情報になる。

### Phase D — 記事の右の追従枠 ✅ 器は実装済み（2026-08-23）

**当初は「表レイアウトの改修とセット」と考えていたが、それは不要だった。**

[競合の実装](https://www.noiat.co.jp/internet/vod_comparison/) を調べたところ、
追従枠は**本文カラムを削らず、余白に浮かせている**（`position:fixed; width:289px`）。
当サイトも本文 `46rem`（736px）中央寄せなので、1280px 画面なら片側 272px の余白があり、
**本文の幅を1mmも変えずに枠を置ける**。表が狭くなる問題は起きない。

実装は `FollowRail.astro` ＋ `global.css` の `.layout`。

```
1280px 未満  → .layout { display: block }   ＝ 従来と1ピクセルも変わらない
1280px 以上  → minmax(0,1fr) | 46rem | minmax(0,1fr) の3カラム
                                              └ ここに追従枠
```

- **JSゼロを維持**。競合はJSで追従させているが、それは本文末でフェードアウトさせるため。
  `position: sticky` なら親グリッド行の高さが自然な上限になるので、JSが要らない
- `minmax(0, 1fr)` にしているのは、`1fr` だと枠の min-content 幅で右列が広がり
  本文が中央からずれるため
- 中身はいま **Amazon 1枠**。提携できているのがそれだけのため。
  Phase B で U-NEXT が通ったら `FollowRail.astro` の `OFFER` を差し替える。
  **複数を並べない**（競合も1広告主だけ。選択肢を増やすと読者が選べなくなる）

**残っている検討事項**

- 効果測定。記事6本・流入ほぼゼロでは良し悪しが判断できない。記事を増やしてから
- **追従枠に AdSense を入れないこと。** 本文に重ならない配置なら通常は問題ないが、
  追従広告は誤クリック誘発とみなされうる領域。審査を控えている間は
  **追従枠はアフィリエイト専用**にする
- スクロール追従の実挙動は**ブラウザで目視確認していない**（headless Edge が
  スクロール後の描画を撮影できなかった）。1280px 以上で開いて確認すること

### Phase E-2 — Prime Video の Impact プログラム（要調査）

**Amazonアソシエイトとは別に、Prime Video Japan 専用のアフィリエイトプログラムが
Impact（impact.com）上で稼働している。** 2026-08-23 にリダイレクトを追って確認した。

```
https://primevideojapan.sjv.io/7aXnDr
  → www.ojrq.net/p/?return=...            （Impact の同意・同期）
  → primevideojapan.sjv.io/c/5461011/2171891/27854?sharedid=...
  → https://www.amazon.co.jp/gp/video/collection/IncludedwithPrime
       ?irclickid=...&irpid=5461011&irgwc=1&ref=dvm_ass_acm_xx_mf_s_imp_...
```

`irclickid` / `irpid` / `irgwc` は Impact Radius のパラメータで、
遷移先は Amazon.co.jp の Prime Video 見放題コレクション。
広告主ID `5461011`、キャンペーン `2171891`。

**分かっていないこと**（ここが要調査）

- **参加方法**。日本語のアフィリエイト解説記事はこのプログラムを一切扱っていない。
  自己申込みができないクローズド／招待制の可能性が高い
- **単価**。Amazonアソシエイトの Prime無料体験 500円/件 より高いのかどうか
- **アソシエイトとの併用可否**。リンクのドメインが別なので技術的な衝突は起きないが、
  規約上どうかは未確認

**当面は追わない判断**（2026-08-23）。Amazonアソシエイトは既に永続IDを保有しており、
乗り換えの利得が不明なため。調べるなら impact.com にパートナー登録して
ブランド検索するのが入口になる。

### Phase E — Disney+ / Apple TV+

どちらも招待制。**実績が出てから**再挑戦する。
Disney+ はアクセストレード / afb / Link-A、Apple は Partnerize のサインアップページから。

### Phase F — U-NEXT / Hulu の更新情報を照会するページ（優先度低）

完全自動化はできないが、両社の更新情報を察知して照会できるページを作りたい
（2026-08-23 に目標として追加）。作品別の配信状況APIが無いという制約は
[DESIGN.md 3.2.1](../DESIGN.md) のとおり変わらないので、
「配信中」と断定しない形式を維持すること。

---

## 7. 運用上の注意

- **紹介料の高いサービスを優先して掲載しない。** 配信情報は機械的に収集した事実で、
  そこに収益の都合を混ぜると記事の信頼性が壊れる。プライバシーポリシーにもそう明記した。
- Amazon のトラッキングIDを変えても**記事の再生成は不要**。
  IDは記事に焼き込まず、ビルド時に外から差し込む設計にしてある。
- 提携が切れたら `.env` から該当の値を消すだけでよい。表記も導線もまとめて消える。
