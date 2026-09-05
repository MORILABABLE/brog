/**
 * U-NEXT の作品台帳（data/unext-titles.json）。
 *
 * ■ events と何が違うか
 * 保存するものが2層ある。役割が違うので混ぜない。
 *
 *   data/events/*.jsonl      **変化のログ**。追記のみ。過去は書き換えない。
 *                            記事の素材はこちら（「8月31日に終了する」という出来事）
 *   data/unext-titles.json   **作品のいまの姿**。上書きする。
 *                            常設ページの素材と、次回収集の当たり判定に使う
 *
 * ■ なぜ要るのか（費用の話）
 * 配信終了日は一覧に出てこないので、作品ページを1件ずつ開かないと取れない。
 * 1件1遷移で2.5秒かかるため、毎回全件を開き直すと数十分かかるうえ、
 * その大半は「前回と同じ答え」を相手のサーバーから貰い直すだけの無駄になる。
 *
 * 既知の作品は、ここに記録した終了日を使って
 * **「まだ期限の内側か」の判定だけ**を行い、ページを開かない。
 *
 * ■ キャッシュした日付を記事に出さないこと
 * 終了日は変わりうる。古い日付で記事を書くのが最悪の事故なので、
 * **記事の素材になる（＝台帳に無い新しい）作品は必ず取り直す**。
 * ここの値は「もう記録済みの作品を、どこまで読み進めるか」の判断にしか使わない。
 * 使い分けは unext.ts の #collectExpiring にある。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Lineup } from './unext.ts'

export const UNEXT_STORE_PATH = join('data', 'unext-titles.json')

/** 作品1件の「いまの姿」。事実だけを持ち、あらすじ等の表現は持たない。 */
export interface UnextTitleRecord {
  id: string
  /** 邦題。U-NEXT は最初から日本語で返すので解決処理は要らない */
  title: string
  type: 'movie' | 'series'
  /**
   * 配信中の本編エピソード数。映画は 1。
   * **type の根拠**。これが無い記録の type は一覧からの推定で、当てにならない
   * （完結済みのシリーズが映画に化ける）。unext:refresh が埋めに行く。
   */
  episodeCount?: number
  /** 最初に見つけたジャンル。同じ作品が複数ジャンルに出ることがある */
  genreKey: string
  genreLabel: string
  lineup: Lineup
  year?: number
  seriesName?: string
  country?: string
  /** 配信開始（ISO） */
  publicStartDate?: string
  /** 配信終了（ISO）。パースできた場合のみ */
  publicEndDate?: string
  /** 終了日の元表記。書式が変わったときに気づくために残す */
  publicEndText?: string
  /** 最初に観測した時刻 */
  firstSeenAt: string
  /** 最後に一覧で見かけた時刻 */
  lastSeenAt: string
  /** 最後に作品ページを開いた時刻。未取得なら undefined */
  detailCheckedAt?: string
}

export interface UnextStore {
  version: 1
  titles: Record<string, UnextTitleRecord>
}

const EMPTY: UnextStore = { version: 1, titles: {} }

export async function loadStore(path = UNEXT_STORE_PATH): Promise<UnextStore> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<UnextStore>
    return { version: 1, titles: parsed.titles ?? {} }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, titles: {} }
    throw err
  }
}

/**
 * 台帳が持っている配信開始日を、作品IDから引ける形で返す。
 *
 * ■ 何のためにあるか
 * 新着（kind: 'new'）のイベントは、一覧だけでは配信開始日を持てない。
 * 日付は作品ページにしか無く、`UnextSource.enrich()` が後から足しているが、
 * **予算(max_detail_views)を使い切ると日付の無いまま記録される。**
 * イベントログは追記のみで過去を書き換えないので、
 * 一度そうなった作品は**次回の収集では台帳(ledger)に弾かれ、二度と日付が付かない。**
 * 実際 2026-09 は新着313件すべてが日付を持たず、記事の素材が0件になった。
 *
 * 日付そのものは `unext:refresh` が作品ページを開いて台帳に書き込んでいる
 * （収集のたびに150件ずつ、`detailCheckedAt` の無いものから）。
 * つまり**答えは台帳にあるのに、記事の素材に届いていない**という状態だった。
 * ここはその橋渡しで、読み込み時に台帳の値をイベントへ写す。
 *
 * ■ 終了日を同じように扱ってはいけない
 * このファイル冒頭の「キャッシュした日付を記事に出さないこと」は**終了日の話**。
 * 終了日は延びたり前倒しになったりするので、古い値で記事を書くと嘘になる。
 * 配信開始日は**すでに起きた過去の事実で、あとから動かない。**
 * だから開始日だけは台帳の値をそのまま素材にしてよい。
 * `kind: 'expiring'` に同じことをしないこと。
 *
 * 同期で読むのは `readAllEventsSync()`（品質ゲート）からも呼ばれるため。
 * 1回の実行で何度も読まないようキャッシュする。
 */
let startDates: Map<string, string> | undefined

export function unextStartDates(path = UNEXT_STORE_PATH): Map<string, string> {
  if (startDates) return startDates
  const map = new Map<string, string>()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UnextStore>
    for (const [id, rec] of Object.entries(parsed.titles ?? {})) {
      if (rec?.publicStartDate) map.set(id, rec.publicStartDate)
    }
  } catch (err) {
    // 台帳がまだ無い環境（初回・CI の一部）でも記事生成は動くべきなので握る。
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  startDates = map
  return map
}

/** テスト用。台帳を書き換えたあとに読み直させる。 */
export function clearUnextStartDateCache(): void {
  startDates = undefined
}

export async function saveStore(store: UnextStore, path = UNEXT_STORE_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // キーを並べておくと git の差分が読める。作品数が増えるほど効く。
  const titles: Record<string, UnextTitleRecord> = {}
  for (const id of Object.keys(store.titles).sort()) titles[id] = store.titles[id]!
  await writeFile(path, JSON.stringify({ version: 1, titles }, null, 2) + '\n', 'utf8')
}

/**
 * 1件を書き込む。既にあれば足りない情報だけ埋め、firstSeenAt は保つ。
 *
 * ■ 既定で undefined を無視する理由
 * 更新は2つの経路から来る。一覧（作品名とジャンルしか持たない）と、
 * 作品ページ（日付まで持つ）。何も考えずに上書きすると、
 * **一覧からの更新が作品ページで得た日付を消してしまう。**
 *
 * ■ それでも消したいとき
 * 配信終了日が「取り下げられた」（無期限になった）ケースがある。
 * このときは古い日付を残すほうが有害なので、`clear` に挙げたキーだけは
 * undefined での上書きを許す。**作品ページを実際に開いたときにだけ使うこと。**
 */
export function upsert(
  store: UnextStore,
  rec: Omit<UnextTitleRecord, 'firstSeenAt' | 'lastSeenAt'> & { seenAt: string },
  clear: (keyof UnextTitleRecord)[] = [],
): UnextTitleRecord {
  const { seenAt, ...incoming } = rec
  const prev = store.titles[rec.id]

  const merged: UnextTitleRecord = {
    ...(prev ?? { firstSeenAt: seenAt }),
    ...Object.fromEntries(Object.entries(incoming).filter(([, v]) => v !== undefined)),
    id: rec.id,
    firstSeenAt: prev?.firstSeenAt ?? seenAt,
    lastSeenAt: seenAt,
  } as UnextTitleRecord

  for (const k of clear) {
    if ((incoming as Record<string, unknown>)[k] === undefined) delete merged[k]
  }

  store.titles[rec.id] = merged
  return merged
}

/** 作品ページを開いたときにだけ、undefined での上書きを許すキー。 */
export const DETAIL_OWNED_FIELDS: (keyof UnextTitleRecord)[] = [
  'publicEndDate',
  'publicEndText',
]

/** 終了日が変わった作品を拾う。延長・前倒しに気づくため（通知の材料）。 */
export function endDateChanged(
  prev: UnextTitleRecord | undefined,
  next: UnextTitleRecord,
): boolean {
  if (!prev?.publicEndDate || !next.publicEndDate) return false
  return prev.publicEndDate !== next.publicEndDate
}
