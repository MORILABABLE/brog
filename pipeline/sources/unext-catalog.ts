/**
 * U-NEXT の**カタログ索引**（`data/unext-catalog/<ジャンル>.jsonl`）。
 *
 * ■ 既存の2つと何が違うか。**3つとも役割が別。混ぜない。**
 *
 *   data/events/*.jsonl        変化のログ。追記のみ。**記事の素材**
 *   data/history/*.jsonl       状態が動いたことの記録。追記のみ。**時間の資産**
 *   data/unext-titles.json     作品ページまで開いた**濃い**台帳。日付を持つ。上書き
 *   data/unext-catalog/*.jsonl **薄い索引。「そこに何があるか」だけ**。← これ
 *
 * ■ なぜ薄い索引を別に持つのか
 *
 * `unext-titles.json` は1件あたり約500バイトある（日付・話数・原文の終了日表記…）。
 * カタログ全体は **63,251件**（2026-09-07 実測）なので、同じ形で持つと
 * **30MBを超える JSON を毎回コミットする**ことになる。
 *
 * いっぽう、カタログ索引に要るのは
 * **「その作品が U-NEXT にあるか」「見放題か」** の2つだけ。
 * 一覧ページから取れる範囲（日付は取れない）に絞れば1件100バイト前後で収まる。
 *
 * ■ 何が埋まるのか（これがいちばんの目的）
 *
 * [CROSS-SERVICE 3-2](../../docs/CROSS-SERVICE.md) の穴。
 *
 * > 台帳に無いことは「U-NEXTに無い」を意味しない。「まだ観測していない」だけ。
 *
 * 索引が全ジャンルぶん揃うと、**この2つを初めて区別できる。**
 * 「歩いた範囲に無い」と言えるようになるので、
 * 横断表示の U-NEXT 欄が**偽の不在**にならない。
 *
 * ■ ★ 絶対に守ること — **歩き終えたかどうかを必ず持つ**
 *
 * 索引は1回の実行では作れない（2,114ページ・約88分）。途中まで歩いた索引を
 * 「全部」として扱うと、**歩いていない範囲の不在を「無い」と読む**ことになり、
 * 埋めようとした穴をそのまま作り直す。
 *
 * `data/unext-catalog/_sweeps.json` にジャンルごとの周回の状態を持ち、
 * **`completedAt` があるジャンルだけ**「歩いた範囲」として扱う。
 */
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Lineup } from './unext.ts'

export const CATALOG_DIR = join('data', 'unext-catalog')
export const SWEEPS_PATH = join(CATALOG_DIR, '_sweeps.json')

/**
 * 索引の1件。**一覧ページから取れるものだけ。**
 *
 * ★ 日付を持たない。一覧に出てこないため（作品ページを開けば取れるが、
 *   63,251件ぶん開くのは負荷の面で論外）。日付が要る作品は
 *   `unext-titles.json` 側（`unext:refresh`）が受け持つ。
 */
export interface CatalogEntry {
  id: string
  title: string
  /** `svod`（見放題）/ `point`（ポイント）/ `both` / `unknown` */
  lineup: Lineup
  year?: number
  /** 100点満点。一覧の `rate` 由来 */
  rating?: number
  /** 最初に索引で見かけた日（`YYYY-MM-DD`） */
  firstSeenAt: string
  /**
   * **いまの周回で見かけなかったとき**だけ入る。最後に見かけた日（`YYYY-MM-DD`）。
   *
   * ■ なぜ「見かけたとき」ではなく「見かけなかったとき」に書くのか
   *
   * 逆にすると、**周回のたびに全行が書き換わる。**
   * 索引は63,251件・約12MBあるので、月1回の周回でも
   * git の履歴が年間100MB単位で膨らむ。
   *
   * 見かけた作品は「最後の周回まであった」という意味になるので、
   * 日付は行ではなく `_sweeps.json` の `completedAt` が持てばよい。
   * **こうすると、変わっていない作品の行は1バイトも動かない。**
   *
   * ★ この欄がある ＝ **歩いた範囲から消えた作品**。
   *   「U-NEXTから無くなった」とは限らない（別ジャンルに移った可能性がある）。
   */
  lastSeenAt?: string
}

/** ジャンル1つぶんの周回の状態。 */
export interface SweepState {
  /** 表示用 */
  label: string
  /** この周回を始めた時刻 */
  startedAt: string
  /** **歩き終えた時刻。これがあるジャンルだけ「歩いた範囲」として扱う** */
  completedAt?: string
  /** 次に読むページ。途中で予算が尽きたらここから再開する */
  nextPage: number
  /** 相手が申告している総ページ数・総件数（最後に見た値） */
  pages?: number
  results?: number
  /** 索引に入っている件数 */
  entries: number
}

export type Sweeps = Record<string, SweepState>

export async function loadSweeps(): Promise<Sweeps> {
  try {
    return JSON.parse(await readFile(SWEEPS_PATH, 'utf8')) as Sweeps
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

export async function saveSweeps(sweeps: Sweeps): Promise<void> {
  await mkdir(CATALOG_DIR, { recursive: true })
  const sorted: Sweeps = {}
  for (const k of Object.keys(sweeps).sort()) sorted[k] = sweeps[k]!
  await writeFile(SWEEPS_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf8')
}

function genrePath(genreKey: string): string {
  return join(CATALOG_DIR, `${genreKey}.jsonl`)
}

/** ジャンル1つぶんの索引を読む。無ければ空。 */
export async function loadGenre(genreKey: string): Promise<Map<string, CatalogEntry>> {
  const out = new Map<string, CatalogEntry>()
  let raw: string
  try {
    raw = await readFile(genrePath(genreKey), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out
    throw err
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const e = JSON.parse(line) as CatalogEntry
    out.set(e.id, e)
  }
  return out
}

/**
 * ジャンル1つぶんの索引を書く。
 *
 * ★ **IDの順に並べる。** git の差分を「変わった行だけ」にするため。
 *   並びが安定していれば、行の入れ替わりが差分に出ない。
 *   `lastSeenAt` を「見かけなかったときだけ」書く決まりと合わせて、
 *   **中身が変わっていない作品の行は1バイトも動かない。**
 */
export async function saveGenre(
  genreKey: string,
  entries: Map<string, CatalogEntry>,
): Promise<void> {
  await mkdir(CATALOG_DIR, { recursive: true })
  const lines = [...entries.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => JSON.stringify(e))
  await writeFile(genrePath(genreKey), lines.join('\n') + '\n', 'utf8')
}

/**
 * 1件を索引に入れる。既にあれば `firstSeenAt` を保つ。
 *
 * ★ **`lastSeenAt` は消す。** いま見かけたのだから「消えた印」は要らない
 *   （戻ってきた作品の印を残したままにしない）。
 */
export function remember(
  entries: Map<string, CatalogEntry>,
  e: Omit<CatalogEntry, 'firstSeenAt' | 'lastSeenAt'>,
  seenOn: string,
): void {
  const prev = entries.get(e.id)
  const next: CatalogEntry = {
    ...prev,
    ...e,
    firstSeenAt: prev?.firstSeenAt ?? seenOn,
  }
  delete next.lastSeenAt
  entries.set(e.id, next)
}

/** `2026-09-07` の形。索引に秒までの精度は要らない（差分を無駄に動かさない）。 */
export function dayOf(iso: string): string {
  return iso.slice(0, 10)
}

/**
 * 周回の途中で「もう見た作品」を控えておくファイル。
 *
 * ■ なぜ要るか
 * 1ジャンルが1回の実行で歩き切らないことがある（洋画は385ページ、予算は300）。
 * **消えた作品を出すには「この周回で見かけた全部」が要る**ので、
 * 実行をまたいで持ち越す必要がある。
 *
 * ★ 歩き終えたら消す。**残っていると次の周回の判定を汚す。**
 */
export function inflightPath(genreKey: string): string {
  return join(CATALOG_DIR, `${genreKey}.inflight`)
}

export async function readInflight(genreKey: string): Promise<Set<string>> {
  try {
    const raw = await readFile(inflightPath(genreKey), 'utf8')
    return new Set(raw.split('\n').filter((l) => l.trim()))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw err
  }
}

export async function appendInflight(genreKey: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await mkdir(CATALOG_DIR, { recursive: true })
  await appendFile(inflightPath(genreKey), ids.join('\n') + '\n', 'utf8')
}

export async function clearInflight(genreKey: string): Promise<void> {
  await rm(inflightPath(genreKey), { force: true })
}

/**
 * **歩き終えたジャンルの索引だけ**を、まとめて同期で読む。
 *
 * ★ 記事側（`theme-packs/`）はここを使う。`completedAt` の無いジャンルを
 *   混ぜると「歩いていない範囲の不在」を掴んでしまう（このファイル冒頭）。
 */
export function loadCompletedSync(): { works: Map<string, CatalogEntry>; genres: string[] } {
  const works = new Map<string, CatalogEntry>()
  const genres: string[] = []
  let sweeps: Sweeps
  try {
    sweeps = JSON.parse(readFileSync(SWEEPS_PATH, 'utf8')) as Sweeps
  } catch {
    return { works, genres }
  }
  for (const [key, s] of Object.entries(sweeps)) {
    if (!s.completedAt) continue
    genres.push(key)
    try {
      for (const line of readFileSync(genrePath(key), 'utf8').split('\n')) {
        if (!line.trim()) continue
        const e = JSON.parse(line) as CatalogEntry
        works.set(e.id, e)
      }
    } catch {
      // ファイルが無い＝周回の記録と索引がずれている。**黙って空で進める。**
      // 「あるのに無いと言う」より「分からない」に倒すほうが安全。
    }
  }
  return { works, genres }
}

/** 索引に入っているジャンルのファイル名（点検用）。 */
export function catalogFiles(): string[] {
  try {
    return readdirSync(CATALOG_DIR).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
}

/** 非同期版。CLI の点検表示で使う。 */
export async function catalogFilesAsync(): Promise<string[]> {
  try {
    return (await readdir(CATALOG_DIR)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
}
