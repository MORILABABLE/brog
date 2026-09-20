/**
 * 取り込み済みの告知のうち、**作品を特定できなかったもの**を引き直す。
 *
 *   npm run announce:recheck                  引き直せるものを引き直す
 *   npm run announce:recheck -- --dry-run     何が変わるかだけ見る（書き換えない）
 *   npm run announce:recheck -- --max-lookups 20  APIを使う上限（既定 8）
 *   npm run announce:recheck -- --all         古さ（30日）を無視して全部引き直す
 *
 * ■ なぜ要るか — **引き直しが1度も動いていなかった**（2026-09-20 に発見）
 * `pipeline/sources/announced-works.ts` には「特定できなかった作品は30日後に引き直す」
 * という仕組み（`RECHECK_DAYS`）がある。告知は**配信が始まる前**の情報なので、
 * その時点では Wikidata に項目が無く、あとからできることがあるため。
 *
 * ところがその判定を持つ `resolveAnnouncedWorks` を呼んでいるのは
 * `collect:announce` の**1か所だけ**で、渡しているのは `fresh`
 * （＝台帳にまだ無い告知）**だけ**だった。一度取り込んだ告知は
 * 二度と `fresh` にならないので、**30日の引き直しは構造上いちども発火しない。**
 * `RECHECK_DAYS` は事実上の死にコードだった。
 *
 * `backfill:images` は**強いIDでしか突き合わせない**ので、imdbId が空のままの作品は
 * 配信が始まっても永久に埋まらない。その唯一の出口がここだった。
 *
 * ■ 効き目は**小さい。見込みを大きく書かないこと**（2026-09-20 実測）
 * 実際に流すと、対象70件のうち**新たに特定できたのは1件だけ**だった（Netflix「ダン!」）。
 * 残り69件は引き直しても当たらない — **Wikidata にその項目自体が無い。**
 * 告知に並ぶのは韓国・中国ドラマ、バラエティ、配信独占の新作アニメが多く、
 * このあたりは日本語ラベルの項目が作られていないことがふつうにある。
 * 例: 「チェンソーマン レゼ篇」は Wikidata を検索しても1件も出ない（2026-09-20 に確認）。
 *
 * つまり `data/UPCOMING.md` の「画像なし 47件」の大半は、**この死にコードのせいではない。**
 * それでもこのコマンドを置くのは、**項目はあとから作られる**ため。
 * いま無いものが来月には出来ている、という拾い方をする仕組みは、これしか無い。
 * ★ **画像が一気に増える見込みで運用の判断をしないこと。** 増えるとしても数件ずつ。
 *
 * ■ APIの使い方 — **まず無料の経路で埋める**
 * 無料枠は 500リクエスト/月で、定期収集がすでに月250前後を使う。だからこの引き直しは
 *
 *   ① Wikidata で邦題 → imdbId    **無料。件数の上限を置かない**
 *   ② ①で分かった imdbId を**イベントログに書き戻す**   無料
 *   ③ 作品の詳細を配信APIで引く    1件1リクエスト。`--max-lookups`（既定8）で頭打ち
 *
 * の順で動く。②まで済めば、あとは `backfill:images` が
 * **すでに収集済みの配信APIのデータ**から画像を拾える（APIを1件も使わない）。
 * ③は「配信APIのカタログにあるが、まだ `new` として収集していない」作品のための保険。
 *
 * ★ **このコマンドのあとに `backfill:images` を走らせること**（.github/workflows/announce.yml）。
 *   ②で入った imdbId が効くのはそちら側。
 *
 * ■ 何を書き換えるか
 * イベントログ（`data/events/*.jsonl`）の `work` に、
 * `meta.imdbId` と、③まで進めたときは画像・年・評価などを入れる。
 * **題名・日付・告知由来の `meta` は触らない**（`backfill:images` と同じ決まり）。
 * 告知が一次情報である部分を、後から来た値で上書きしない。
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadTheme } from '../theme.ts'
import { StreamingAvailabilitySource } from '../sources/streaming-availability.ts'
import {
  announcedWorkKey,
  loadAnnouncedWorks,
  loadPins,
  resolveAnnouncedWorks,
  saveAnnouncedWorks,
} from '../sources/announced-works.ts'
import { EVENT_DIR } from '../core/events.ts'
import { addUsage, warnIfLow } from '../core/api-usage.ts'
import type { ChangeEvent } from '../sources/types.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かず、環境変数を直接渡す
}

const flag = (name: string) => process.argv.includes(`--${name}`)
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/**
 * 配信APIを叩く上限（既定）。**`collect:announce` の既定60より意図的にずっと小さい。**
 * あちらは「月に一度、新しい告知が出た日」に使う枠だが、こちらは**毎日走る**ので、
 * 同じ数字を置くと無料枠（500/月）を引き直しだけで使い切る。
 */
const DEFAULT_MAX_LOOKUPS = 8

/**
 * 引き直す対象にする期間。**開始日がこれより古い告知は、もう引き直さない。**
 *
 * サイトが告知を表に出すのは開始日から60日のあいだ
 * （site/src/lib/events-data.ts の `ARRIVALS_WINDOW_DAYS`）。
 * そこを過ぎた作品の画像を探しても、出る場所がもう無い。
 * ★ 未来の告知は日付がどれだけ先でも対象にする（これから表に出るため）。
 */
const LOOKBACK_DAYS = 60

async function main(): Promise<void> {
  const dryRun = flag('dry-run')
  const all = flag('all')
  const maxLookups = Number(arg('max-lookups') ?? DEFAULT_MAX_LOOKUPS)
  const theme = await loadTheme()

  let files: string[]
  try {
    files = (await readdir(EVENT_DIR)).filter((f) => f.endsWith('.jsonl')).sort()
  } catch {
    console.log('収集済みのイベントがありません。先に npm run collect:announce を実行してください。')
    return
  }

  // ファイルごとに行を保持する（書き戻すため）。backfill:images と同じ形
  const byFile = new Map<string, ChangeEvent[]>()
  for (const f of files) {
    const raw = await readFile(join(EVENT_DIR, f), 'utf8')
    byFile.set(
      f,
      raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ChangeEvent),
    )
  }

  /*
   * 引き直す対象を選ぶ。
   *   ・告知から取り込んだ配信開始予定（`kind: upcoming` かつ `meta.source === 'announcement'`）
   *   ・まだ imdbId が入っていない（入っていれば backfill:images が拾える）
   *   ・開始日が LOOKBACK_DAYS より古くない（もう表に出ない作品を探さない）
   *
   * ★ 「30日たったか」の判定は `resolveAnnouncedWorks` の側が持っている。
   *   ここで二重に持たない（**規則が2か所に割れる**）。ここは範囲を絞るだけ。
   */
  const since = Date.now() - LOOKBACK_DAYS * 86_400_000
  const fileOf = new Map<ChangeEvent, string>()
  const targets: ChangeEvent[] = []
  for (const [file, events] of byFile) {
    for (const e of events) {
      if (e.kind !== 'upcoming' || e.work.meta?.source !== 'announcement') continue
      if (e.work.meta?.imdbId) continue
      if (e.at && Date.parse(e.at) < since) continue
      fileOf.set(e, file)
      targets.push(e)
    }
  }

  console.log(`テーマ: ${theme.label} (${theme.key})`)
  console.log(`引き直しの対象: ${targets.length}件（作品を特定できていない告知・直近${LOOKBACK_DAYS}日ぶん）`)
  if (targets.length === 0) {
    console.log('引き直すものはありません。')
    return
  }

  if (!process.env.STREAMING_API_KEY) {
    console.log('STREAMING_API_KEY が無いので引き直しません。')
    return
  }

  const source = new StreamingAvailabilitySource(process.env.STREAMING_API_KEY, theme)
  const store = await loadAnnouncedWorks()
  const pins = await loadPins()

  /*
   * ★ `--all` は記録ごと消して引き直す。`resolveAnnouncedWorks` は
   *   「記録があって、まだ新しい」ものを問い合わせから外すので、
   *   30日を待たずに試したいときはここで記録を落とす。
   */
  if (all) {
    for (const e of targets) delete store.works[announcedWorkKey(e)]
    console.log('※ --all: 30日の古さを無視して全件を引き直します')
  }

  const before = new Map(targets.map((e) => [e, JSON.stringify(e.work)]))

  try {
    const res = await resolveAnnouncedWorks(targets, {
      source,
      lang: theme.site_language,
      store,
      pins,
      maxLookups,
      log: (m) => console.log(m),
    })

    /*
     * ★ **Wikidata で分かった imdbId を、APIを叩けていない作品にも書き戻す。**
     *   `resolveAnnouncedWorks` が `work.meta.imdbId` を入れるのは
     *   配信APIを引けたときだけ（＝ `--max-lookups` の枠内に入ったときだけ）。
     *   だが imdbId が分かってさえいれば、`backfill:images` が
     *   **すでに収集済みの配信APIのデータ**から画像を拾える（APIを1件も使わない）。
     *   枠に入らなかったぶんをここで取りこぼすと、また30日待つことになる。
     */
    let idsWritten = 0
    for (const e of targets) {
      if (e.work.meta.imdbId) continue
      const title = e.work.localizedTitle ?? e.work.title
      const imdbId = pins[title] ?? store.works[announcedWorkKey(e)]?.imdbId
      if (!imdbId) continue
      e.work.meta.imdbId = imdbId
      idsWritten++
    }

    console.log(
      `\n作品を特定: ${idsWritten + res.resolved}件  うち画像まで取得 ${res.resolved}件\n` +
        `絞れず ${res.ambiguous.length}件  Wikidataに無し ${res.missing.length}件  ` +
        `APIリクエスト ${res.lookups}回`,
    )
    if (res.ambiguous.length) {
      console.log(
        '\n同名の作品が複数あり、決められませんでした。' +
          'data/announcement-pins.json に書けば次回から使われます:',
      )
      for (const a of res.ambiguous.slice(0, 20)) {
        const cands = a.candidates
          .map((c) => `${c.imdbId}${c.year ? `(${c.year})` : ''}${c.type ? ` ${c.type}` : ''}`)
          .join(' / ')
        console.log(`  "${a.title}": ""   ← 候補: ${cands}`)
      }
    }
  } finally {
    /*
     * ★ 枠の記録は**1件でも叩いたときだけ**。Wikidata だけで終わった日
     *   （＝ふつうの日）に書くと、消費0の更新で data/api-usage.json が毎日汚れる。
     */
    if (source.requestCount > 0) {
      const usage = await addUsage(source.requestCount, theme.utc_offset_minutes)
      console.log(`${usage.month} の消費 ${usage.used}/${usage.limit}`)
      warnIfLow(usage)
    }
  }

  /*
   * ★ **記録は、何も変わらなかった日でも必ず保存する。**
   *   保存するのは `checkedAt`（＝いつ引き直したか）で、これを書かないと
   *   `RECHECK_DAYS` の30日がいつまでも経過せず、**毎日 Wikidata に同じ90件を聞き続ける。**
   *   直そうとしている死にコードと、鏡写しの失敗になる。
   */
  if (!dryRun) await saveAnnouncedWorks(store)

  // --- 書き戻し -------------------------------------------------------------
  const dirty = new Set<string>()
  const changed: string[] = []
  for (const e of targets) {
    if (JSON.stringify(e.work) === before.get(e)) continue
    dirty.add(fileOf.get(e)!)
    changed.push(
      `  ${e.service}  ${e.work.localizedTitle ?? e.work.title}` +
        `（${e.work.meta.imdbId ?? '?'}${e.work.posterUrl ? ' / 画像あり' : ''}）`,
    )
  }
  for (const line of changed) console.log(line)

  if (changed.length === 0) {
    console.log('\n変わったものはありません。Wikidata に項目が増えれば次回また試します。')
    return
  }
  if (dryRun) {
    console.log(`\n--dry-run のため書き換えていません（${changed.length}件が変わります）。`)
    return
  }

  for (const file of dirty) {
    const events = byFile.get(file)!
    await writeFile(
      join(EVENT_DIR, file),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    )
  }
  console.log(`\n${changed.length}件を書き換えました（${dirty.size}ファイル）。`)
  console.log('画像はこのあとの npm run backfill:images が入れます。')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
