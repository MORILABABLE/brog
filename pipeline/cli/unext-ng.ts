/**
 * U-NEXT のアフィリエイトで「扱ってはいけない」作品の一覧を作る。
 *
 *   npm run unext:ng                 3つのNGメニューを全部読んで data/unext-ng.json を更新
 *   npm run unext:ng -- --menu tbs   1つだけ試す（tbs / ntv / fod）
 *   npm run unext:ng -- --pages 5    読むページ数の上限を変える（既定 60・1ページ30件）
 *   npm run unext:ng -- --dry-run    読むだけで書かない
 *
 * ■ なぜ要るのか
 * U-NEXT のガイドライン「掲載NG権利元、作品について」は、
 * TBS作品・日テレ作品・FOD作品の訴求を禁止したうえで、
 * **該当作品を U-NEXT のジャンルメニューのURLで指している。**
 *
 *   TBSオンデマンド  https://video.unext.jp/browse/genre/MNU0000140/MNU0000824
 *   日テレ           https://video.unext.jp/browse/genre/MNU0000140/MNU0000822
 *   FOD              https://video.unext.jp/browse/genre/MNU0000140/MNU0000826
 *
 * つまり**該当作品は機械で読める**。当サイトの記事は自動生成で、
 * 国内ドラマは毎月入ってくる。人が1本ずつ照合するのは続かないので、
 * ここで一覧を作り、サイト側（site/src/lib/unext-ng.ts）が
 * **その作品が載っているページから U-NEXT の広告を外す。**
 *
 * ■ 記事から作品を消すのではない
 * 禁じられているのは「アフィリエイト広告で扱うこと」であって、
 * 配信終了の事実を書くことではない。**記事はそのまま、広告だけを外す。**
 *
 * ■ 相手への負荷
 * 一覧ページだけを読む（作品ページは開かない）。既定の上限は
 * 1メニュー60ページ＝1,800件で、3メニューで最大180遷移。
 * 実際に読むのは一覧の件数ぶんだけ（2026-09-14 実測: 60遷移）。
 * 遷移間隔は theme.yaml の `min_interval_ms`（2.5秒）に従うので、
 * 全部読んでも5分ほど。**頻繁に回すものではない。月1回で足りる。**
 *
 * ■ いつ走らせるか
 *   - U-NEXT と提携する前に1回（提携申請時の点検に使う）
 *   - そのあとは月1回。権利元の入れ替わりは緩やかなので、これで足りる
 *   - ガイドラインが改訂されたら、data/unext-ng.json の手書き部分も一緒に見る
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadTheme } from '../theme.ts'
import { PoliteBrowser } from '../sources/browser.ts'
import { UnextSource, type UnextConfig } from '../sources/unext.ts'

const OUT = resolve('data/unext-ng.json')

/**
 * 1メニューあたり読むページ数の上限（1ページ30件）。
 *
 * ★ **40 では足りなくなった**（2026-09-14）。TBSオンデマンドが1,478件＝50ページになり、
 *   毎回「読み切れていません → `--pages 50`」で止まるようになった。
 *   **上限は「一覧が伸びても届く」側に置くこと。** 足りないと書き込みが中止され、
 *   古い一覧のまま運用が続く（止まるので気づけるが、手間が増えるだけで得が無い）。
 *   読むのは一覧ページだけなので、余裕を持たせても負荷はページ数に比例するだけ。
 */
const DEFAULT_MAX_PAGES = 60

interface NgMenu {
  key: string
  label: string
  genre: string
  category: string
  url?: string
}

interface NgFile {
  menus?: NgMenu[]
  works?: Record<string, string>
  /** メニュー（権利元）別の内訳。Hulu 側が TBS だけを取り出すために使う */
  worksByMenu?: Record<string, Record<string, string>>
  worksFetchedAt?: string
  [key: string]: unknown
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function main(): Promise<void> {
  const dryRun = has('dry-run')

  let file: NgFile
  try {
    file = JSON.parse(readFileSync(OUT, 'utf8')) as NgFile
  } catch (e) {
    throw new Error(
      `${OUT} が読めませんでした。このファイルはガイドラインの書き写しを含むので、` +
        '自動では作り直しません。中身を確認してください。\n' +
        (e instanceof Error ? e.message : String(e)),
    )
  }

  const all = file.menus ?? []
  if (all.length === 0) {
    throw new Error(`${OUT} に menus がありません（掲載NGのジャンルメニュー）。`)
  }

  const only = arg('menu')
  const menus = only ? all.filter((m) => m.key === only) : all
  if (menus.length === 0) {
    throw new Error(`--menu ${only} に一致しません。有効: ${all.map((m) => m.key).join(', ')}`)
  }

  const maxPages = Number(arg('pages') ?? DEFAULT_MAX_PAGES)
  if (!Number.isFinite(maxPages) || maxPages < 1) {
    throw new Error('--pages には1以上の数を指定してください')
  }

  // 収集と同じ設定（遷移間隔）を使う。ここだけ速くしない。
  const theme = await loadTheme()
  if (!theme.unext) throw new Error(`テーマ ${theme.key} に unext の設定がありません`)

  const browser = new PoliteBrowser({
    minIntervalMs: theme.unext.min_interval_ms,
    maxPageViews: menus.length * maxPages + 10,
  })
  const cfg: UnextConfig = { ...theme.unext, genres: [] }
  const source = new UnextSource(cfg, browser)

  console.log(`掲載NGの作品一覧を作ります（${menus.length}メニュー / 各最大${maxPages}ページ）`)
  console.log(`間隔 ${theme.unext.min_interval_ms}ms・作品ページは開きません\n`)

  /** 作品ID → 題名。メニューをまたいで同じ作品が出ることがあるので Map で持つ */
  const works = new Map<string, string>()
  /**
   * メニュー（権利元）別の内訳。**Hulu 側が TBS だけを取り出すために要る。**
   *
   * ■ なぜ分けて持つのか（2026-09-14 追加）
   * 掲載NGの範囲は広告主ごとに違う。
   *
   *   U-NEXT … TBS / 日テレ / FOD ぜんぶNG
   *   Hulu   … **TBS だけNG。日テレはむしろ主力**（Hulu は日本テレビ系）
   *
   * 混ぜたまま Hulu に渡すと、**日テレ作品のページで Hulu の広告が消える。**
   * Hulu にとって最も噛み合うページを自分で潰すことになる
   * （読むのは site/src/lib/hulu-ng.ts の `tbsWorks()`）。
   */
  const byMenu = new Map<string, Map<string, string>>()
  /** 読み切れなかったメニュー。**あるなら一覧は欠けている。** */
  const truncated: { label: string; need: number }[] = []

  try {
    for (const m of menus) {
      const { rows, total, pages } = await source.listCategoryTitles(m.genre, m.category, maxPages)
      const mine = new Map<string, string>()
      for (const r of rows) {
        works.set(r.id, r.title)
        mine.set(r.id, r.title)
      }
      byMenu.set(m.key, mine)
      console.log(`  ${m.label}  ${rows.length}件 / 全${total}件`)
      if (pages > maxPages) {
        truncated.push({ label: m.label, need: pages })
        console.log(`    ※ 全${pages}ページのうち${maxPages}ページまでしか読んでいません。`)
      }
    }
  } finally {
    await browser.close()
  }

  // ★ 欠けたまま書くと、**載っていない作品を「NGではない」と判定する。**
  //   掲載NGの用途では、これが最悪の壊れ方になる。黙って書かない。
  if (truncated.length > 0) {
    const need = Math.max(...truncated.map((t) => t.need))
    console.log('')
    console.log(`読み切れていないメニューがあります: ${truncated.map((t) => t.label).join(' / ')}`)
    console.log(`→ npm run unext:ng -- --pages ${need} で読み直してください。`)
    if (!dryRun) {
      throw new Error('一覧が欠けたままになるため、書き込みを中止しました。')
    }
  }

  console.log('')
  console.log(`合計 ${works.size}件（重複を除く） / ページ遷移 ${source.pageViews}回`)

  if (dryRun) {
    console.log('--dry-run のため何も書きませんでした。')
    return
  }

  // ★ 1件も取れなかったときは書かない。**空で上書きすると判定が全部素通りになる。**
  //   （メニューIDが変わった・相手が形を変えた、のどちらでもこの症状になる）
  if (works.size === 0) {
    throw new Error(
      '1件も取れませんでした。既存の一覧を空で上書きしないため、書き込みを中止します。\n' +
        'メニューIDが変わっていないか、ガイドラインのURLを開いて確かめてください。',
    )
  }

  const before = Object.keys(file.works ?? {}).length

  /*
   * ★ 積み上げない。**メニューから消えた作品はNGでもなくなる**ので、
   *   今回読めたものだけに入れ替える（成果データの台帳とは性質が逆）。
   *
   * ★ ただし**入れ替えるのはメニュー単位**（2026-09-14）。
   *   `--menu tbs` のような部分実行で、読んでいない日テレ・FOD の一覧まで
   *   消してはいけない。消えると**その権利元が素通りになる**＝いちばん悪い壊れ方。
   *   全メニューを読んだときは、この形でも結果は今までと同じになる。
   */
  const sorted = (m: Map<string, string>) =>
    Object.fromEntries([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])))

  const merged: Record<string, Record<string, string>> = { ...(file.worksByMenu ?? {}) }
  for (const [key, m] of byMenu) merged[key] = sorted(m)
  file.worksByMenu = merged

  // `works` は全メニューの合計。**U-NEXT 側はこちらを見る**（3メニューすべてNG）。
  const union = new Map<string, string>()
  for (const m of Object.values(merged)) for (const [id, t] of Object.entries(m)) union.set(id, t)
  file.works = sorted(union)
  file.worksFetchedAt = new Date().toISOString()

  writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  console.log(`${OUT} に書きました（${before}件 → ${Object.keys(file.works).length}件）`)
  console.log(`  内訳: ${Object.entries(merged).map(([k, v]) => `${k} ${Object.keys(v).length}`).join(" / ")}`)
  console.log('')
  console.log('次にやること:')
  console.log('  1. npm run build（site/）でサイトを作り直す')
  console.log('  2. npm run check:ads  … 掲載NG作品のページに広告が出ていないか検査する')
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
