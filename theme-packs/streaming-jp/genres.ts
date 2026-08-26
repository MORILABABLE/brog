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

/**
 * 収集元が自分で付けているジャンル名 → このテーマの区分。
 *
 * ■ なぜ要るか（2026-08-26 追加）
 * U-NEXT は自前収集で、**`originalTitle` を1件も持っていない**（実測 723件中0件）。
 * Wikidata の原語も imdbId / tmdbId が無いので引けない。
 * つまり上の `isJapanese()` はU-NEXT作品に対して**必ず undefined を返す**。
 * その結果、8月の120件が丸ごとジャンル別記事から落ちていた。
 *
 * ところが U-NEXT は**自分の分類を持っている**（メニューのカテゴリ名）。
 * 推測ではなく提供元が付けた区分なので、これを使えば誤情報にならない。
 *
 * ★ **どちらとも取れる区分は入れないこと。**
 *   「キッズ」「音楽・ライブ」「バラエティ」「舞台・演劇」「ドキュメンタリー」は
 *   国内外のどちらもありうるので、意図的に対応表から外してある
 *   （振り分けを当て推量すると、邦画記事に海外作品が混ざる）。
 *   落ちた作品はサービス別記事（arrivals-service / leaving）で必ず拾われる。
 *
 * ★ 語彙が2種類ある。`work.genres` と `work.meta.mainGenreName` で
 *   表記が違う（「韓流・アジア」と「韓流・アジアドラマ」など）。**両方を入れる。**
 */
const SOURCE_GENRES: Record<string, GenreKey> = {
  洋画: 'western',
  海外ドラマ: 'western',
  '韓流・アジア': 'western',
  '韓流・アジアドラマ': 'western',
  邦画: 'japanese',
  国内ドラマ: 'japanese',
  アニメ: 'anime',
}

/**
 * 収集元のジャンル名から区分を引く。当たらなければ undefined。
 * `work.genres` を先に見る（作品ごとの値で、メニュー由来の
 * `mainGenreName` より作品に近い）。
 */
function fromSourceGenres(work: Work): GenreKey | undefined {
  for (const name of work.genres) {
    const hit = SOURCE_GENRES[name]
    if (hit) return hit
  }
  const main = work.meta.mainGenreName
  return typeof main === 'string' ? SOURCE_GENRES[main] : undefined
}

/** 作品のジャンル。判定できなければ undefined（記事に出さない）。 */
export function classify(work: Work): GenreKey | undefined {
  const japanese = isJapanese(work)
  if (japanese !== undefined) {
    return japanese ? (work.genres.includes(ANIMATION) ? 'anime' : 'japanese') : 'western'
  }
  // ★ 原語で決まらなかったときだけ、収集元の分類に頼る。
  //   Wikidata と originalTitle のほうが確度が高いので、順番を入れ替えないこと。
  return fromSourceGenres(work)
}

export function genreLabel(key: string): string {
  return GENRES.find((g) => g.key === key)?.label ?? key
}
