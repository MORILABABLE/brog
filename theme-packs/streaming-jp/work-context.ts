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
import {
  CAST_CACHE_PATH,
  COMPANY_CACHE_PATH,
  DIRECTOR_CACHE_PATH,
  titleCacheKey,
  type LabelCache,
} from '../../pipeline/sources/wikidata.ts'
import type { ChangeEvent, Work } from '../../pipeline/sources/types.ts'
import { NOTES_PATH as WORK_NOTES_PATH } from '../../pipeline/sources/wikipedia.ts'

const caches = new Map<string, LabelCache>()

/** ラベルキャッシュを読む。無ければ空で動く（＝その行が出ないだけ）。 */
function labels(path: string): LabelCache {
  const hit = caches.get(path)
  if (hit) return hit
  let parsed: LabelCache
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as LabelCache
  } catch {
    parsed = {}
  }
  caches.set(path, parsed)
  return parsed
}

/** テスト・再読込用 */
export function resetCompanyCache(): void {
  caches.clear()
}

function cacheKey(work: Work): string | undefined {
  return titleCacheKey({
    imdbId: typeof work.meta.imdbId === 'string' ? work.meta.imdbId : undefined,
    tmdbId: typeof work.meta.tmdbId === 'string' ? work.meta.tmdbId : undefined,
  })
}

/**
 * 記事を書くための下調べ（`npm run research` が貯めた日本語版 Wikipedia の要旨）。
 *
 * ■ 何のためにあるか
 * 配信APIの素材だけで書くと「◯◯が××する話です」で終わり、
 * **その作品がなぜ好かれているのかが記事に出ない。**
 * 作風・評判・広がり方（累計発行部数・シリーズの展開・受賞）は事実であって
 * 感想ではないので、調べたうえで書けば推測にならない。
 *
 * ■ 使い方の決まりは templates/writing.md 4節
 * **文章を写さない。事実だけを読み取ってこちらの言葉で書く。**
 * 取れていない作品は素材の範囲で書く（無理に埋めない）。
 */
let notesCache: Record<string, { text?: string; pageTitle?: string; url?: string; missing?: boolean }> | undefined

export function researchNote(
  work: Work,
): { text: string; pageTitle: string; url: string } | undefined {
  if (!notesCache) {
    try {
      const raw = JSON.parse(readFileSync(WORK_NOTES_PATH, 'utf8')) as {
        works?: typeof notesCache
      }
      notesCache = raw.works ?? {}
    } catch {
      notesCache = {}
    }
  }
  const key = work.localizedTitle ?? work.title
  const hit = key ? notesCache[key] : undefined
  if (!hit || hit.missing || !hit.text) return undefined
  return { text: hit.text, pageTitle: hit.pageTitle ?? key, url: hit.url ?? '' }
}

/** テスト・再読込用 */
export function resetResearchNotes(): void {
  notesCache = undefined
}

/**
 * 素材に添える下調べの行。取れていない作品は空文字（＝その行が出ない）。
 *
 * ★ 出典URLを必ず添える。**書き手が対象作品の項目かどうかを確かめられるように。**
 *   題名が同じ別作品（小説版・ドラマ版）を掴んでいることがある。
 */
export function researchLines(work: Work): string {
  const note = researchNote(work)
  if (!note) return ''
  const body = note.text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
  return (
    '  リサーチ（日本語版 Wikipedia の要旨。**文章は写さず、事実だけを使うこと**）:\n' +
    `${body}\n    出典: ${note.url}`
  )
}

/** 制作会社。解決できていなければ undefined。 */
export function productionCompanies(work: Work): string[] | undefined {
  const key = cacheKey(work)
  const values = key ? labels(COMPANY_CACHE_PATH)[key] : undefined
  return values?.length ? values : undefined
}

/**
 * 人名。**日本語で取れたものだけを返す。**
 *
 * ■ なぜ日本語かどうかを見るのか（2026-08-27）
 * 配信APIが返す人名はローマ字で、記事にそのまま出すと読みにくい。
 * かといって記事側で漢字に起こすのは**推測**なので禁じている。
 * そこで Wikidata の日本語ラベルを引いておき、
 * **取れた作品だけ日本語で書き、取れなかった作品はローマ字のまま出す。**
 * 判定をここに閉じ込めておけば、記事タイプ側は「日本語か否か」を意識するだけで済む。
 *
 * ★ Wikidata は日本語ラベルが無いと英語ラベルを返す。
 *   それを「日本語で取れた」と扱うと、結局ローマ字が日本語のふりをして出る。
 *   かなor漢字を1文字でも含むかで見分ける。
 */
const HAS_JAPANESE = /[ぁ-ゖァ-ヺ㐀-䶿一-鿿]/

function japaneseOnly(values: string[] | undefined): string[] | undefined {
  const hit = (values ?? []).filter((v) => HAS_JAPANESE.test(v))
  return hit.length ? hit : undefined
}

/** 監督（日本語表記）。取れていなければ undefined。 */
export function directorNames(work: Work): string[] | undefined {
  const key = cacheKey(work)
  return japaneseOnly(key ? labels(DIRECTOR_CACHE_PATH)[key] ?? undefined : undefined)
}

/**
 * 出演者（日本語表記）。取れていなければ undefined。
 *
 * ★ Wikidata の P161 は主演に限らず数十人返ることがある。
 *   記事に並べるのは先頭の数人まで。ここで切っておく。
 */
const MAX_CAST = 5

export function castNames(work: Work): string[] | undefined {
  const key = cacheKey(work)
  return japaneseOnly(key ? labels(CAST_CACHE_PATH)[key] ?? undefined : undefined)?.slice(0, MAX_CAST)
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
