/**
 * U-NEXT の広告を出してはいけないページを見分ける。
 *
 * ■ 何のためにあるか
 * U-NEXT のアフィリエイトガイドライン（2026年9月3日改訂）は、
 * **特定の権利元・特定の作品を「アフィリエイト広告で扱うこと」を禁止している。**
 * 違反すると提携解除と、過去分を含む**成果の全件却下**になる。
 *
 *   TBS作品・TBSオンデマンド / 日テレ作品 / FOD（フジテレビオンデマンド）
 *   HBO・HBO Max / ガイドラインが名指しする37作品
 *
 * 当サイトの記事は自動生成で、収集した作品をそのまま並べる。
 * **人が1本ずつ見て止めることはできない。** だから機械が止める。
 *
 * ■ 止め方は「広告を出さない」。作品を消すのではない
 * 記事は「見放題の配信が終わる」という事実を伝えるものなので、事実は残す。
 * 禁じられているのは**アフィリエイト広告で扱うこと**であって、
 * その作品に触れること自体ではない。よって
 * **該当作品が載っているページからは U-NEXT の広告だけを外す。**
 * Amazon の導線はそのまま残る（Amazonのガイドラインには当たらない）。
 *
 * ■ データの出どころ
 *   data/unext-ng.json  … ガイドライン本文の書き写し（人が手で管理）
 *                          + `npm run unext:ng` が集めた該当作品の一覧
 *
 * ■ 当て方は `ng-match.ts` にある
 * **2026-09-14 に切り出した。** Hulu の掲載NG（`hulu-ng.ts`）が同じ規則で
 * 当たらなければならないため。**正規化や区切りの規則を変えるときは
 * ng-match.ts を直す。このファイルは読むファイルを決めているだけ。**
 *
 * ★ 同じ規則が `pipeline/cli/check-ads.ts` にもある。サイトは独立した
 *   npm プロジェクトで pipeline を読めないため（`search-links.ts` と同じ事情）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildNgIndex, normalize, type NgHit, type NgIndex, type NgSource } from './ng-match'

export type { NgHit }
export { normalize }

interface NgFile extends NgSource {
  guidelineRevision?: string
  worksFetchedAt?: string
  /**
   * メニュー（権利元）ごとの作品一覧。`npm run unext:ng` が書く。
   *
   * ★ **Hulu 側が TBS だけを取り出すために要る**（`hulu-ng.ts`）。
   *   U-NEXT はここを見ない — 3メニューぜんぶが掲載NGなので `works` で足りる。
   */
  worksByMenu?: Record<string, Record<string, string>>
}

/**
 * `data/unext-ng.json` を探す。
 *
 * ★ `import.meta.url` からの相対解決は使えない。Astro はビルド時にこのファイルを
 *   チャンクへバンドルするので、位置がソースと変わる（work-links.ts と同じ事情）。
 */
export function findDataFile(...segments: string[]): string | null {
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

let file: NgFile | null = null

/** `data/unext-ng.json` の中身。**Hulu 側も TBS の一覧のためにこれを読む。** */
export function unextNgFile(): NgFile {
  if (file) return file
  const path = findDataFile('data', 'unext-ng.json')
  if (!path) {
    // 無くてもビルドは通す。**ただし何も止まらない**ので、
    // 広告を出す前に必ずファイルがあることを確かめること（check:ads が見る）。
    file = {}
    return file
  }
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as NgFile
  } catch {
    file = {}
  }
  return file
}

let index: NgIndex | null = null

/**
 * その文章に、U-NEXT の広告と同居させてはいけないものが含まれているか。
 *
 * 記事本文でも、表の作品名を並べた文字列でも、同じように渡してよい。
 * **1件でも返ってきたら、そのページに U-NEXT の広告を出さない。**
 *
 * @param text 記事本文（Markdown のままでよい）や作品名を並べた文字列
 */
export function ngHitsIn(text: string): NgHit[] {
  index ??= buildNgIndex(unextNgFile())
  return index.hitsIn(text)
}

/** テスト・再読込用 */
export function resetUnextNg(): void {
  file = null
  index = null
}
