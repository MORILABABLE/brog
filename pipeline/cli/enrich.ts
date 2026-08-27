/**
 * 収集済みイベントに、あとから Wikidata の情報を足す。
 *
 *   npm run enrich
 *
 * ■ なぜ必要か
 * 台帳（data/ledger.json）は同じ変化を二度拾わないので、
 * **一度収集した作品は再収集で情報を補えない。** 配信APIの無料枠も無駄になる。
 * Wikidata はキー不要・無料なので、貯めたイベントに対して何度でも引き直せる。
 *
 * ■ 今やること
 *   原語（P364）     ジャンル別記事の振り分けに要る
 *   制作会社（P272） 「同じ制作会社の作品が一斉に配信開始」を書くために要る
 *
 * 収集時にも解決しているので、通常は
 *   - 新しい素材（制作会社など）を使い始めた直後（過去ぶんが未解決）
 *   - Wikidata 側の照会が失敗していた月の埋め直し
 * に走らせる。すでに解決済みのものは問い合わせない。
 */
import { loadTheme } from '../theme.ts'
import { readAllEvents } from '../core/events.ts'
import {
  loadCastCache,
  loadCompanyCache,
  loadDirectorCache,
  loadOriginCache,
  resolveCast,
  resolveCompanies,
  resolveDirectors,
  resolveOrigins,
  saveCastCache,
  saveCompanyCache,
  saveDirectorCache,
  saveOriginCache,
  titleCacheKey,
  type TitleRef,
} from '../sources/wikidata.ts'

async function main(): Promise<void> {
  const theme = await loadTheme()
  const events = await readAllEvents()

  const refs: TitleRef[] = events.map((e) => ({
    imdbId: typeof e.work.meta.imdbId === 'string' ? e.work.meta.imdbId : undefined,
    tmdbId: typeof e.work.meta.tmdbId === 'string' ? e.work.meta.tmdbId : undefined,
  }))
  const targets = new Set(refs.map(titleCacheKey).filter((k): k is string => Boolean(k)))

  console.log(`テーマ: ${theme.label}  収集済みイベント: ${events.length}件  作品 ${targets.size}件\n`)

  // --- 原語 ---
  const origins = await loadOriginCache()
  const originsPending = [...targets].filter((k) => !(k in origins))
  if (originsPending.length === 0) {
    console.log(`原語: 解決済み（未解決 0件）`)
  } else {
    console.log(`原語: 未解決 ${originsPending.length}件を照会します...`)
    await resolveOrigins(refs, origins)
    await saveOriginCache(origins)
    const resolved = [...targets].filter((k) => origins[k]?.length).length
    const japanese = [...targets].filter((k) => origins[k]?.includes('Japanese')).length
    console.log(`  → ${resolved}/${targets.size}件（うち日本語作品 ${japanese}件）`)
  }

  // --- 制作会社 ---
  const companies = await loadCompanyCache()
  const companiesPending = [...targets].filter((k) => !(k in companies))
  if (companiesPending.length === 0) {
    console.log(`制作会社: 解決済み（未解決 0件）`)
  } else {
    console.log(`制作会社: 未解決 ${companiesPending.length}件を照会します...`)
    await resolveCompanies(refs, theme.site_language, companies)
    await saveCompanyCache(companies)
    const resolved = [...targets].filter((k) => companies[k]?.length).length
    console.log(`  → ${resolved}/${targets.size}件`)
  }

  // --- 監督 ---
  //
  // ★ 人名をローマ字のまま記事に出さないために引く（2026-08-27 追加）。
  //   記事側で漢字に起こすのは推測になるので、Wikidata の日本語ラベルを使う。
  const directors = await loadDirectorCache()
  const directorsPending = [...targets].filter((k) => !(k in directors))
  if (directorsPending.length === 0) {
    console.log(`監督: 解決済み（未解決 0件）`)
  } else {
    console.log(`監督: 未解決 ${directorsPending.length}件を照会します...`)
    await resolveDirectors(refs, theme.site_language, directors)
    await saveDirectorCache(directors)
    const resolved = [...targets].filter((k) => directors[k]?.length).length
    console.log(`  → ${resolved}/${targets.size}件`)
  }

  // --- 出演者 ---
  const cast = await loadCastCache()
  const castPending = [...targets].filter((k) => !(k in cast))
  if (castPending.length === 0) {
    console.log(`出演者: 解決済み（未解決 0件）`)
  } else {
    console.log(`出演者: 未解決 ${castPending.length}件を照会します...`)
    await resolveCast(refs, theme.site_language, cast)
    await saveCastCache(cast)
    const resolved = [...targets].filter((k) => cast[k]?.length).length
    console.log(`  → ${resolved}/${targets.size}件`)
  }

  console.log('\n※残りは Wikidata に項目が無い作品。記事側は無い前提で動く。')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
