/**
 * **APIが「見放題」と言っているのに、実際にはそこに無い組み合わせ。**
 *
 * 一覧は `data/availability-ng.json`（人が目視で確かめて手で足す）。
 * ここは**読むだけ**で、判定を1つだけ返す。
 *
 * ■ ★ 判定がパイプライン側と二重にある
 * `pipeline/core/availability-ng.ts` に同じ規則がある。
 * **site は pipeline を import しない**という境界を保つため、意図的に写してある
 * （`availability.ts` の「見放題は subscription だけ」と同じ事情）。
 * **どちらかを変えるときは必ず両方を変えること。**
 *
 * ■ 何のためにあるのか（2026-09-09）
 * コナンの劇場版8作について、APIは Prime Video の `subscription` を返し続けている。
 * 運営者がAmazonの画面を目視したところ**見放題には1本も無かった**（レンタル・購入だけ）。
 * 表には ○ が並び、リードは「Amazon Prime Videoでも一部タイトルが見放題」と書いていた。
 *
 * ■ 絶対に守ること
 *   - **取り下げるのは見放題（○）だけ。** レンタル・購入（△）はAPIのまま残す
 *   - **「取り扱いなし（×）」にしない。** 目視で確かめたのは「見放題に無い」ことだけ。
 *     見放題を取り下げた結果その社の根拠が1つも無くなるなら、**「—（未確認）」**に倒す
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** `availability.ts` の findUp と同じもの（あちらと同じ理由で上へ辿る）。 */
function findUp(...segments: string[]): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, ...segments)
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

interface NgEntry {
  service: string
  ids?: string[]
  match?: string
}

let entries: NgEntry[] | null = null

function load(): NgEntry[] {
  if (entries) return entries
  const path =
    findUp('data', 'availability-ng.json') ?? findUp('..', 'data', 'availability-ng.json')
  if (!path) return (entries = [])
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: NgEntry[] }
    entries = (raw.entries ?? []).filter((e) => e.service && (e.ids?.length || e.match))
  } catch {
    // 壊れていても記事は出す。**否認が効かなくなるだけ**なので、
    // 直したことに気づけるよう黙って空にはせず、ビルドログに残す。
    console.warn('data/availability-ng.json が読めませんでした。見放題の否認は効きません。')
    entries = []
  }
  return entries
}

/**
 * その（作品・サービス）の見放題を取り下げるか。
 * `titles` は表の行から取った題名。**部分一致**で見る。
 */
export function deniesSubscription(
  service: string,
  workId: string,
  titles: readonly string[] = [],
): boolean {
  return load().some((e) => {
    if (e.service !== service) return false
    if (e.ids?.includes(workId)) return true
    return !!e.match && titles.some((t) => t.includes(e.match!))
  })
}
