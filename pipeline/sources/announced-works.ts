/**
 * 告知に載っていた**邦題から作品を特定して、画像とメタ情報を足す**。
 *
 *   告知（作品名しか無い）
 *      → Wikidata で邦題 → IMDb ID
 *      → Streaming Availability API の /shows/{imdbId} で作品
 *      → ポスター・公開年・ジャンル・出演者
 *
 * ■ なぜここまでするか
 * 告知だけを記事にすると、**文字だけの表**になる。従来の記事（配信終了・配信開始）は
 * 節ごとに作品ポスターが並び、それがそのまま読者の導線になっている（AFFILIATE.md）。
 * 先出しの記事だけ絵が無いと、同じ体裁のブログの中で明らかに見劣りする。
 *
 * 画像は**必ず許諾済みの経路**（API → posters.mjs → 自ドメイン配信）に載せる。
 * 告知ページに貼られている画像は使わない。
 *
 * ■ 間違えるくらいなら載せない
 * 邦題は同名が多い（「ダンケルク」は1964年と2017年の映画がある）。
 * **1件に絞れないときは画像を諦める。** 記事は自前のジャンル別タイルに落ちるだけで、
 * これは U-NEXT 由来の作品718件が既にそうなっている見慣れた形。
 * 一方、別作品のポスターを載せると記事の信用が落ちる。天秤は明らかに片方に傾く。
 *
 * どうしても載せたい作品は `data/announcement-pins.json` に手で書く。
 *   { "ダンケルク": "tt5013056" }
 * 曖昧だった作品は候補つきでログに出るので、そこから選んで貼れる。
 *
 * ■ APIの消費
 * **特定できた作品1件につき1リクエスト。** 無料枠は500/月で、月次の収集が約250。
 * 使いすぎないよう `--max-lookups`（既定60）で頭を打つ。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ChangeEvent } from './types.ts'
import type { StreamingAvailabilitySource } from './streaming-availability.ts'
import { resolveImdbIdsByLabel, type LabelMatch } from './wikidata.ts'

/** 機械が書く。**手で編集しない。** */
export const ANNOUNCED_WORKS_PATH = join('data', 'announced-works.json')
/** 人が書く。曖昧だった作品をここで1件に決める */
export const PINS_PATH = join('data', 'announcement-pins.json')

/** 特定できなかった作品を、何日後に引き直すか。Wikidata 側に項目ができることがある */
const RECHECK_DAYS = 30

/** 1回の実行で API を叩く上限（既定）。無料枠を1コマンドで食い潰さないための保険 */
export const DEFAULT_MAX_LOOKUPS = 60

export interface AnnouncedWorkRecord {
  title: string
  /** null は「Wikidata から1件に絞れないと確認済み」 */
  imdbId: string | null
  /** API 側の作品ID。refresh:images はこれで引き直す */
  apiShowId?: string
  /** 絞れなかったときの候補。data/announcement-pins.json に貼るためのメモ */
  candidates?: LabelMatch[]
  checkedAt: string
}

export interface AnnouncedWorksStore {
  note: string
  updatedAt: string
  /** `service|title|year` -> 記録 */
  works: Record<string, AnnouncedWorkRecord>
}

const EMPTY: AnnouncedWorksStore = {
  note:
    '告知の邦題から特定した作品。npm run collect:announce が書く。手で編集しない' +
    '（手で決めたいものは data/announcement-pins.json）。',
  updatedAt: '',
  works: {},
}

export async function loadAnnouncedWorks(): Promise<AnnouncedWorksStore> {
  try {
    const raw = await readFile(ANNOUNCED_WORKS_PATH, 'utf8')
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<AnnouncedWorksStore>) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, works: {} }
    throw err
  }
}

export async function saveAnnouncedWorks(store: AnnouncedWorksStore): Promise<void> {
  await mkdir(dirname(ANNOUNCED_WORKS_PATH), { recursive: true })
  const sorted: Record<string, AnnouncedWorkRecord> = {}
  for (const k of Object.keys(store.works).sort()) sorted[k] = store.works[k]!
  const body = { ...store, updatedAt: new Date().toISOString(), works: sorted }
  await writeFile(ANNOUNCED_WORKS_PATH, JSON.stringify(body, null, 2) + '\n', 'utf8')
}

/**
 * 手で決めた対応表。無ければ空。
 *
 * `{ "邦題": "tt…" }` でも `{ "note": "…", "pins": { … } }` でも読める。
 * JSON にコメントを書けないので、由来を残せる後者の形も受ける。
 */
export async function loadPins(): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(PINS_PATH, 'utf8')) as Record<string, unknown>
    const pins = (raw.pins ?? raw) as Record<string, string>
    return Object.fromEntries(Object.entries(pins).filter(([, v]) => typeof v === 'string'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

function keyOf(e: ChangeEvent): string {
  const year = e.work.year ?? ''
  return `${e.service}|${e.work.localizedTitle ?? e.work.title}|${year}`
}

/**
 * Wikidata の instance of が、告知の区分（映画／それ以外）と合うか。
 *
 * 「film series」（シリーズ全体の項目）は**どちらにも採らない**。
 * 告知に並ぶのは個別の作品なので、シリーズの項目を掴むと必ず別物になる。
 */
function matchesType(type: string | undefined, showType: 'movie' | 'series'): boolean {
  if (!type) return false
  const t = type.toLowerCase()
  if (/film series|media franchise|video game|literary work|novel/.test(t)) return false
  if (/\bfilm\b|\bmovie\b/.test(t)) return showType === 'movie'
  if (/series|programme|program|\bshow\b/.test(t)) return showType === 'series'
  return false
}

/**
 * 告知の表記と Wikidata のラベルのズレを吸収した、問い合わせ用の候補表記。
 *
 * **告知の表記そのものは絶対に変えない**（記事に出るのは告知の表記）。
 * ここで作るのは「Wikidata に聞くときの言い方」だけ。
 *
 * 実際に外れていた形（2026-09 の実測）:
 *   エクソシスト　信じる者      全角スペース → 半角
 *   ゆるキャン△ SEASON２       季節の表記    → 落として本編で引く
 *   警視庁捜査資料管理室 シーズン1～2
 *   夜ドラ「いつか、無重力の宙で」  放送枠の冠  → 「」の中を採る
 *   かまいたちの知らんけど（見逃し配信）  配信形態の注記 → 落とす
 *
 * 変形して当たったものも、最後は**種別（映画/シリーズ）で必ず検算**される。
 * 「劇場版「緊急取調室 THE FINAL」」→「緊急取調室 THE FINAL」はテレビ版に当たるが、
 * 告知の区分が映画なので採用されない。
 */
export function labelVariants(title: string): string[] {
  const out: string[] = []
  const add = (v: string) => {
    const t = v.trim()
    if (t && t !== title && !out.includes(t)) out.push(t)
  }

  const halfSpace = title.replace(/　/g, ' ')
  add(halfSpace)

  // 告知が同名作品を区別するために付けた年（「花咲舞が黙ってない (2014)」）。
  // 題名の一部ではないので、聞くときだけ外す（絞り込みには year を使う）
  add(halfSpace.replace(/\s*[（(]\d{4}[）)]\s*$/, ''))

  // 季節・話数・配信形態の注記を落とす
  const trimmed = halfSpace
    .replace(/\s*[（(](?:見逃し配信|独占配信|字幕版|吹替版)[）)]\s*$/, '')
    .replace(/\s*(?:シーズン|SEASON|Season|シリーズ)\s*[0-9０-９]+(?:\s*[~～-]\s*[0-9０-９]+)?\s*$/u, '')
    .replace(/\s*S[0-9０-９]+(?:\s*[~～-]\s*[0-9０-９]+)?\s*$/u, '')
    .replace(/\s*エピソード\s*[0-9０-９]+\s*$/u, '')
    .trim()
  add(trimmed)

  // 放送枠や冠の後ろの「作品名」を採る（夜ドラ「…」／『怪獣８号』…「…」）
  const bracket = trimmed.match(/[「『]([^「」『』]{2,})[」』]\s*$/)
  if (bracket) add(bracket[1]!)

  return out
}

/**
 * 候補から1件を選ぶ。**選べなければ undefined**（画像を諦める）。
 *
 * 絞り込みに使えるのは、告知が持っている事実だけ:
 *   区分（映画／それ以外）  … 必ず使う
 *   アニメかどうか          … 「テレビアニメ」の枠に出た作品は anime 系を優先
 *   併記された年            … 「花咲舞が黙ってない (2014)」
 * それでも複数残ったら候補を返して手に委ねる（data/announcement-pins.json）。
 */
export function pickMatch(
  candidates: LabelMatch[],
  showType: 'movie' | 'series',
  year?: number,
  opts: { anime?: boolean } = {},
): { picked?: LabelMatch; rest: LabelMatch[] } {
  const typed = candidates.filter((c) => matchesType(c.type, showType))
  const unique = new Map<string, LabelMatch>()
  for (const c of typed) if (!unique.has(c.imdbId)) unique.set(c.imdbId, c)
  let list = [...unique.values()]

  // 告知が「テレビアニメ」の枠に置いた作品は、実写版ではなくアニメ版を採る。
  // 「ゆるキャン△」はアニメとドラマの両方があり、これが唯一の手掛かりになる。
  if (opts.anime && list.length > 1) {
    const anime = list.filter((c) => /anime|animated/i.test(c.type ?? ''))
    if (anime.length === 1) return { picked: anime[0], rest: [] }
    if (anime.length) list = anime
  }

  if (list.length === 1) return { picked: list[0], rest: [] }
  if (year) {
    const byYear = list.filter((c) => c.year === year)
    if (byYear.length === 1) return { picked: byYear[0], rest: [] }
  }
  return { picked: undefined, rest: list }
}

export interface ResolveResult {
  /** API から作品を引けた件数（＝ポスターが載る見込みの件数） */
  resolved: number
  /** 候補が複数で決められなかった作品（手でピン留めできる） */
  ambiguous: { title: string; candidates: LabelMatch[] }[]
  /** Wikidata に項目が無かった作品 */
  missing: string[]
  /** 今回投げた API リクエスト数 */
  lookups: number
}

/**
 * イベント群に画像とメタ情報を足す。**イベントは破壊的に書き換える。**
 *
 * 取れなかったものは何もしない（画像なしのまま）。
 * ここで例外を投げると、告知の取り込み自体が画像の都合で失敗することになる。
 * 画像は「あれば良いもの」なので、失敗はすべて数えるだけにする。
 */
export async function resolveAnnouncedWorks(
  events: ChangeEvent[],
  opts: {
    source: StreamingAvailabilitySource
    lang: string
    store: AnnouncedWorksStore
    pins: Record<string, string>
    maxLookups?: number
    log?: (msg: string) => void
  },
): Promise<ResolveResult> {
  const log = opts.log ?? (() => {})
  const max = opts.maxLookups ?? DEFAULT_MAX_LOOKUPS
  const result: ResolveResult = { resolved: 0, ambiguous: [], missing: [], lookups: 0 }
  const now = Date.now()

  // 1) どの作品を Wikidata に問い合わせるか決める（ピン留め済み・記録済みは省く）
  const needQuery: ChangeEvent[] = []
  for (const e of events) {
    const title = e.work.localizedTitle ?? e.work.title
    if (opts.pins[title]) continue
    const rec = opts.store.works[keyOf(e)]
    if (!rec) {
      needQuery.push(e)
      continue
    }
    // 「絞れなかった」は時間を置いて引き直す。Wikidata 側に項目が増えることがある
    const stale = now - Date.parse(rec.checkedAt) > RECHECK_DAYS * 86_400_000
    if (rec.imdbId === null && stale) needQuery.push(e)
  }

  if (needQuery.length) {
    // 告知の表記そのものと、表記ゆれを吸収した言い換えの両方を一度に聞く。
    // 問い合わせは1回あたり40件ずつに束ねられるので、件数が増えても往復は数回。
    const labels = new Set<string>()
    for (const e of needQuery) {
      const title = e.work.localizedTitle ?? e.work.title
      labels.add(title)
      for (const v of labelVariants(title)) labels.add(v)
    }
    log(`Wikidata に ${needQuery.length}件（言い換えを含めて${labels.size}通り）を問い合わせます…`)
    let found = new Map<string, LabelMatch[]>()
    try {
      found = await resolveImdbIdsByLabel([...labels], opts.lang)
    } catch (err) {
      // Wikidata が落ちていても取り込み自体は続ける（画像が無いだけ）
      log(`  Wikidata に問い合わせできませんでした: ${(err as Error).message}`)
    }
    for (const e of needQuery) {
      const title = e.work.localizedTitle ?? e.work.title
      const showType = e.work.type === 'movie' ? ('movie' as const) : ('series' as const)
      const anime = /アニメ/.test(String(e.work.meta.category ?? ''))

      // 告知の表記 → 言い換え の順に見て、**最初に1件へ絞れたもの**を採る
      let picked: LabelMatch | undefined
      let rest: LabelMatch[] = []
      for (const label of [title, ...labelVariants(title)]) {
        const r = pickMatch(found.get(label) ?? [], showType, e.work.year, { anime })
        if (r.picked) {
          picked = r.picked
          rest = []
          break
        }
        if (r.rest.length && rest.length === 0) rest = r.rest
      }
      opts.store.works[keyOf(e)] = {
        title,
        imdbId: picked?.imdbId ?? null,
        candidates: picked ? undefined : rest.length ? rest : undefined,
        checkedAt: new Date().toISOString(),
      }
      if (!picked) {
        if (rest.length) result.ambiguous.push({ title, candidates: rest })
        else result.missing.push(title)
      }
    }
  }

  // 2) 特定できたものを API で引く。1件1リクエスト
  for (const e of events) {
    if (result.lookups >= max) break
    const title = e.work.localizedTitle ?? e.work.title
    const rec = opts.store.works[keyOf(e)]
    const imdbId = opts.pins[title] ?? rec?.imdbId
    if (!imdbId) continue

    try {
      result.lookups++
      const show = await opts.source.fetchShow(imdbId)
      // ★ 題名は**告知の表記のまま**にする。API の邦題ではなく、先方が出した名前が正。
      //   API から採るのは、告知が持っていない情報だけ。
      e.work.title = show.title || e.work.title
      e.work.year ??= show.year
      e.work.rating ??= show.rating
      if (show.genres?.length) e.work.genres = show.genres
      if (show.directors?.length) e.work.directors = show.directors
      if (show.cast?.length) e.work.cast = show.cast
      if (show.overview) e.work.overview = show.overview
      if (show.posterUrl) e.work.posterUrl = show.posterUrl
      if (show.backdropUrl) e.work.backdropUrl = show.backdropUrl
      e.work.meta.imdbId = imdbId
      // refresh:images はこのIDで引き直す（posters.mjs の loadWorkImages 参照）
      e.work.meta.apiShowId = show.id
      if (rec) {
        rec.apiShowId = show.id
        rec.imdbId = imdbId
      }
      if (show.posterUrl) result.resolved++
    } catch (err) {
      // 404（API のカタログに無い作品）はふつうに起きる。止めない
      log(`  画像を取れませんでした: ${title} (${imdbId}) — ${(err as Error).message}`)
    }
  }

  return result
}
