/**
 * **APIが把握していないのに、実際にはそこで見放題で観られる組み合わせ。**
 *
 * 一覧は `data/availability-add.json`（人が目視で確かめて手で足す）。
 * ここは**読むだけ**で、判定を1つだけ返す。
 *
 * ■ `availability-ng.ts` の対
 * あちらは「APIが言っている見放題を取り下げる」。こちらは「APIが知らない見放題を足す」。
 * **足すほうが強い主張**（読者に「そこへ行けば観られる」と言い切る）なので、
 * 台帳の注意書きのほうに条件を細かく書いてある。
 *
 * ■ 何のためにあるのか（2026-09-15）
 * 在庫台帳は `entry.services`（APIが返した社）しか持たない。APIのカタログに
 * その社の扱いが1件も無い作品は、表で**「調べたうえで取り扱いなし（×）」**になる。
 * 「機動戦士ガンダム」（テレビ版・id 10206）はAPIが Netflix しか返さず、
 * `/shows/10206` を直接引いても見放題は Netflix だけだった（2026-09-15 に実測）。
 *
 * ■ 絶対に守ること
 *   - **足すのは見放題（○）だけ。** レンタル・購入（△）は足さない
 *   - **効かせるのは表の印だけ。** 記事の素材（どの作品を載せるか）は動かさない。
 *     観測していない作品が記事の本数に混ざることになるため
 *   - **Prime Video チャンネル（アニメタイムズ等）は見放題ではない。**
 *     別料金なので、画面で見分けてから書く
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** `availability-ng.ts` の findUp と同じもの（あちらと同じ理由で上へ辿る）。 */
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

interface AddEntry {
  service: string
  ids?: string[]
  match?: string
}

let entries: AddEntry[] | null = null

function load(): AddEntry[] {
  if (entries) return entries
  const path =
    findUp('data', 'availability-add.json') ?? findUp('..', 'data', 'availability-add.json')
  if (!path) return (entries = [])
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: AddEntry[] }
    entries = (raw.entries ?? []).filter((e) => e.service && (e.ids?.length || e.match))
  } catch {
    // 壊れていても記事は出す。**補正が効かなくなるだけ**なので、
    // 直したことに気づけるようビルドログに残す。
    console.warn('data/availability-add.json が読めませんでした。見放題の補正は効きません。')
    entries = []
  }
  return entries
}

/**
 * その作品に、人が目視で足した見放題があるサービスのキー。
 * `titles` は表の行から取った題名。**部分一致**で見る（`availability-ng.ts` と同じ）。
 */
export function addedSubscriptions(
  workId: string,
  titles: readonly string[] = [],
): string[] {
  const hit = load().filter((e) => {
    if (e.ids?.includes(workId)) return true
    return !!e.match && titles.some((t) => t.includes(e.match!))
  })
  return [...new Set(hit.map((e) => e.service))]
}
