/**
 * Google トレンド（日本）の「いま検索が伸びている語」を取る。
 *
 *   https://trends.google.com/trending/rss?geo=JP
 *
 * ■ Wikipedia との使い分け
 * Wikipedia は**作品が読まれたこと**を、こちらは**語が検索されたこと**を示す。
 * 当サイトが欲しいのは後者に近いが、返るのは**1日10〜20語**で、
 * しかもニュース・スポーツ・人物が多数を占める（実測 2026-09-15:
 * `npb感染症特例` `大野 雄大` `消費税` `柴田善臣`）。
 * **単独では素材にならない。** 在庫と当たったときだけ意味を持つ。
 *
 * ■ 取り逃すと戻せない
 * **これが Wikipedia といちばん違う点。** 過去日を指定する口が無く、
 * 返るのは当日ぶんだけ。だから**在庫に当たらない語も全部貯める**
 * （`pipeline/core/demand-store.ts`）。1日10語なら年3,650行で済む。
 *
 * ■ 規約
 * `trends.google.com/robots.txt` が拒否しているのは `/explore?` と
 * `/trends/explore?` の2つで、**`/trending/rss` は許可されている**（2026-09-15 実測）。
 * 公開フィードなので1日数回までにとどめ、素性の分かる User-Agent を名乗る。
 *
 * ★ **旧 `/trends/trendingsearches/daily/rss` は 404**（同日実測）。
 *   古い記事に載っているURLを使わないこと。
 */
import type { DemandSignal } from './types.ts'

/** ボットであることを隠さない（announcement.ts と同じ考え方） */
const USER_AGENT = 'brog/0.1 (streaming blog research; contact via repository)'

const FEED = 'https://trends.google.com/trending/rss'

const FETCH_TIMEOUT_MS = 15_000

/** `20,000+` → 20000。桁を落とさないよう、記号だけ取り除く */
function approxTraffic(raw: string | undefined): number {
  return Number((raw ?? '').replace(/[^0-9]/g, '')) || 0
}

/** `<title>` などの中身を1つ取り出す。CDATA も剥がす */
function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`).exec(xml)
  return m?.[1]?.trim()
}

/**
 * 急上昇の語を取る。
 *
 * @param geo 国コード。日本は `JP`
 * @param day 何日として記録するか（既定は JST の今日）。
 *   ★ フィードに日付欄はあるが**取得時刻とほぼ同じ**なので、
 *     こちらで「いつ観測したか」として持つ。
 */
export async function fetchTrends(geo = 'JP', day?: string): Promise<DemandSignal[]> {
  const res = await fetch(`${FEED}?geo=${encodeURIComponent(geo)}`, {
    headers: { 'User-Agent': USER_AGENT, accept: 'application/rss+xml, application/xml' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Google トレンドが ${res.status} を返しました`)

  const xml = await res.text()
  const fetchedAt = new Date().toISOString()
  // JST の日付。取得元が日付を持たないので、こちらの基準日で記録する
  const at = day ?? new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)

  const out: DemandSignal[] = []
  let rank = 0
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1] ?? ''
    const word = tag(item, 'title')
    if (!word) continue
    rank += 1
    out.push({
      source: 'google-trends',
      word,
      raw: word,
      day: at,
      count: approxTraffic(tag(item, 'ht:approx_traffic')),
      rank,
      fetchedAt,
    })
  }
  return out
}
