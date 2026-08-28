# 翌月ラインナップの告知（配信開始「予定」の収集）

最終更新: 2026-08-28

配信各社が前月末に出す「翌月の配信開始ラインナップ」を読み、
**配信が始まる前に記事を書く**ための仕組み。

> **なぜ要るのか。** Streaming Availability API の `upcoming`（配信開始予定）は、
> 日本のカタログでは4社とも **0件のまま**（`theme.yaml` の実測）。
> 一方で各社は前月末に翌月のラインナップを自社サイトで告知している。
> 先出しの記事を書ける素材は、いまのところここにしかない。

---

## 1. コマンド

| コマンド | 内容 |
|---|---|
| `npm run collect:announce -- --check` | 告知が**出ているか**だけ見る。何も書かない・APIを使わない |
| `npm run collect:announce` | 翌月ぶんを取り込む（画像も用意する） |
| `npm run collect:announce -- --month 2026-09` | 月を指定する |
| `npm run collect:announce -- --dry-run` | 解析結果だけ見る |
| `npm run collect:announce -- --no-images` | 画像を取りに行かない（API消費 0） |

取り込むと `data/events/{YYYY-MM}.jsonl` に **`kind: "upcoming"`** のイベントが増える。
形は他の収集と同じなので、通知（`digest.ts`）も記事の仕組みも無改修で通る。

---

## 2. 何を取り、何を取らないか

取るのは**事実だけ**。作品名・配信開始日・見放題／独占の区分の3つ。

**紹介文と画像は取らない。**

- 紹介文は先方が書いた文章そのもので、引用の範囲を超えて使えば複製になる
- 画像は再配信の許諾が無い。記事の画像は `posters.mjs` の経路
  （Movie of the Night に照会して 2026-08-25 に許諾済み）だけを使う

記事の文章はこちらで書く。告知は「何がいつ始まるか」の一次情報としてだけ扱う。

### 相手への負荷

About Amazon の robots.txt は `User-agent: * / Crawl-delay: 10` のみで、
Disallow は無い（2026-08-28 実測）。読むのは月に1ページだが、
同じホストへの連続取得には10秒空ける（`MIN_INTERVAL_MS`）。
U-NEXT の `min_interval_ms` と同じ考え方で、**速くしたくなっても下げないこと。**

---

## 3. 各社の告知の出方（2026-08-28 調査）

| サービス | 出どころ | 出る時期 | 解析器 |
|---|---|---|---|
| **Prime Video** | About Amazon（`…/amazon-prime-video-new-content-{月}-{年}`） | 前月末（9月分は8月28日） | `about-amazon` |
| Disney+ | 公式のラインナップページ | 前月25日前後 | 未実装（月ごとのURLが安定しない） |
| Netflix | **日本には月次の公式ページが無い**。報道各社と公式Xが実質の告知 | 前月26〜27日 | 未実装 |
| U-NEXT | プレスルーム（`/ja/press-room/{年}-{月}-unext-lineups`） | 月末2〜3日前 | 未実装 |

URLが規則的で、日付と独占区分まで構造化されている Prime Video から実装した。

### 解析器を増やす

1. `theme.yaml` の `announcements:` に1件足す（`service` / `label` / `publisher` / `parser` / `url`）
2. `pipeline/sources/announcement.ts` の `PARSERS` に解析関数を1つ足す

パイプラインの他の場所は触らない。記事側（`special --kind upcoming`）も無改修で新サービスを含む。

---

## 4. 画像

告知には画像が無い。**邦題から作品を特定して、許諾済みの経路で取ってくる。**

```
告知の邦題 → Wikidata（ja ラベル）→ IMDb ID → API /shows/{imdbId} → ポスター・年・ジャンル
```

- **特定できた作品1件につき1リクエスト。** 上限は `--max-lookups`（既定60）
- 実測（2026年9月・84件）: **37件で画像を取得**、47件は Wikidata に項目が無し
- 1件に絞れないときは**画像を諦める**（記事はジャンル別の自前タイルに落ちる）

同名作品で絞れなかったものは、候補つきでログに出る。決めたいものは
`data/announcement-pins.json` に手で書く。

```json
{ "pins": { "ダンケルク": "tt5013056" } }
```

> **なぜ間違えるくらいなら載せないのか。** ポスターが1枚違うと、記事の信用が落ちる。
> 一方、画像が無い行はすでにサイト中にある（U-NEXT 由来の718件）。天秤は明らかに片方に傾く。

---

## 5. 記事にする

記事タイプは **`upcoming`（サービス × ジャンル）**。1サービスにつき3本出す。

```bash
npm run write -- --type upcoming --genre anime    --service prime-video --month 2026-09 --emit
npm run write -- --type upcoming --genre western  --service prime-video --month 2026-09 --emit
npm run write -- --type upcoming --genre japanese --service prime-video --month 2026-09 --emit
```

区分は月次記事（`arrivals --genre`）と同じ3つ。**サイト内でジャンルの呼び方を増やさない。**

| `--genre` | 記事 | 2026年9月・Prime Video の実測 |
|---|---|---|
| `anime` | アニメ | 10本 |
| `western` | 洋画・海外ドラマ | 53本 |
| `japanese` | 邦画・国内ドラマ | 17本 |

> **1本にまとめないのは、80件超の表を読者が読めないから。**
> 薄い月・薄いジャンルが出ることは織り込んでいる（それでも軸がはっきりしているほうが読まれる）。
> ラインナップを1本残らず1本の記事にしたい月は、特報として書ける
> （`--type special --kind upcoming --from/--to`）。

**スポーツ・バラエティーはどの記事にも載らない。** ジャンルの3区分のどれでもなく、
当て推量で邦画記事に入れるほうが害が大きいため（`genres.ts` の方針）。

### タイトルの型

    【{年}年{月}月配信開始】{サービス}の見放題{ジャンル}{本数}本｜{見どころ}

> 【2026年9月配信開始】Amazon Prime Videoの見放題アニメ10本｜ゆるキャン△3期分

**先頭の【】が「配信開始」まで名乗る唯一の記事タイプ。** 同じ月には
「【2026年9月】…見放題配信が終了予定の作品36本」も並ぶので、
**先頭の数文字で開始と終了を取り違えさせない**ための形（`templates/naming.md`）。
そのぶん本文側の動詞句は求めないが、**「見放題」は必ず入れる**（品質ゲートが見ている）。

`--kind new`（もう始まっている）と**意味が正反対**なので、品質ゲートが取り違えを止める。

- 「配信中です」「配信が始まりました」「今すぐ観られます」→ **公開が止まる**
- 末尾に「公式発表」の出典表記が要る（`attribution-announcement`）。
  **API を出典として書くと止まる**（取得していないAPIを出典として偽ることになるため）

書いたあとは他の記事と同じ。

```bash
npm run write -- --apply
cd site && npm run sections -- --write
```

> **節の見出しは「◯月◯日：」で始める。** `make-sections.mjs` は日付で始まる見出しの節だけを
> 画像の対象にするので、これを外すと**その節だけ絵が入らない**。

---

## 6. 自動化（25日以降）

`.github/workflows/announce.yml` が JST の25〜31日、毎日05:00に動く。

```
① --check   出ているか・記事1本ぶん（20件）あるかを見る。何も書かない
② 取り込み  出ていれば記録し、画像も用意する
③ 通知      Issue → メール。本文に記事の書き出しコマンドが入る
```

出ていない日は 404 で静かに終わる（**エラーにしない**。出るまでの数日は必ず404になるため）。
取り込み済みの日は「新しい告知はありません」で終わり、API も消費しないし通知も鳴らない。

③のあと記事を書くのは人（`/article`）。**生成まで自動化するのは P3。**

---

## 7. データの形

```jsonc
{
  "collectedAt": "2026-08-28T11:20:00.000Z",
  "service": "prime-video",
  "kind": "upcoming",              // ★ new ではない。まだ始まっていない
  "at": "2026-08-31T15:00:00.000Z", // 配信開始予定日（JST 9月1日 00:00）
  "work": {
    "id": "ann-3f9c1a2b7d",         // 告知には作品IDが無いので題名と日付から作る
    "title": "Inception",           // API で特定できたものは原題が入る
    "localizedTitle": "インセプション", // ★ 告知の表記そのまま。これが正
    "posterUrl": "https://cdn.movieofthenight.com/...",
    "meta": {
      "source": "announcement",     // ★ 出典表記の切り替えに使う
      "publisher": "About Amazon",
      "announcementUrl": "https://www.aboutamazon.jp/news/...",
      "category": "映画（海外・韓国）",
      "note": "見放題配信",          // ＊以降の区分
      "apiShowId": "70",            // refresh:images はこれで引き直す
      "raw": "インセプション"          // 告知の行そのもの
    }
  }
}
```

`data/announced-works.json` は邦題→IMDb IDの記録（機械が書く。手で編集しない）。
`data/announcement-pins.json` は人が決める対応表。**役割が違うので混ぜない。**

---

## 8. サイトには出さない

配信開始「予定」は**作品ページに出していない**（`site/src/lib/works.ts` で落としている）。

作品ページは「いま観られるか・いつまで観られるか」を伝える場所で、
`stateOf()` は `expiring` / `removed` 以外をすべて「配信開始」として扱う。
予定を混ぜると**まだ始まっていない配信を「配信開始」と表示してしまう。**

告知は記事の素材としてだけ使う。
