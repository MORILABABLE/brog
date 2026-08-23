# アフィリエイト

最終更新: 2026-08-23

収益化の実装と、提携状況の調査結果。

**いま何が動いていて、何を人手でやる必要があるか**をここに集約する。
設計思想は [DESIGN.md 7節](../DESIGN.md#7-収益化)、日々の作業は [HANDOVER.md](./HANDOVER.md)。

---

## 1. いまの状態

**Phase A（実装）は完了。動かすには `site/.env` に値を入れるだけ。**

| | 状態 |
|---|---|
| リンクの体裁（`rel="sponsored"` / `target`） | ✅ ビルド時に自動付与 |
| Amazon のトラッキングID付与 | ✅ ビルド時に自動付与（IDは記事に焼き込まない） |
| LinkSwitch（U-NEXT / Hulu の自動変換） | ✅ 実装済み・**PID未設定なので未稼働** |
| 広告（PR）表記 | ✅ 実装済み・**アフィリエイト未設定なので非表示** |
| Amazon規約の固定文 | ✅ 実装済み・**ID未設定なので非表示** |
| プライバシーポリシー | ✅ 追記済み |
| Amazon への導線（記事末尾・トップ） | ✅ 実装済み・**ID未設定なので非表示** |
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
2. U-NEXT → Hulu → ABEMA の順に提携申請
3. 承認後、`PUBLIC_VC_LINKSWITCH_PID` を設定

> **記事数が足りないと審査に落ちる。** afb・バリューコマースはサイトの体裁と記事数を見る。
> 2026-08-23 時点で記事は6本。**10〜15本に増やしてから申請する**こと。
> Phase A は審査不要なので先に動かし、記事を積みながら申請する。

### Phase C — 作品ごとの Amazon リンク

いまの Amazon 導線は記事単位（末尾のCTA）で、**作品ごとではない**。
配信終了記事の「この作品はレンタルなら観られる」を作品行ごとに出せると効果が大きい。

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

### Phase D — 記事の左右フィールド

現在は1カラム（`global.css` の `--max-width: 46rem`）。
右レールを作るには横幅を広げる必要があるが、記事本文が**配信終了作品の表**主体で
横幅を食うため、素直に広げると表が読みにくくなる。

**表レイアウトの改修（折りたたみ・格納等）とセットで検討する**方針
（2026-08-23 に決定・未着手）。

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
