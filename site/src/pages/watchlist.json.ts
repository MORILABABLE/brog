import { publishableWorkPages, resumedOn } from '../lib/works'
import { isoDate } from '../utils/date'
import type { APIContext } from 'astro'

/**
 * ブックマーク一覧（`/watchlist`・2026-09-22 まで「ウォッチリスト」）が読む作品の索引。**このサイト唯一のデータ配信口。**
 *
 * ■ なぜ必要か
 * ★は `localStorage` に**作品IDと、付けた時点の写し**を持つ（docs/GROWTH.md 3-6）。
 * ところが**終了予定日は後から動く** — 実測では「終了予定日を経過」の大半が延長で、
 * 写しをそのまま出すと**読者に嘘の日付を見せる**ことになる。
 * そこで `/watchlist` は毎回この索引を読み、**新しい方で上書きする**。
 * 写しは索引に無かったとき（掲載を外れた作品）の保険として残す。
 *
 * ■ 形
 *   { "asOf": "2026-09-18", "works": { "<作品ID>": [題名, サービス名, 日付, 状態] } }
 *
 * ★ **配列の並びを変えないこと。** 読む側は `pages/watchlist.astro` の1か所だけで、
 *   添字で取り出している。キー名を付けると全作品ぶん名前が繰り返されて倍近くなる。
 *     [0] 題名（邦題優先）
 *     [1] サービス名（`services[0]` ＝ **最も行動が要る**サービスのラベル）
 *     [2] 日付 `YYYY-MM-DD`（終了予定日 / 終了日 / 配信開始日。状態で意味が変わる）
 *     [3] 状態（`WorkState`。leaving / passed / ended / started）
 *     [4] **配信再開**（あるときだけ・2026-09-22）… `[サービス名, 日付, 'log' | 'stock']`
 *         見放題の終了を観測したあとで観られる先が見つかった作品（`lib/works.ts` の `resumedOn()`）。
 *         作品ページの「※配信再開時はブックマーク一覧でお知らせします」を守るための値で、
 *         **ここを外すと、その約束だけが残る。** 無い作品は4要素のまま（全体を膨らませない）。
 *
 * ★ **ポスターを入れていない。** 索引が作品ページと同じ数（約680件）あるので、
 *   URL を1本足すだけで全体が数倍になる。絵は `/posters/<ID>.webp` という
 *   決まった形なので、**読む側でIDから組み立てられる**（無ければ絵を出さない）。
 *
 * ★ **noindex を付ける口が無い**（HTMLではないため）。
 *   サイトマップは `plugins/prune-sitemap.ts` が**ビルド後のHTMLを読んで**作るので、
 *   HTMLでないこのファイルはそもそも載らない。`robots.txt` も触らなくてよい。
 *
 * ★ 掲載判定を通らない作品は**入れない**（`publishableWorkPages()`）。
 *   作品ページと同じ集合にしておかないと、リンク先が404のカードが出る。
 */
export async function GET(_context: APIContext) {
  const works = publishableWorkPages()

  const index: Record<string, [string, string, string, string, [string, string, string]?]> = {}
  for (const w of works) {
    // ★ `services[0]` は「最も行動が要るサービス」に並べ替えた先頭（lib/works.ts）。
    //   作品ページの見出しが根拠にしているのと同じ1件を使う。
    //   ここを別の選び方にすると、作品ページと一覧で日付が食い違う。
    const head = w.services[0]
    if (!head) continue
    const resumed = resumedOn(w)
    index[w.id] = resumed
      ? [w.title, head.label, isoDate(head.at), head.state, [resumed.label, isoDate(resumed.at), resumed.via]]
      : [w.title, head.label, isoDate(head.at), head.state]
  }

  return new Response(
    JSON.stringify({ asOf: isoDate(new Date()), works: index }),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        /*
         * ★ 長く持たせないこと。**終了予定日が動くのが前提**のデータで、
         *   収集は週2回走る（docs のとおり火・金 JST）。
         *   1時間なら、読者が開き直したときには新しい方を読む。
         */
        'cache-control': 'public, max-age=3600',
      },
    },
  )
}
