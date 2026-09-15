/**
 * U-NEXT の**カタログ索引**を作る（`data/unext-catalog/`）。
 *
 *   npm run unext:catalog                    予算のぶんだけ歩いて、続きから再開する
 *   npm run unext:catalog -- --max-pages 60  1回で読むページ数（既定 300）
 *   npm run unext:catalog -- --genre anime   ジャンルを絞る
 *   npm run unext:catalog -- --restart       周回をやり直す（`nextPage` を1に戻す）
 *   npm run unext:catalog -- --status        取得せず、進み具合だけ出す
 *
 * ■ 何のためにあるか
 *
 * 当サイトの U-NEXT 台帳は「新規入荷」と「終了予定」を歩いた**副産物**でしかない。
 * だから [CROSS-SERVICE 3-2](../../docs/CROSS-SERVICE.md) にこう書いてある。
 *
 * > 台帳に無いことは「U-NEXTに無い」を意味しない。「まだ観測していない」だけ。
 *
 * **この2つを区別できるようにする**のがこのコマンド。
 * 各ジャンルの「すべての作品」を端から端まで歩いて、
 * **そこに何があるか**だけの薄い索引を作る（`sources/unext-catalog.ts`）。
 *
 * ■ 規模（2026-09-07 実測）
 *
 *   洋画 11,547 / 邦画 10,875 / アニメ 8,287 / TV番組 7,351 / キッズ 4,483 /
 *   韓流 4,161 / 音楽 4,146 / 国内ドラマ 4,143 / 報道 3,530 / 舞台 3,048 / 海外ドラマ 1,680
 *   ── 合計 63,251件 / 2,114ページ / 1周 約88分（min_interval 2500ms）
 *
 * ■ ★ 1回で歩き切らない
 *
 * 88分を1回で回すのは相手のサーバーに対して乱暴だし、CIの実行時間としても長い。
 * **ジャンルごとに「次に読むページ」を持って、予算のぶんだけ進める。**
 * 既定の300ページなら1回12〜13分で、週2回の収集に乗せて**3〜4週間で1周**する。
 *
 * ■ ★ 歩き終えるまで「歩いた範囲」として使わない
 *
 * 途中の索引を「全部」として扱うと、**歩いていない範囲の不在を「無い」と読む。**
 * それは埋めようとした穴をそのまま作り直すことになる。
 * `_sweeps.json` の `completedAt` が入ったジャンルだけを記事側が読む
 * （`loadCompletedSync()`）。
 *
 * ■ 相手への負荷
 *
 * `min_interval_ms`（theme.yaml・2500ms）を必ず通す。**下げないこと。**
 * 開くのは一覧ページだけで、作品ページは1枚も開かない。
 * 判断の根拠は [SOURCES-UNEXT-HULU 5節](../../docs/SOURCES-UNEXT-HULU.md)。
 */
import { loadTheme } from '../theme.ts'
import { BackoffError, PoliteBrowser } from '../sources/browser.ts'
import { UnextSource, type UnextConfig } from '../sources/unext.ts'
import {
  appendInflight,
  clearInflight,
  dayOf,
  loadGenre,
  loadSweeps,
  readInflight,
  remember,
  saveGenre,
  saveSweeps,
  type CatalogEntry,
  type Sweeps,
} from '../sources/unext-catalog.ts'
import { appendHistory, type StockChange } from '../core/history.ts'
import type { Lineup } from '../sources/unext.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(`--${name}`)

/** 1回の実行で読むページ数の既定。300ページ ≒ 12〜13分。 */
const DEFAULT_MAX_PAGES = 300

/**
 * 索引と周回の進み具合を書き出す間隔（ページ数）。
 *
 * ■ なぜ要るか（2026-09-15 追加）
 * 以前は**ループを抜けたあとに1回だけ**書いていた。途中経過は
 * `appendInflight`（作品IDの控え）だけがページごとに残る形で、
 * **プロセスが途中で殺されると索引も `nextPage` も丸ごと失われる。**
 *
 *   実測（2026-09-10 の実行）:
 *     ジョブが timeout-minutes: 45 で打ち切られ、邦画の約198ページが
 *     `houga.inflight` だけ残して消えた。`houga.jsonl` も
 *     `_sweeps.json` の houga も書かれていない。
 *     次の実行はまた1ページ目から始まり、**同じ結果になるので
 *     git の差分も出ず、コミットも起きない**（無限に同じ所を歩く）。
 *
 * ★ **毎ページは書かない。** `saveGenre` はジャンルのファイル（最大1.5MB）を
 *   丸ごと書き直すので、385ページで385回書くことになる。
 *   20ページごとなら1回の実行で十数回で済み、失っても50秒ぶん。
 */
const SAVE_EVERY_PAGES = 20

async function main(): Promise<void> {
  const theme = await loadTheme()
  if (!theme.unext) throw new Error(`テーマ ${theme.key} に unext の設定がありません`)
  const unext = theme.unext
  const only = arg('genre')
  const genres = unext.genres.filter((g) => !only || g.key === only)
  if (genres.length === 0) {
    console.error(`ジャンル「${only}」は theme.yaml にありません。`)
    process.exitCode = 1
    return
  }

  const sweeps: Sweeps = await loadSweeps()

  if (has('restart')) {
    for (const g of genres) {
      const s = sweeps[g.key]
      if (!s) continue
      s.nextPage = 1
      s.startedAt = new Date().toISOString()
      delete s.completedAt
    }
    await saveSweeps(sweeps)
    console.log(`${genres.length}ジャンルの周回を最初からにしました。`)
    return
  }

  // --- 進み具合 ---
  console.log('ジャンル             索引     相手の申告      進み具合')
  console.log('-'.repeat(64))
  let doneGenres = 0
  let indexed = 0
  for (const g of genres) {
    const s = sweeps[g.key]
    const size = s?.entries ?? 0
    indexed += size
    if (s?.completedAt) doneGenres++
    const at = s ? `${s.nextPage - 1}/${s.pages ?? '?'}ページ` : '未着手'
    const state = s?.completedAt ? '✅ 歩き終えた' : at
    console.log(
      `  ${g.label.padEnd(18)}${String(size).padStart(6)}件 ` +
        `${String(s?.results ?? '?').padStart(8)}件  ${state}`,
    )
  }
  console.log('-'.repeat(64))
  console.log(`  索引 ${indexed}件 / 歩き終えたジャンル ${doneGenres}/${genres.length}`)

  if (has('status')) return

  const maxPages = Number(arg('max-pages') ?? DEFAULT_MAX_PAGES)
  if (!Number.isFinite(maxPages) || maxPages <= 0) {
    console.error('--max-pages は正の数で指定してください。')
    process.exitCode = 1
    return
  }

  /*
   * ★ **途中まで歩いたジャンルを最優先。** 次が未着手、最後が歩き終えたもの。
   *   同じ段の中は、いちばん古い周回から（索引は放っておくと古くなる）。
   *
   * ■ なぜ3段に分けるか（2026-09-15 修正）
   * 以前は「歩き終えたか」の2段しかなく、同じ段の中を `startedAt` の
   * 古い順に並べていた。**未着手のジャンルは `startedAt` が空文字なので、
   * 進行中のジャンルより必ず前に来る。**
   *
   *   実測（2026-09-10 の実行）:
   *     洋画 251/385ページで中断 → 次の実行は未着手の邦画から始まり、
   *     予算250ページを邦画で使い切って洋画に到達しなかった。
   *     未着手のジャンルが9つ残っているので、洋画の続きは**永久に来ない**。
   *
   * ワークフロー（collect-unext.yml）の「ジャンルごとに続きから再開する」は
   * この並び順が前提になっている。**始めた周回を先に終わらせる。**
   */
  function stage(key: string): number {
    const s = sweeps[key]
    if (!s) return 1 // 未着手
    if (s.completedAt) return 2 // 歩き終えた
    return 0 // 進行中（始めたが、まだ終わっていない）
  }
  const queue = [...genres].sort((a, b) => {
    const d = stage(a.key) - stage(b.key)
    if (d !== 0) return d
    return (sweeps[a.key]?.startedAt ?? '').localeCompare(sweeps[b.key]?.startedAt ?? '')
  })

  console.log(`\n予算 ${maxPages}ページ（min_interval ${unext.min_interval_ms}ms）で歩きます。`)

  const browser = new PoliteBrowser({
    minIntervalMs: unext.min_interval_ms,
    maxPageViews: maxPages + 10,
  })
  const cfg: UnextConfig = { ...unext, genres: [] }
  const source = new UnextSource(cfg, browser)

  let spent = 0
  let added = 0
  try {
    for (const g of queue) {
      if (spent >= maxPages) break

      let s = sweeps[g.key]
      if (!s || s.completedAt) {
        // 未着手、または前の周回が終わっている → 新しい周回を始める
        s = {
          label: g.label,
          startedAt: new Date().toISOString(),
          nextPage: 1,
          entries: s?.entries ?? 0,
          pages: s?.pages,
          results: s?.results,
        }
        sweeps[g.key] = s
      }

      const entries = await loadGenre(g.key)
      const before = entries.size
      const hadBaseline = Boolean(s.completedAt) || before > 0
      // この周回で見かけた作品。実行をまたぐので控えを読み直す
      const seen = await readInflight(g.key)
      console.log(`
[${g.label}] ${s.nextPage}ページ目から`)

      let hitEnd = false
      let sinceSave = 0
      /*
       * 索引と周回の進み具合を書き出す。**途中でも呼べる。**
       * `saveGenre` はジャンルのファイルを丸ごと書き直すので毎ページは呼ばない。
       */
      const persist = async (): Promise<void> => {
        s.entries = entries.size
        await saveGenre(g.key, entries)
        await saveSweeps(sweeps)
        sinceSave = 0
      }
      try {
        while (spent < maxPages) {
          const seenOn = dayOf(new Date().toISOString())
          const { works, pages, results } = await source.listWorksPage(g, s.nextPage)
          spent++
          if (pages) s.pages = pages
          if (results) s.results = results

          for (const w of works) {
            const e: Omit<CatalogEntry, 'firstSeenAt' | 'lastSeenAt'> = {
              id: w.id,
              title: w.title,
              lineup: w.meta.lineup as Lineup,
            }
            if (w.rating != null) e.rating = w.rating
            if (w.year != null) e.year = w.year
            remember(entries, e, seenOn)
            seen.add(w.id)
          }
          await appendInflight(g.key, works.map((w) => w.id))

          // 空ページ、または最後まで来た
          if (works.length === 0 || (s.pages && s.nextPage >= s.pages)) {
            hitEnd = true
            break
          }
          s.nextPage++
          if (++sinceSave >= SAVE_EVERY_PAGES) await persist()
        }
      } finally {
        await persist()
      }

      if (hitEnd) {
        /*
         * 歩き終えた。**この周回で見かけなかった作品＝歩いた範囲から消えた作品。**
         *
         * ★ **最初の周回では履歴に積まない。** 比べる相手（前の周回の索引）が
         *   無いので、全件が入れ替わりに見えてしまう。
         *   在庫の履歴と同じ規律（`core/history.ts`「初観測は積まない」）。
         *
         * ★ **「U-NEXTから消えた」とは書かない。** 歩いたのはこのジャンルの
         *   「すべての作品」であって、カタログ全体ではない。
         *   別ジャンルへ移っただけの可能性がある（`via` に範囲を残す）。
         */
        const day = dayOf(new Date().toISOString())
        const gone: string[] = []
        for (const [id, e] of entries) {
          if (seen.has(id)) continue
          if (e.lastSeenAt) continue // すでに消えた印がある＝前の周回でも見ていない
          e.lastSeenAt = day
          gone.push(id)
        }

        const history: StockChange[] = []
        if (hadBaseline) {
          const via = `unext:catalog ${g.key}（すべての作品を1周）`
          for (const id of gone) {
            const e = entries.get(id)!
            history.push({
              observedAt: new Date().toISOString(),
              service: 'u-next',
              workId: id,
              title: e.title,
              field: 'subscription',
              from: e.lineup === 'point' ? 'ポイント' : '見放題',
              via,
            })
          }
        }

        await saveGenre(g.key, entries)
        await appendHistory(history, theme.utc_offset_minutes)
        await clearInflight(g.key)
        s.nextPage = 1
        s.completedAt = new Date().toISOString()
        s.entries = entries.size
        await saveSweeps(sweeps)

        if (gone.length > 0) {
          console.log(
            `  歩いた範囲から消えた作品 ${gone.length}件` +
              (hadBaseline ? '（履歴に積みました）' : '（初回の周回なので履歴には積みません）'),
          )
        }
      }

      added += entries.size - before
      console.log(
        `  索引 ${before} → ${entries.size}件（+${entries.size - before}）` +
          `${hitEnd ? ' ✅ 歩き終えました' : `  次は ${s.nextPage}ページ目`}`,
      )
    }
  } catch (err) {
    // 相手が止めろと言っているなら、そこまでの成果を残して終わる。
    // 途中まで書けているので、次回は続きから再開できる。
    if (err instanceof BackoffError) {
      console.warn('\n相手から待つように言われたので中断しました。次回は続きから始めます。')
    } else {
      throw err
    }
  } finally {
    await browser.close()
  }

  console.log(`\n読んだページ ${spent} / 索引に増えた作品 ${added}件`)
  console.log('進み具合:  npm run unext:catalog -- --status')
}

main().catch((e) => {
  console.error(String(e))
  process.exitCode = 1
})
