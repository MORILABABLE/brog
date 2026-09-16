/**
 * **いま需要が立っていて、見放題の終了が近い作品**を棚に出す。
 *
 * ■ どこから来るか
 * `data/demand-picks.json`。書くのは `npm run demand -- --picks`
 * （`pipeline/core/demand-picks.ts`）で、**3日おきに GitHub Actions が更新する。**
 * 記事（.md）は1文字も書き換えない — 自動で動いてよいのは
 * 「どれを前に出すか」までで、記事の中身は人が決める（docs/DEMAND.md 6節）。
 *
 * ■ 🔴 需要の数字は**このファイルにも画面にも出ない**
 * 並び順だけが需要を反映する。画面に出る言葉は
 * **作品ページが持っている観測**（終了予定日・サービス名）から組む。
 *
 * Wikipedia の閲覧数を根拠に「話題の作品」と名乗ると、
 * **当サイトの観測ではないものを当サイトの主張として出す**ことになる
 * （docs/DEMAND.md 2節の🔴）。しかも実測で当てにならない —
 * `VIVANT 45,561` は地上波の再放送由来の可能性が高い（同7節★）。
 * **「9月26日に終了予定」なら当サイトが観測している。** そちらだけを書く。
 *
 * ■ 日付とサービス名は picks から取らない。**作品ページから取る**
 * picks が決めるのは「どの作品を、どの順で」だけ。文言の材料は
 * `workPage()` が返す `WorkServiceState` を使う。こうしておくと、
 * 収集で状態が動いた日に**棚と作品ページが違うことを言う**事故が起きない
 * （picks は3日おき、収集は週2回で、更新の周期が違う）。
 *
 * ■ 出す条件は3つ
 *   1. 作品ページが作られていること（`workPage()` が undefined を返さない）
 *   2. 先頭のサービスの状態が `leaving`（**まだ観られる**）
 *   3. 終了予定日が未来
 *
 * 2 と 3 を落とすと「9月26日まで」と書いた札が終了後も棚に残る。
 * picks の側にも同じ足切りはあるが、**あちらは3日に一度しか動かない。**
 * ビルドは毎日走るので、最後の判断はここでする。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { headlineDate, workLabel, workPage, type WorkPage } from './works'

/** 棚に並べる最大数。横スクロール1本ぶん（`SeriesShelf` の `RAIL_MAX_ITEMS` と同じ考え方） */
export const SHELF_MAX = 8

/**
 * これを下回るなら棚ごと出さない。
 *
 * ★ **1枚だけの「棚」は棚に見えない。** 横スクロールの形が意味を持つのは
 *   「まだ先がある」と伝わるときで、1枚だと**ただの浮いたカード**になる。
 *
 * ★ 実測（2026-09-16）で、終了日が未来の候補7件のうち**作品ページがあるのは2件**だった。
 *   残り5件は U-NEXT（`SID…`）などで、監督も出演者も解決できていないため
 *   ページが作られない（`works.ts` の `isWorkPagePublishable`）。
 *   **この枠の上限は候補の数ではなく、作品ページの数で決まる。**
 */
export const SHELF_MIN = 2

interface PickRecord {
  workIds?: string[]
  title?: string
  answer?: string
  deadline?: string
}

interface PicksFile {
  asOf?: string
  picks?: PickRecord[]
}

export interface DemandShelfItem {
  id: string
  href: string
  /** 同名の別作品があるときだけ製作年が付く（`workLabel()`） */
  title: string
  /** `/posters/<ID>.webp`。無ければ undefined（カテゴリ色のタイルになる） */
  poster?: string
  /** `Netflix` など。**作品ページと同じラベル** */
  serviceLabel: string
  /** `9月26日`（今年なら年を落とす。作品ページの見出しと同じ関数） */
  when: string
}

/**
 * `data/demand-picks.json` を探す。
 * ★ `series-for-work.ts` / `work-links.ts` と同じ理由で実行時のカレントから上へ辿る。
 *   Astro はビルド時にこのファイルをチャンクへバンドルするので、
 *   `import.meta.url` からの相対解決は位置が変わって当たらない。
 */
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

let cached: PicksFile | null = null

function load(): PicksFile {
  if (cached) return cached
  cached = { picks: [] }
  const path = findUp('data', 'demand-picks.json')
  if (!path) return cached
  try {
    cached = JSON.parse(readFileSync(path, 'utf8')) as PicksFile
  } catch {
    // 壊れていれば棚を出さない。**ビルドは止めない**（棚は本文ではない）
    cached = { picks: [] }
  }
  return cached
}

/** 棚に出せる形に直した1件。出せなければ undefined */
function itemOf(pick: PickRecord, now: Date): DemandShelfItem | undefined {
  if (pick.answer !== 'until') return undefined
  for (const id of pick.workIds ?? []) {
    const w: WorkPage | undefined = workPage(id)
    if (!w) continue
    const head = w.services[0]
    // 「まだ観られる」ものだけ。`passed` / `ended` / `started` は棚の文言に合わない
    if (!head || head.state !== 'leaving') continue
    if (head.at.getTime() <= now.getTime()) continue
    return {
      id: w.id,
      href: `/works/${w.id}`,
      title: workLabel(w),
      poster: w.poster,
      serviceLabel: head.label,
      when: headlineDate(head.at),
    }
  }
  return undefined
}

/**
 * 棚に並べるぶん。**0件なら呼び出し側は何も描かない。**
 *
 * @param excludeId この作品を外す（作品ページで自分自身を並べないため）
 */
export function demandShelf(excludeId?: string, now = new Date()): DemandShelfItem[] {
  const out: DemandShelfItem[] = []
  const seen = new Set<string>()
  for (const pick of load().picks ?? []) {
    const item = itemOf(pick, now)
    if (!item) continue
    if (item.id === excludeId || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
    if (out.length >= SHELF_MAX) break
  }
  return out.length >= SHELF_MIN ? out : []
}

/**
 * その作品が**いま需要の候補に載っているか**。
 *
 * ★ 使い道は「棚に出すかどうか」ではなく、**作品ページの記事への導線を
 *   出す順の判断**（`/works/[id].astro`）。画面にこの真偽は出さない。
 */
export function isPicked(workId: string): boolean {
  return (load().picks ?? []).some((p) => (p.workIds ?? []).includes(workId))
}

/** テスト・再読込用 */
export function resetDemandPicks(): void {
  cached = null
}
