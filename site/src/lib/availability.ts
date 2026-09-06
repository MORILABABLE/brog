/**
 * 「その作品が、いまどのサービスで観られるか」をサイト側から読む。
 *
 * 台帳を書くのはパイプライン（`npm run availability`）。
 * **ここは読むだけ。** 取りに行かないし、書き換えもしない。
 *
 * ■ 何に使うのか
 * シリーズ記事の表に **○ / △ / ×** の列を足す（`plugins/rehype-availability.ts`）。
 * 読者の問いは「いつ終わるか」ではなく**「では、どこで観るのか」**で、
 * それを**文章ではなく表で**返すためのもの。
 * 実測でスクロール90%到達は22%しかない（docs/FUNNEL.md 5-3）ので、
 * **答えは表の中に置かないと届かない。**
 *
 * ■ ★ 判定の規則がパイプライン側と二重にある
 * `pipeline/core/availability.ts` に同じ規則（`subscription` だけが見放題）がある。
 * **site は pipeline を import しない**という境界を保つため、意図的に写してある
 * （`work-links.ts` が `data/events` を直接読むのと同じ事情）。
 *
 * **どちらかを変えるときは必ず両方を変えること。** 片方だけ変えると、
 * 記事の本文（パイプラインが素材にした事実）と表（ここが描く印）が食い違う。
 *
 * ■ 絶対に守ること
 *   1. **`addon` を見放題にしない。** Prime Video チャンネル等の別料金で、
 *      同じ作品に併存する（docs/CROSS-SERVICE.md 4-1）
 *   2. **台帳に無い作品を「×」にしない。** 未取得と「取り扱いなし」は違う。
 *      無いものは「—」（分からない）で描く
 *   3. **U-NEXT / Hulu / DMM TV には印を付けない。** 在庫データを持っていない
 *      （docs/CROSS-SERVICE.md 9-3）。列そのものを作らない
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 台帳の場所を探す。`work-links.ts` と同じ理由で実行時のカレントから上へ辿る。 */
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

/**
 * 取得から何日までを有効とみなすか。
 * ★ `pipeline/core/availability.ts` の `MAX_AGE_DAYS` と揃えること。
 */
const MAX_AGE_DAYS = 14

interface RawService {
  service: string
  types: string[]
  link?: string
}
interface RawWork {
  fetchedAt: string
  services: RawService[]
}

let ledger: Record<string, RawWork> | null = null

function load(): Record<string, RawWork> {
  if (ledger) return ledger
  const path = findUp('data', 'availability.json') ?? findUp('..', 'data', 'availability.json')
  if (!path) return (ledger = {})
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { works?: Record<string, RawWork> }
    ledger = raw.works ?? {}
  } catch {
    // 壊れていても記事は出す。**印が出ないだけ。**
    ledger = {}
  }
  return ledger
}

/** 表に描く印。**「×」と「—」を混ぜないこと**（上の「絶対に守ること」2）。 */
export type Mark = 'subscription' | 'paid' | 'none' | 'unknown'

export const MARK_SYMBOL: Record<Mark, string> = {
  /*
   * ★ 見放題は**輪郭の○**。
   *   一度 ●（塗りつぶし）にしたが、小さい字だと**潰れて見えた**
   *   （2026-09-06・運用者の指摘）。△・× と線の太さを揃えるほうが
   *   記号の並びとして読みやすい。色（青）で強さを出す。
   */
  subscription: '○',
  paid: '△',
  none: '×',
  unknown: '—',
}

/** 読み上げ用。記号だけだと支援技術に意味が伝わらない。 */
export const MARK_LABEL: Record<Mark, string> = {
  subscription: '見放題',
  paid: 'レンタル・購入',
  none: '取り扱いなし',
  unknown: '不明',
}

export interface WorkMarks {
  /** サービスキー → 印 */
  marks: Map<string, Mark>
  /** サービスキー → その作品ページへの直リンク（あれば） */
  links: Map<string, string>
  /** 取得日（`2026年9月6日` の形にするのは呼び出し側） */
  fetchedAt: Date
}

/**
 * 作品IDから印を引く。**台帳に無い／古ければ `undefined`。**
 *
 * ★ `undefined` を「取り扱いなし」に読み替えないこと。
 *   呼び出し側は列そのものを描かないか、「—」を描く。
 */
export function marksFor(workId: string, now = Date.now()): WorkMarks | undefined {
  const entry = load()[workId]
  if (!entry?.fetchedAt) return undefined
  const at = Date.parse(entry.fetchedAt)
  if (!Number.isFinite(at) || now - at > MAX_AGE_DAYS * 86_400_000) return undefined

  const marks = new Map<string, Mark>()
  const links = new Map<string, string>()
  for (const s of entry.services) {
    // ★ subscription だけが見放題。addon は別料金なので paid 側に落とす。
    const mark: Mark = s.types.includes('subscription')
      ? 'subscription'
      : s.types.some((t) => t === 'rent' || t === 'buy' || t === 'addon')
        ? 'paid'
        : 'none'
    marks.set(s.service, mark)
    if (s.link) links.set(s.service, s.link)
  }
  return { marks, links, fetchedAt: new Date(at) }
}
