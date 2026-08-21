/**
 * 作品の「周辺情報」を記事から引けるようにする。
 *
 * ■ なぜ要るか
 * 見放題への追加は、その作品単体の事情ではなく
 * **新作の放送・公開に合わせて過去作がまとめて解禁される**ことが多い。
 * 「同じ制作会社の作品が同じ日に3本入った」は読者にとって意味のある情報だが、
 * 配信APIはそれを返さない。Wikidata から引いてキャッシュしたものをここで読む。
 *
 * ■ 推測との境界
 * ここが返すのは Wikidata に載っている事実だけ。
 * 「新作が◯月から放送」のような時期の断定は**データにならないので扱わない**
 * （テンプレート `arrivals.md`「データの外にあることを書くとき」参照）。
 */
import { readFileSync } from 'node:fs'
import { COMPANY_CACHE_PATH, titleCacheKey, type LabelCache } from '../../pipeline/sources/wikidata.ts'
import type { ChangeEvent, Work } from '../../pipeline/sources/types.ts'

let cache: LabelCache | undefined

/** 制作会社キャッシュを読む。無ければ空で動く（＝制作会社の行が出ないだけ）。 */
function companies(): LabelCache {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(COMPANY_CACHE_PATH, 'utf8')) as LabelCache
    } catch {
      cache = {}
    }
  }
  return cache
}

/** テスト・再読込用 */
export function resetCompanyCache(): void {
  cache = undefined
}

function cacheKey(work: Work): string | undefined {
  return titleCacheKey({
    imdbId: typeof work.meta.imdbId === 'string' ? work.meta.imdbId : undefined,
    tmdbId: typeof work.meta.tmdbId === 'string' ? work.meta.tmdbId : undefined,
  })
}

/** 制作会社。解決できていなければ undefined。 */
export function productionCompanies(work: Work): string[] | undefined {
  const key = cacheKey(work)
  const values = key ? companies()[key] : undefined
  return values?.length ? values : undefined
}

/**
 * 同じ制作会社の作品が複数ある組を返す。プロンプトで「まとまり」を示すのに使う。
 *
 * 記事の軸になるのは「同じ日に複数入った」ケースなので、
 * 日付をまたぐ組も拾ったうえで、日付は呼び出し側が見られるようにしておく。
 */
export function companyGroups(items: ChangeEvent[]): Map<string, ChangeEvent[]> {
  const groups = new Map<string, ChangeEvent[]>()
  for (const e of items) {
    for (const company of productionCompanies(e.work) ?? []) {
      groups.set(company, [...(groups.get(company) ?? []), e])
    }
  }
  // 1本しかない制作会社は「まとまり」ではないので落とす
  for (const [company, group] of groups) {
    if (group.length < 2) groups.delete(company)
  }
  return groups
}
