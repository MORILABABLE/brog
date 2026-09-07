/**
 * **配信状況の履歴**（`data/history/*.jsonl`）。追記のみ。過去は書き換えない。
 *
 * ■ なぜ要るのか — **いま、履歴が毎回捨てられている**
 *
 * データの置き場は3つあるが、**時間を持っているのは1つだけ**だった。
 *
 *   data/events/*.jsonl      変化ログ。追記のみ。**時間を持つ**
 *                            ただし記録するのは API/U-NEXT が「変化」として返したものだけ
 *   data/unext-titles.json   U-NEXT の作品のいまの姿。**上書き**
 *   data/availability.json   4社の在庫のいまの姿。**上書き**
 *
 * 上書きされる2つには、**取り直すたびに差分が出ている。**
 * `unext:refresh` は終了日が動いた作品を1件ずつ見つけて画面に出しているが、
 * **出したあと捨てている**（`cli/unext-refresh.ts` の `changes`）。
 *
 *     [変更] 名探偵コナン …: 2026年8月31日 → 2026年9月30日   ← 延長された
 *     [終了日が消えた] …                                      ← 無期限になった
 *
 * **これがいちばん値打ちのある観測**で、他のどこも持っていない。
 * 「8月31日で終わる予定だったが延長された」は、当サイトが毎週見に行っていなければ
 * 誰も知りようがない事実。捨てずに積むと、時間そのものが差別化になる。
 *
 * ■ 何を記録するか — **状態そのものではなく、状態が動いたこと**
 *
 * 毎回の全件スナップショットは置かない（同じ答えが積み上がるだけで嵩む）。
 * **前回と違ったところだけ**を1行にする。
 *
 * ■ ★ 絶対に守ること — **「歩いた範囲」を必ず一緒に残す**
 *
 * `via` に、その観測がどうやって得られたかを書く。
 * これが無いと、**あとから「無い」を読み違える。**
 *
 *     ✕ 「9月7日の観測に無い」→「U-NEXTから消えた」
 *     ○ 「9月7日に新規入荷カテゴリを歩いた。そこには無かった」
 *        （カタログ全体を見たわけではないので、消えたとは言えない）
 *
 * 当サイトが歩いているのは**カタログ全体ではない**（docs/CROSS-SERVICE.md 3-2）。
 * 範囲を残さない不在は**偽の不在**になり、いちばん質の悪い誤情報になる。
 * 2026-09-07 に仮面ライダーで実際に踏んだ間違いと同じ種類のもの
 * （APIが14本しか知らないことを「Amazonに14本しかない」と報告した）。
 *
 * ■ 何に使うか
 *
 *   - 「延長された／前倒しされた」を記事に書く（他所が書けない）
 *   - 「このサービスは平均◯日で入れ替わる」を実測で言う
 *   - 作品ページに「この作品の配信履歴」を出す
 *
 * どれも**時間が経つほど価値が増える**。逆に言えば、**今日記録していないぶんは
 * 二度と取り返せない。** 網羅は後から広げられるが、過去の履歴は後から作れない。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentYearMonth } from './datetime.ts'

export const HISTORY_DIR = join('data', 'history')

/** 何が動いたか。**増やすときは記事側の読み手も一緒に直すこと。** */
export type StockField =
  /** 見放題の終了日（U-NEXT の `publicEndDate` / API の `expiresOn`） */
  | 'endDate'
  /** 見放題かポイントか（U-NEXT の `lineup`） */
  | 'lineup'
  /** そのサービスで見放題として観られるか（在庫の `subscription`） */
  | 'subscription'

/** 状態が動いた観測1件。 */
export interface StockChange {
  /** 観測した時刻（ISO） */
  observedAt: string
  /** テーマのサービスキー（`u-next` `prime-video` …） */
  service: string
  /** 作品ID。U-NEXT は `SID…`、配信APIは数値ID */
  workId: string
  /** 観測時点の題名。**あとから引けなくなるので一緒に残す** */
  title: string
  field: StockField
  /** 前の値。無かったなら未設定 */
  from?: string
  /** 今回の値。無くなったなら未設定 */
  to?: string
  /**
   * **どうやって観測したか。** 省略しないこと（このファイル冒頭の「絶対に守ること」）。
   * 例: `unext:refresh` `availability --adopt keyword=Kamen Rider`
   */
  via: string
}

/**
 * 履歴に追記する。**月別のファイルに分ける**（`events` と同じ理由で、
 * 1ファイルが際限なく育つのを防ぐ）。
 *
 * ★ 0件なら何もしない。**空の追記でファイルを作らない**（差分が汚れる）。
 */
export async function appendHistory(
  changes: StockChange[],
  offsetMinutes: number,
): Promise<void> {
  if (changes.length === 0) return
  await mkdir(HISTORY_DIR, { recursive: true })
  const path = join(HISTORY_DIR, `${currentYearMonth(offsetMinutes)}.jsonl`)
  await appendFile(path, changes.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8')
}

/** 全期間の履歴を読む。**記事の素材ではなく、集計と作品ページのためのもの。** */
export function readHistorySync(): StockChange[] {
  let files: string[]
  try {
    files = readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.jsonl')).sort()
  } catch (err) {
    // 無ければ空。**履歴が無い状態は異常ではない**（積み始めた日より前）
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: StockChange[] = []
  for (const f of files) {
    for (const line of readFileSync(join(HISTORY_DIR, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line) as StockChange)
    }
  }
  return out
}

/** 非同期版。CLI 用。 */
export async function readHistory(): Promise<StockChange[]> {
  return readHistorySync()
}

/** 作品ごとにまとめる。作品ページ（`/works/<id>`）で配信履歴を出すときに使う。 */
export function historyByWork(changes: StockChange[]): Map<string, StockChange[]> {
  const out = new Map<string, StockChange[]>()
  for (const c of changes) {
    const list = out.get(c.workId) ?? []
    list.push(c)
    out.set(c.workId, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.observedAt.localeCompare(b.observedAt))
  return out
}

/**
 * 終了日が**後ろにずれた**観測（延長）。
 *
 * ★ **この記事タイプはまだ無い。** 集計の口だけ先に置いてある。
 *   何本たまったら記事になるかは、実際に積んでから決める
 *   （docs/OWN-LEDGER.md「いつ記事になるか」）。
 */
export function extensions(changes: StockChange[]): StockChange[] {
  return changes.filter(
    (c) => c.field === 'endDate' && c.from != null && c.to != null && c.to > c.from,
  )
}

/** 終了日が**前倒しされた**観測。延長より珍しく、読者にとっては急ぐ理由になる。 */
export function broughtForward(changes: StockChange[]): StockChange[] {
  return changes.filter(
    (c) => c.field === 'endDate' && c.from != null && c.to != null && c.to < c.from,
  )
}

/** 終了日が**取り下げられた**観測（期限つき → 無期限）。 */
export function deadlineLifted(changes: StockChange[]): StockChange[] {
  return changes.filter((c) => c.field === 'endDate' && c.from != null && c.to == null)
}

/** ファイルの有無だけを見たいとき（`--list` の表示など）。 */
export async function historyExists(): Promise<boolean> {
  try {
    await readFile(join(HISTORY_DIR, `${currentYearMonth(540)}.jsonl`), 'utf8')
    return true
  } catch {
    return false
  }
}
