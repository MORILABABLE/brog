/**
 * 収集した変化の保存と、既出管理（台帳）。
 *
 * ■ なぜ台帳が要るか
 * この手の自動ブログが最初に壊れるのは「同じ作品を何度も記事にする」事故。
 * API は同じ変化を複数回返すことがあるし、実行タイミングによって期間も重なる。
 * 一度記事にした (サービス, 変化種別, 作品ID) は二度と拾わない。
 */
import { mkdir, readdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ChangeEvent } from '../sources/types.ts'
import { currentYearMonth } from './datetime.ts'

export const EVENT_DIR = join('data', 'events')
export const LEDGER_PATH = join('data', 'ledger.json')

export interface Ledger {
  /** 記事化済み・収集済みの変化キー */
  seen: string[]
  /** ランキング記事で消化済みのお題 */
  usedRankingThemes: string[]
  updatedAt: string
}

const EMPTY_LEDGER: Ledger = { seen: [], usedRankingThemes: [], updatedAt: '' }

/** 変化の一意キー */
export function eventKey(e: ChangeEvent): string {
  return `${e.service}:${e.kind}:${e.work.id}`
}

export async function loadLedger(): Promise<Ledger> {
  try {
    const raw = await readFile(LEDGER_PATH, 'utf8')
    return { ...EMPTY_LEDGER, ...(JSON.parse(raw) as Partial<Ledger>) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_LEDGER }
    throw err
  }
}

export async function saveLedger(ledger: Ledger): Promise<void> {
  await mkdir(dirname(LEDGER_PATH), { recursive: true })
  const body = JSON.stringify(
    {
      ...ledger,
      // ソートしておくと git の差分が追加行だけになる
      seen: [...ledger.seen].sort(),
      usedRankingThemes: [...ledger.usedRankingThemes].sort(),
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  )
  await writeFile(LEDGER_PATH, body + '\n', 'utf8')
}

/** 台帳にある変化を除外する */
export function dedupe(events: ChangeEvent[], ledger: Ledger): ChangeEvent[] {
  const seen = new Set(ledger.seen)
  const out: ChangeEvent[] = []
  // 同一実行内の重複も潰す
  const local = new Set<string>()

  for (const e of events) {
    const key = eventKey(e)
    if (seen.has(key) || local.has(key)) continue
    local.add(key)
    out.push(e)
  }
  return out
}

/**
 * 変化を月別の JSONL に追記する。記事生成はこのログを読む。
 *
 * 月の区切りはサイトの基準タイムゾーンで判定する。
 * UTC基準だと、収集が 04:00 JST（＝前日 19:00 UTC）に走るため、
 * 月初の実行が前月のファイルに書き込まれてしまう。
 */
export async function appendEvents(
  events: ChangeEvent[],
  offsetMinutes: number,
): Promise<void> {
  if (events.length === 0) return
  const path = join(EVENT_DIR, `${currentYearMonth(offsetMinutes)}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
}

/**
 * ひらがな・カタカナ。**日本語にしか無い文字**なので、原語表記が日本語かの判定に使う。
 */
const KANA = /[ぁ-んァ-ヶ]/

/**
 * 邦題が取れていない作品に、配信APIの原語表記を充てる。
 *
 * ■ なぜ要るか（2026-09-01 追加）
 * 邦題は Wikidata から引いているが、**新しい作品ほど項目がまだ無い。**
 * 実際に「機動戦士ガンダム　閃光のハサウェイ キルケーの魔女」が
 * `MOBILE SUIT GUNDAM HATHAWAY The Sorcery of Nymph Circe` のまま素材に並んだ。
 * 日本語のサイトに英題が出るのは、読者から見れば取りこぼしと変わらない。
 *
 * 配信APIの `originalTitle` は**日本の作品なら日本語表記のまま返る**
 * （`sources/types.ts` の Work.originalTitle）。推測なしで直せる。
 *
 * ■ かなを含むものだけに限る
 * 原語表記は「原語」であって日本語とは限らない。ハングルやアラビア文字は
 * 弾けるが、**漢字だけの題は中国語と区別がつかない**（実測: 早春晴朗）。
 * ひらがな・カタカナは日本語にしか無いので、そこだけを条件にする。
 * 漢字だけの邦題は取りこぼすが、**別の言語を邦題として出すよりよい。**
 *
 * ■ 収集ログは書き換えない
 * やるのは読み込み時の補完だけ。`data/events/*.jsonl` は追記のみで、
 * 過去の行は書き換えない（このファイル冒頭の決まり）。
 * **同じ規則がサイト側にもある**（`site/src/lib/events-data.ts` の readAll）。
 * 片方だけ変えると、記事とサイトで題名が食い違う。
 */
function withJapaneseTitle(e: ChangeEvent): ChangeEvent {
  if (!e.work.localizedTitle && e.work.originalTitle && KANA.test(e.work.originalTitle)) {
    // ★ 連続した半角スペースは1つに詰める。
    //   実測で「機動戦士ガンダム␣␣閃光のハサウェイ」のように2つ入って返る。
    //   取りこぼしの判定（`core/coverage.ts` の mentionsByTitle と `verify.ts`）は
    //   本文に題名がそのまま出ているかを見るので、書き手が普通に1つで書いた時点で
    //   **載っているのに「載っていない」と判定される。**
    //   全角スペースは題名の一部として使われることがあるので触らない。
    e.work.localizedTitle = e.work.originalTitle.replace(/ {2,}/g, ' ').trim()
  }
  return e
}

/** 指定月のイベントを読み込む（記事生成用） */
export async function readEvents(yearMonth: string): Promise<ChangeEvent[]> {
  const path = join(EVENT_DIR, `${yearMonth}.jsonl`)
  try {
    const raw = await readFile(path, 'utf8')
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => withJapaneseTitle(JSON.parse(l) as ChangeEvent))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * 収集済みの全イベントを読み込む。
 *
 * ■ なぜ「当月ぶん」ではなく全部読むか
 * JSONL のファイル名は**収集した月**であって、変化が起きる月ではない。
 * 8月に収集した「9月30日終了」は 2026-08.jsonl に入る。
 * 当月のファイルだけを読むと、
 *   - 前月に収集した今月の終了作品を取りこぼす
 *   - 翌月の記事を今月のうちに書けない
 * という取りこぼしが起きる。どの月を記事にするかの判定は記事タイプ側の
 * select() が行うので、ここでは絞り込まずに全部渡す。
 *
 * 同じ変化が複数ファイルに入ることはない（収集時に台帳で重複を落としている）。
 */
export async function readAllEvents(): Promise<ChangeEvent[]> {
  let files: string[]
  try {
    files = (await readdir(EVENT_DIR)).filter((f) => f.endsWith('.jsonl')).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const out: ChangeEvent[] = []
  for (const f of files) out.push(...(await readEvents(f.replace(/\.jsonl$/, ''))))
  return out
}
