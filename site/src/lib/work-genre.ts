/**
 * 作品のジャンル（アニメ / 洋画 / 邦画）を判定する。**配信カレンダーの絞り込みに使う**（2026-09-17）。
 *
 * ■ 規則は pipeline 側と同じ（写してある）
 * 元は `theme-packs/streaming-jp/genres.ts` の `classify()`。記事のジャンル分けに使っている規則で、
 * **site は pipeline を import しない**という境界を保つため、ここに写してある
 * （`availability.ts` が `pipeline/core/availability.ts` の規則を写しているのと同じ事情）。
 * ★ **どちらかを変えるときは必ず両方を変えること。** 片方だけ変えると、
 *   ジャンル別の記事に載っている作品が、カレンダーの同じジャンルの絞り込みで出てこなくなる。
 *
 * ■ 判定の材料と優先順位（pipeline 側の注記の要約）
 *   1. Wikidata の原語（P364・`data/origins.json`）… 日本語だけなら日本の作品、日本語を含まなければ海外
 *   2. 配信APIの原題（`originalTitle`）            … かなを含めば日本の作品。漢字だけは決めない
 *   3. 各社の告知の見出し（`meta.category`）       … 「アニメ（日本）」「映画（海外）」など
 * 日本の作品で `Animation` を持つものがアニメ。**海外のアニメーションは洋画**。
 * どれでも決まらなければ `undefined`（絞り込みでは「すべて」のときだけ出る）。
 *
 * ★ U-NEXT の分類名（`SOURCE_GENRES`）は写していない。カレンダーに U-NEXT は載らない
 *   （lib/events-data.ts の CALENDAR_SERVICES）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { GenreSlug } from '../config'
import type { RawWork } from './events-data'

/** 配信APIが genres に入れてくるアニメーション作品の名前 */
const ANIMATION = 'Animation'
/** ひらがな・カタカナ。長音符「ー」と中黒「・」は他言語の表記にも出るので含めない。 */
const KANA = /[ぁ-ゖァ-ヺ]/
/** 漢字。日本語とは限らない（中国語圏の作品も該当する）。 */
const HAN = /[㐀-䶿一-鿿豈-﫿]/

let origins: Record<string, string[]> | null = null

/** `data/origins.json` を読む。無い・壊れているときは空（原語での判定が効かないだけ）。 */
function loadOrigins(): Record<string, string[]> {
  if (origins) return origins
  origins = {}
  let dir = process.cwd()
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'data', 'origins.json')
    if (existsSync(candidate)) {
      try {
        origins = JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, string[]>
      } catch {
        // 壊れていてもビルドは止めない
      }
      break
    }
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return origins
}

/**
 * 日本の作品か。判定できなければ undefined。
 * ★ キーは pipeline/sources/wikidata.ts の `titleCacheKey()` と同じ（imdbId、無ければ `tmdb:<id>`）。
 */
function isJapanese(work: RawWork): boolean | undefined {
  const meta = work.meta ?? {}
  const key = meta.imdbId ?? (meta.tmdbId ? `tmdb:${meta.tmdbId}` : undefined)
  const langs = key ? loadOrigins()[key] : undefined
  if (langs?.length) {
    // ★ 日本語を「含む」だけでは日本の作品と言えない（インセプションは French / English / Japanese）
    if (langs.length === 1) return langs[0] === 'Japanese'
    return langs.includes('Japanese') ? undefined : false
  }
  const original = work.originalTitle
  if (!original) return undefined
  if (KANA.test(original)) return true
  if (HAN.test(original)) return undefined
  return false
}

/** 各社の告知の見出しから。**見る順番に意味がある**（「アニメ映画（日本）」はアニメであって邦画ではない） */
function fromAnnouncementCategory(work: RawWork): GenreSlug | undefined {
  const meta = work.meta ?? {}
  if (meta['source'] !== 'announcement') return undefined
  const category = meta['category']
  if (typeof category !== 'string') return undefined
  if (/アニメ/.test(category)) return /日本/.test(category) ? 'anime' : 'western'
  if (/海外|韓国|中国|アジア/.test(category)) return 'western'
  if (/日本|国内/.test(category)) return 'japanese'
  return undefined
}

/** 作品のジャンル。判定できなければ undefined。 */
export function workGenre(work: RawWork): GenreSlug | undefined {
  const japanese = isJapanese(work)
  if (japanese !== undefined) {
    return japanese ? ((work.genres ?? []).includes(ANIMATION) ? 'anime' : 'japanese') : 'western'
  }
  // ★ 原語で決まらなかったときだけ、提供元の区分に頼る（順番を入れ替えないこと）
  return fromAnnouncementCategory(work)
}
