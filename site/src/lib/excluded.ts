/**
 * 記事にもページにも出さない作品。`data/excluded-works.json` を人が手で管理する。
 *
 * ■ なぜ自動判定にしないか
 * 題名のキーワードで機械的に外すと、同じ語を含む一般作品を巻き込む。
 * 実測で「ラブレース セックスの女神」（2013年の伝記映画）と
 * 「セックス・アンド・マネー」（2006年）が誤って当たった。
 * **1件ずつ人が決める**ほうが、件数（月に数件）から見ても現実的で安全。
 * 台帳の中身と足し方は `data/excluded-works.json` の先頭に書いてある。
 *
 * ★ パイプライン側にも同じ除外がある
 *   （theme-packs/streaming-jp/article-types/shared.ts の `publishable()`）。
 *   **片方だけ直すと、記事には出ないのに常設ページには出る**という状態になる。
 *   site/ は独立した npm プロジェクトでテーマパックを読めないため、こう持っている
 *   （search-links.ts と同じ事情）。
 *
 * ■ 収集データは消さない
 * ここで外れるのは掲載だけ。判断を変えれば台帳から1行消すだけで戻る。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * `data/excluded-works.json` を探す。
 * ★ `import.meta.url` は使えない（Astro がチャンクへバンドルするため）。
 *   events-data.ts と同じく、実行時のカレントから上へ辿る。
 */
function findLedger(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'data', 'excluded-works.json')
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

let cached: Set<string> | null = null

/** 出さないと決めた作品のID。台帳が無ければ空（＝除外なし）。 */
export function excludedWorkIds(): Set<string> {
  if (cached) return cached
  const path = findLedger()
  if (!path) {
    cached = new Set()
    return cached
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { works?: { id?: unknown }[] }
    cached = new Set(
      (parsed.works ?? []).map((w) => String(w.id ?? '')).filter((id) => id.length > 0),
    )
  } catch {
    // 壊れていても**ビルドは止めない**。除外が効かないだけ。
    cached = new Set()
  }
  return cached
}

/** その作品を出してよいか */
export function isPublishable(workId: string | number): boolean {
  const ids = excludedWorkIds()
  return ids.size === 0 || !ids.has(String(workId))
}
