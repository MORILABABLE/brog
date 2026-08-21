/**
 * 作品をジャンル（アニメ / 洋画・海外ドラマ / 邦画・国内ドラマ）に振り分ける。
 *
 * ■ なぜテーマパック側にあるか
 * 「アニメ」という括りも「洋画」という括りも、日本の読者にとっての区分であって
 * パイプラインが知るべきことではない。配信APIは作品の出自を返さないので、
 * ここで Wikidata の原語と API の originalTitle から判定する。
 *
 * ■ 判定の材料と優先順位
 *   1. Wikidata の原語（P364）  … 最も確実。data/origins.json にキャッシュ済み
 *   2. API の originalTitle      … 日本作品は日本語表記で返るので、かなを含めば日本語作品
 * どちらでも決まらないものは undefined を返し、**記事に出さない**。
 * 誤って邦画記事に海外作品を混ぜるより、落とすほうが読者にとって害が小さい。
 *
 * ■ 海外アニメの扱い
 * 「アニメ」記事は日本のアニメを主軸にする。海外のアニメーション作品
 * （ヒックとドラゴン、パウ・パトロール等）は洋画記事に含める。
 */
import { readFileSync } from 'node:fs'
import { ORIGIN_CACHE_PATH, titleCacheKey, type OriginCache } from '../../pipeline/sources/wikidata.ts'
import type { ArticleVariant } from '../../pipeline/core/article.ts'
import type { Work } from '../../pipeline/sources/types.ts'

export type GenreKey = 'anime' | 'western' | 'japanese'

/** 記事にできるジャンル。ここに並べた順が `--list` の並び順になる。 */
export const GENRES: readonly ArticleVariant[] = [
  { key: 'anime', label: 'アニメ' },
  { key: 'western', label: '洋画・海外ドラマ' },
  { key: 'japanese', label: '邦画・国内ドラマ' },
] as const

/** API が genres に入れてくるアニメーション作品の名前 */
const ANIMATION = 'Animation'

/** ひらがな・カタカナ。長音符「ー」と中黒「・」は他言語の表記にも出るので含めない。 */
const KANA = /[ぁ-ゖァ-ヺ]/
/** 漢字。日本語とは限らない（中国語圏の作品も該当する）。 */
const HAN = /[㐀-䶿一-鿿豈-﫿]/

let cache: OriginCache | undefined

/**
 * 原語キャッシュを読む。無ければ空で動く（＝Wikidata由来の判定が効かないだけ）。
 * `npm run enrich` で作られる。
 */
function origins(): OriginCache {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(ORIGIN_CACHE_PATH, 'utf8')) as OriginCache
    } catch {
      cache = {}
    }
  }
  return cache
}

/** テスト・再読込用 */
export function resetOriginCache(): void {
  cache = undefined
}

function originLanguages(work: Work): string[] | undefined {
  const key = titleCacheKey({
    imdbId: typeof work.meta.imdbId === 'string' ? work.meta.imdbId : undefined,
    tmdbId: typeof work.meta.tmdbId === 'string' ? work.meta.tmdbId : undefined,
  })
  const langs = key ? origins()[key] : undefined
  return langs?.length ? langs : undefined
}

/**
 * 日本語作品か。判定できなければ undefined。
 *
 * originalTitle が漢字だけの場合に undefined を返すのは、
 * 中国語圏の作品（例: 三城記）と漢字だけの邦題（例: 敵）を区別できないため。
 * ここで当て推量すると、邦画記事に中国映画が混ざる。
 */
function isJapanese(work: Work): boolean | undefined {
  const langs = originLanguages(work)
  if (langs) return langs.includes('Japanese')

  const original = work.originalTitle
  if (!original) return undefined
  if (KANA.test(original)) return true
  if (HAN.test(original)) return undefined
  return false
}

/** 作品のジャンル。判定できなければ undefined（記事に出さない）。 */
export function classify(work: Work): GenreKey | undefined {
  const japanese = isJapanese(work)
  if (japanese === undefined) return undefined
  if (japanese) return work.genres.includes(ANIMATION) ? 'anime' : 'japanese'
  return 'western'
}

export function genreLabel(key: string): string {
  return GENRES.find((g) => g.key === key)?.label ?? key
}
