/**
 * 需要の観測を貯める。`data/demand/YYYY-MM.jsonl`。
 *
 * ■ なぜ貯めるのか
 * その日の候補を出すだけなら貯める必要はない。貯めるのは**あとから測るため**。
 *
 *   - 話題はどれくらい続くか（1日で消えるのか、2週間残るのか）
 *   - 話題が立ってから見放題が終わるまで、どれくらいあるか
 *   - 去年の同じ時期に何が話題だったか（季節ものの先回り）
 *
 * どれも docs/KEYWORDS.md 案2『観測レポート』が待っている素材と同じ性質で、
 * **1日ぶんでは何も言えず、半年貯めると言えるようになる。**
 *
 * ■ 取得元で貯め方を変えてある（**ここが設計の要点**）
 *
 * | 取得元 | 貯めるもの | なぜ |
 * |---|---|---|
 * | Google トレンド | **全行** | 過去日を取り直す口が無い。取り逃すと戻せない。1日10語で安い |
 * | Wikipedia | **在庫に当たった語だけ** | 何年前の日付でも同じAPIで返る。1日1000行を抱えると月3.6MBになる |
 *
 * ★ **Wikipedia の999件を捨てているように見えるが、捨てていない。**
 *   必要になったら同じ日付を投げ直せばよい。
 *   「復元できるものは貯めない」という判断で、`data/events` とは逆
 *   （あちらは配信APIが過去を返さないので、観測した瞬間に貯めるしかない）。
 *
 * ■ 同じ日・同じ語は1行
 * 1日に2回実行しても行は増えない。数字が動いていたら**大きいほうを残す**
 * （その日のピークを持つほうが、あとで「どれくらい話題だったか」を測れる）。
 */
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DemandSignal } from '../sources/demand/types.ts'

export const DEMAND_DIR = join('data', 'demand')

/** 同じ観測かどうかの判定キー。取得元 × 日 × 語 */
export function signalKey(s: DemandSignal): string {
  return `${s.source}\t${s.day}\t${s.word}`
}

function monthOf(day: string): string {
  return day.slice(0, 7)
}

/** 1か月ぶん読む。無ければ空配列 */
export async function readDemandMonth(yearMonth: string): Promise<DemandSignal[]> {
  try {
    const raw = await readFile(join(DEMAND_DIR, `${yearMonth}.jsonl`), 'utf8')
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as DemandSignal)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/** 貯めてあるぶんを全部読む */
export async function readAllDemand(): Promise<DemandSignal[]> {
  let files: string[]
  try {
    files = (await readdir(DEMAND_DIR)).filter((f) => f.endsWith('.jsonl')).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: DemandSignal[] = []
  for (const f of files) out.push(...(await readDemandMonth(f.replace(/\.jsonl$/, ''))))
  return out
}

export interface SaveResult {
  /** 新しく書いた行数 */
  added: number
  /** 同じ日・同じ語で、数字が大きくなったので書き直した行数 */
  updated: number
  /** 既にあって変わらなかった行数 */
  skipped: number
}

/**
 * 貯める。**同じ日・同じ語は1行**に畳む。
 *
 * ★ 月をまたぐ観測が混ざっても構わない（日付で振り分ける）。
 *   `--days 7` を月初に実行すると必ずまたぐ。
 */
export async function saveDemand(signals: DemandSignal[]): Promise<SaveResult> {
  const result: SaveResult = { added: 0, updated: 0, skipped: 0 }
  if (signals.length === 0) return result

  await mkdir(DEMAND_DIR, { recursive: true })

  // 月ごとに分けてから、その月のファイルだけを読む
  const byMonth = new Map<string, DemandSignal[]>()
  for (const s of signals) {
    const list = byMonth.get(monthOf(s.day))
    if (list) list.push(s)
    else byMonth.set(monthOf(s.day), [s])
  }

  for (const [month, rows] of byMonth) {
    const existing = await readDemandMonth(month)
    const index = new Map(existing.map((s) => [signalKey(s), s]))

    let rewrite = false
    const appended: DemandSignal[] = []

    for (const s of rows) {
      const key = signalKey(s)
      const prev = index.get(key)
      if (!prev) {
        index.set(key, s)
        appended.push(s)
        result.added += 1
      } else if (s.count > prev.count) {
        // その日のピークを残す。行を書き換えるのでファイルごと作り直す
        index.set(key, s)
        rewrite = true
        result.updated += 1
      } else {
        result.skipped += 1
      }
    }

    const path = join(DEMAND_DIR, `${month}.jsonl`)
    if (rewrite) {
      const all = [...index.values()].sort(
        (a, b) => a.day.localeCompare(b.day) || (a.rank ?? 0) - (b.rank ?? 0),
      )
      await writeFile(path, all.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
    } else if (appended.length > 0) {
      await appendFile(path, appended.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
    }
  }

  return result
}
