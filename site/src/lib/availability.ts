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
 *   4. **目視で否認した組み合わせを ○ にしない**（`availability-ng.ts`）。
 *      APIが `subscription` を返していても、その社の画面に無い作品がある
 *      （2026-09-09・コナンの劇場版8作）。**取り下げるのは ○ だけ**で、
 *      レンタル・購入が残っていれば △、何も残らなければ **—（未確認）**
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deniesSubscription } from './availability-ng.ts'

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
/** 在庫台帳が持つ作品の姿。`--adopt` で採用したものだけが `work` を持つ。 */
export interface StockWorkRecord {
  id: number | string
  title: string
  localizedTitle?: string
  genres?: string[]
  link?: string
  posterUrl?: string
}

interface RawWork {
  fetchedAt: string
  services: RawService[]
  /** `npm run availability -- --adopt` が入れた作品。**採用の印**（無い行は注釈だけ） */
  work?: StockWorkRecord
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
export function marksFor(
  workId: string,
  titles: readonly string[] = [],
  now = Date.now(),
): WorkMarks | undefined {
  const entry = load()[workId]
  if (!entry?.fetchedAt) return undefined
  const at = Date.parse(entry.fetchedAt)
  if (!Number.isFinite(at) || now - at > MAX_AGE_DAYS * 86_400_000) return undefined

  const marks = new Map<string, Mark>()
  const links = new Map<string, string>()
  for (const s of entry.services) {
    /*
     * ★ **目視で否認した見放題を落とす**（上の「絶対に守ること」4）。
     *   台帳（`data/availability.json`）はAPIの応答そのままで書き換えない。
     *   落とすのはここ（読む側）。
     */
    const denied = deniesSubscription(s.service, workId, titles)
    const paid = s.types.some((t) => t === 'rent' || t === 'buy' || t === 'addon')
    // ★ subscription だけが見放題。addon は別料金なので paid 側に落とす。
    const mark: Mark = s.types.includes('subscription') && !denied
      ? 'subscription'
      : paid
        ? 'paid'
        : denied
          ? // ★ 見放題を取り下げたら根拠が1つも残らない場合。
            // **× にしない。**「調べたうえで取り扱いなし」とは言えない
            'unknown'
          : 'none'
    marks.set(s.service, mark)
    // ★ 「—（未確認）」にリンクは付けない（`rehype-availability.ts` も張らない）
    if (s.link && mark !== 'unknown') links.set(s.service, s.link)
  }
  return { marks, links, fetchedAt: new Date(at) }
}

/**
 * 題名から在庫台帳の作品IDを引く。**完全一致だけ。**
 *
 * ■ なぜ要るか（2026-09-10 追加）
 * `work-links.ts` の索引は **`data/events`（変化ログ）だけ**から作られている。
 * 在庫から採用した作品（`npm run availability -- --adopt`）は変化ログに無いので
 * 題名からIDが引けず、**表に印の行がまるごと出ない。**
 *
 *   実測（2026-09-10・「クレヨンしんちゃん」シリーズ）
 *     表32行のうち印が出たのは6行。残る26本はすべて在庫から採用した作品
 *     kamen-rider も15行中5行しか出ていなかった
 *
 * 読者から見れば「この行だけサービス先が出ていない」＝不具合で、
 * `rehype-availability.ts` の `planTable` が
 * 「作品として引けた行には必ず行を足す」と決めているのと同じ趣旨の穴。
 *
 * ★ **完全一致だけにする。** `work-links.ts` の `workKey` のような正規化はかけない。
 *   あちらは変化ログの中の表記ゆれを吸収するためのもので、ここで効かせると
 *   別作品を巻き込む。台帳の題名は在庫APIが返したものそのままで、
 *   記事の表の題名も同じ素材から書かれるので、完全一致で足りる。
 * ★ **`work` を持つ行だけ**を見る。それは `--adopt` が入れた
 *   「素材にしてよいと人が決めた作品」の印（`pipeline/cli/availability.ts`）。
 *   注釈のために取っただけの行は、変化ログ側が題名からIDを引ける。
 * ★ **新しさはここで見ない。** `marksFor()` が `MAX_AGE_DAYS` で落とす。
 *   ここで二重に判定すると、片方だけ直したときに食い違う。
 */
let titleIndex: Map<string, string[]> | null = null

export function ledgerIdsForTitle(title: string): string[] {
  if (!titleIndex) {
    titleIndex = new Map()
    for (const [id, entry] of Object.entries(load())) {
      const work = entry.work
      if (!work) continue
      for (const name of [work.localizedTitle, work.title]) {
        if (!name) continue
        const list = titleIndex.get(name)
        if (list) {
          if (!list.includes(id)) list.push(id)
        } else {
          titleIndex.set(name, [id])
        }
      }
    }
  }
  return titleIndex.get(title) ?? []
}

/**
 * 在庫から採用した作品を、**観測1件ずつの形**で返す。
 *
 * ■ なぜ要るか（2026-09-10 追加）
 * `work-links.ts` も `make-thumbs.mjs` も **`data/events`（変化ログ）だけ**を見ている。
 * 在庫から採用した作品はそこに無いので、**表の題名がリンクにならず、
 * 行のサムネイルも出ない。**
 *
 *   実測（2026-09-10・「クレヨンしんちゃん」シリーズ）
 *     表30行のうちリンクと絵が付いたのは4行だけ（残り26本は在庫から採用した作品）
 *
 * ★ **`work` を持つ行だけ。** それは `--adopt` が入れた
 *   「素材にしてよいと人が決めた作品」の印（`pipeline/cli/availability.ts`）。
 * ★ **見放題（`subscription`）のサービスだけを1件ずつ返す。**
 *   `addon` は別料金なので送り先にしない（このファイル冒頭の「絶対に守ること」1）。
 *   目視で否認した組み合わせも落とす（同4）。
 * ★ **リンクはサービスごとの行のものを優先する。** `work.link` は1本しか無く、
 *   Netflix の行から Amazon へ送るような取り違えが起きる。
 * ★ **新しさ（`MAX_AGE_DAYS`）はここでは見ない。** 印（`marksFor`）は
 *   古い在庫を「分からない」に落とすが、**リンクと絵は古くても正しい**
 *   （その作品がその題であることは変わらない）。落とすと表から絵が消える。
 */
export interface StockWorkObservation {
  id: string
  service: string
  fetchedAt: string
  work: StockWorkRecord
}

let stockWorks: StockWorkObservation[] | null = null

export function adoptedStockWorks(): StockWorkObservation[] {
  if (stockWorks) return stockWorks
  const out: StockWorkObservation[] = []
  for (const [id, entry] of Object.entries(load())) {
    const work = entry.work
    if (!work) continue
    const titles = [work.localizedTitle, work.title].filter(Boolean) as string[]
    for (const s of entry.services) {
      if (!s.types.includes('subscription')) continue
      if (deniesSubscription(s.service, id, titles)) continue
      out.push({
        id,
        service: s.service,
        fetchedAt: entry.fetchedAt,
        work: { ...work, link: s.link ?? work.link },
      })
    }
  }
  stockWorks = out
  return out
}
