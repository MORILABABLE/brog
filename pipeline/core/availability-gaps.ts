/**
 * **在庫台帳の穴を数える。** どの作品の「いまどこで観られるか」が取れていないか。
 *
 * ■ なぜ要るか（2026-09-15）
 * 記事の表に出る ○ △ × の印は `data/availability.json` **だけ**が根拠で、
 * そこに無い作品は「—（未確認）」になる。実測するとこうだった。
 *
 *   | 記事 | 作品 | 確認済み |
 *   |---|---|---|
 *   | harry-potter | 11 | **11（100%）** |
 *   | 2026-09-leaving-netflix | 63 | 23（37%） |
 *   | 2026-09-leaving-u-next | 80 | **2（2.5%）** |
 *
 * 印が出せないと「紹介する◯本のうち△本は…でも見放題配信中です」の一文も出せない
 * （`site/plugins/rehype-next-step.ts`）。**記事の弱さではなく、台帳の薄さ**。
 *
 * ■ 台帳は**放っておくと減る**
 * 読む側（`site/src/lib/availability.ts`）は **14日**より古い行を落とす。
 * 一度取れば済むものではないので、**毎回の通知に出す**（`core/digest.ts`）。
 *
 * ■ 取りに行けるものだけを出す
 * 未来に終了する681作のうち、配信API由来（数字のID）は**124作だけ**。
 * 残りは U-NEXT の自前収集（`SID…`）と告知（`ann-…`）で、
 * **配信APIのカタログに無いので取りようがない**（docs/CROSS-SERVICE.md 9-3）。
 * 出しても打つ手が無い行は出さない。
 *
 * ■ キーワードは候補まで
 * `npm run availability -- --keyword` は**1キーワードで8作品前後**を1リクエストで返す
 * （実測 2026-09-06）。束になっていれば安い。
 * ただし**当てるのは人**（`cli/availability.ts` の★「推測で日本語を投げ続けない」）。
 * ここが出すのは原題から作った候補までで、確定はしない。
 */
import type { ChangeEvent } from '../sources/types.ts'
import { isFresh, type AvailabilityLedger } from './availability.ts'

/** 束ねるのに使う邦題の先頭文字数（`series-candidates.ts` と同じ値） */
const PREFIX_LENGTH = 6

/** 束として出す最小の作品数。1作なら束ねる意味が無い（単発として出す） */
const MIN_BUNDLE = 2

/** 単発として並べる上限。**終了日の近い順**に切る */
const MAX_SINGLES = 10

/** キーワード候補に残す語数。4語にしてあるのは下の★（`The Art of` で切らないため） */
const KEYWORD_WORDS = 4

/**
 * キーワードの末尾に残ってはいけない語。
 * ★ 語数で切ると `The Art of War II: Betrayal` が **`The Art of`** になる。
 *   前置詞・冠詞で終わるキーワードは検索の語として成立しない。
 */
const TRAILING_STOPWORDS = /^(of|the|a|an|and|in|on|to|for|with|from)$/i

export interface GapWork {
  id: string
  /** 原題（APIの言語）。キーワード候補の材料 */
  title: string
  /** 邦題。束ねと表示に使う */
  localizedTitle: string
  /** 終了予定日（ISO） */
  at: string
  service: string
}

export interface GapBundle {
  /** 束の名前（邦題の先頭6文字）。**記事の主題ではない** */
  key: string
  works: GapWork[]
  /** いちばん近い終了日 */
  nearest: string
  /** `--keyword` に渡す候補。原題が英字でなければ undefined */
  keyword?: string
}

export interface AvailabilityGaps {
  /** 未来に終了する作品のうち、配信API由来のもの（取りに行ける母数） */
  reachable: number
  /** そのうち印を出せるもの（台帳にあり、14日以内） */
  covered: number
  /** 2作以上の束。**キーワード1回で複数作に効く** */
  bundles: GapBundle[]
  /** 束にならなかった単発（終了日の近い順・上限あり） */
  singles: GapWork[]
  /** 単発の総数（`singles` は切った後） */
  singleCount: number
  /** 配信APIのカタログに無いので取りようがない作品（U-NEXT・告知） */
  unreachable: number
}

/** 原題からキーワード候補を作る。英字を含まなければ作らない */
function keywordOf(title: string): string | undefined {
  // 副題は落とす（`Sumikko Gurashi: The Patched-Up Toy Factory` → `Sumikko Gurashi`）
  const head = title.split(/[:：]/)[0]?.trim() ?? ''
  if (!/[A-Za-z]/.test(head)) return undefined
  const words = head.split(/\s+/).filter(Boolean).slice(0, KEYWORD_WORDS)
  while (words.length > 1 && TRAILING_STOPWORDS.test(words[words.length - 1]!)) words.pop()
  return words.length ? words.join(' ') : undefined
}

/**
 * 印を出せていない作品を数える。
 *
 * @param events 収集済みの全イベント（`readAllEvents()`）
 * @param ledger 在庫台帳（`loadAvailability()`）
 */
export function availabilityGaps(
  events: ChangeEvent[],
  ledger: AvailabilityLedger,
  now = new Date(),
): AvailabilityGaps {
  const iso = now.toISOString()

  /*
   * 対象は**未来に終了する作品**だけ。
   * ★ 「いま記事になる素材」がそれだから。過去に終わった作品の在庫を埋めても、
   *   これから書く記事の印は増えない。
   */
  const works = new Map<string, GapWork>()
  for (const e of events) {
    if (e.kind !== 'expiring' || !e.at || e.at <= iso) continue
    const id = String(e.work.id)
    const found = works.get(id)
    // 同じ作品に複数の終了予定があれば、**近いほう**を残す
    if (found && found.at <= e.at) continue
    works.set(id, {
      id,
      title: e.work.title,
      localizedTitle: e.work.localizedTitle ?? e.work.title,
      at: e.at,
      service: e.service,
    })
  }

  /*
   * ★ **数字のIDだけが配信API由来**（`SID…` は U-NEXT の自前収集、`ann-…` は告知）。
   *   あちらはカタログに無いので、キーワードでもIDでも取れない。
   */
  const reachable: GapWork[] = []
  let unreachable = 0
  for (const w of works.values()) {
    if (/^[0-9]+$/.test(w.id)) reachable.push(w)
    else unreachable += 1
  }

  const missing = reachable.filter((w) => !isFresh(ledger.works[w.id], now.getTime()))

  // 邦題の先頭で粗く束ねる（`series-candidates.ts` と同じ粗さ）
  const buckets = new Map<string, GapWork[]>()
  for (const w of missing) {
    const key = w.localizedTitle.slice(0, PREFIX_LENGTH)
    const list = buckets.get(key)
    if (list) list.push(w)
    else buckets.set(key, [w])
  }

  const bundles: GapBundle[] = []
  const singles: GapWork[] = []
  for (const [key, list] of buckets) {
    if (list.length >= MIN_BUNDLE) {
      const nearest = list.map((w) => w.at).sort()[0]!
      bundles.push({
        key,
        works: list.sort((a, b) => a.at.localeCompare(b.at)),
        nearest,
        /*
         * ★ 束の中で**いちばん短い候補**を採る。
         *   続編の原題は元題を含んで長くなる（`Hollow Man` / `Hollow Man II`）ので、
         *   短いほうがシリーズの根に近く、検索で両方に当たる。
         */
        keyword: list
          .map((w) => keywordOf(w.title))
          .filter((k): k is string => Boolean(k))
          .sort((a, b) => a.length - b.length)[0],
      })
    } else {
      singles.push(...list)
    }
  }

  bundles.sort((a, b) => a.nearest.localeCompare(b.nearest) || b.works.length - a.works.length)
  singles.sort((a, b) => a.at.localeCompare(b.at))

  return {
    reachable: reachable.length,
    covered: reachable.length - missing.length,
    bundles,
    singles: singles.slice(0, MAX_SINGLES),
    singleCount: singles.length,
    unreachable,
  }
}
