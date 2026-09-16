/**
 * U-NEXT の**カタログ索引**から「その作品が U-NEXT で見放題か」を引く。
 *
 * 索引を書くのはパイプライン（`npm run unext:catalog`）。**ここは読むだけ。**
 *
 * ■ なぜ作ったか（2026-09-16）
 *
 * 記事の表の在庫行（`plugins/rehype-availability.ts`）は
 * **配信APIが在庫を返す4社ぶんしか描けなかった。**
 * U-NEXT は「データが無い」という理由で `SERVICES` から外してあり、
 * 読者にはこう出ていた。
 *
 *     | 9月30日 | ハリー・ポッターと賢者の石 | 77/100 |
 *     |  × Netflix  × Prime Video  × Disney+  △ Apple TV+   他で探す: U-NEXT …  |
 *
 * **答え（U-NEXTに8作すべて見放題である）は手元にあったのに、
 * 誰も読んでいなかった。** `data/unext-catalog/` は
 * [CROSS-SERVICE 3-2](../../../docs/CROSS-SERVICE.md) の穴
 * —— 「台帳に無い＝U-NEXTに無い、ではない」—— を埋めるために作られ、
 * `loadCompletedSync()` まで用意されたまま消費者がゼロだった
 * （[OWN-LEDGER 7節](../../../docs/OWN-LEDGER.md)「索引を記事に繋ぐ」）。
 *
 * ■ ★ 出すのは**記事だけ**。作品ページ・常設ページには出さない
 *
 * [GROWTH 2-3](../../../docs/GROWTH.md) の決定をそのまま守る（2026-09-16・運用者に確認済み）。
 *
 *     記事      URLに日付が入り、公開時点で固定される  → **その月の断面**
 *     常設ページ ビルドのたびに入れ替わる              → **台帳の写しに近づく**
 *
 * U-NEXT は規約に「取ったデータをどう使ってよいか」の明言が無い。
 * 明言が無いものはこちらの解釈で広げない、というのがあの節の原則。
 * **このファイルを `works/[id].astro` や `WorkTable.astro` から呼ばないこと。**
 *
 * ■ ★ 絶対に守ること
 *
 *   1. **「無い」を言わない。** 引けなければ `undefined` を返すだけで、
 *      呼ぶ側は**何も描かない**。× にしないのはもちろん、「—（未確認）」にもしない
 *      （4社は「調べたうえで無い」と言えるが、U-NEXT はそれが言えない）。
 *   2. **歩き終えたジャンルだけを見る**（`completedAt`）。途中の索引を「全部」として
 *      扱うと、歩いていない範囲の不在を「無い」と読む。1 と同じ穴。
 *   3. **ポイント作品を見放題と呼ばない。** U-NEXT ガイドライン【4】の誤認訴求そのもの。
 *      `svod` / `both` だけを ○ にする（下の `LINEUP_OK`）。
 *   4. **同名で `lineup` が割れたら黙る。** 索引は `year` を1件も持たないので
 *      （実測: 16,238件中0件）、同名の別作品を区別する手が無い。
 *      ★ `availability.ts` の `marksOf` は「割れたら強いほうを採る」に倒しているが、
 *        **こちらは逆に倒す。** あちらが混ぜるのは同じAPIが同じ作品に付けた印で、
 *        こちらが混ぜるのは**別作品かもしれない行**。しかも取り違えると
 *        3（ポイントを見放題と呼ぶ）に直結する。実測で割れるのは121組中10組だけなので、
 *        捨てても失うものは小さい。
 *   4-b. **同名の別作品は、それでも残る。** 4 が捨てられるのは
 *      「索引の中で扱いが割れた題名」だけで、**こちらの作品と索引の作品が
 *      別物**という取り違えは題名だけでは検知できない
 *      （例: 『許されざる者』1992年版と2013年版）。
 *      ★ **だから ○ の送り先を作品ページ（`SID…`）にせず、
 *        作品名の検索（`freeword?query=`）にしてある。**
 *        取り違えていても読者は U-NEXT 自身の検索結果を見るので、
 *        **こちらの間違いがそのまま読者の間違いにならない。**
 *        送り先を作品ページに「改善」しないこと。この性質が消える。
 *   5. **終了日が過ぎた作品を ○ にしない。** 索引は日付を持たないので、
 *      日付を持つ台帳（`data/unext-titles.json`）と突き合わせて落とす（`expired()`）。
 *      ガイドライン【4】の「配信終了済みの作品がすぐ観られると読ませない」に直接効く。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { normalizeForSearch } from './normalize.ts'

/** 台帳の場所を探す。`availability.ts` と同じ理由で実行時のカレントから上へ辿る。 */
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
 * 周回がこれより古くなったら印を出さない。
 *
 * ★ **`availability.ts` の `MAX_AGE_DAYS`（14日）とは桁を変えてある。**
 *   あちらはAPIを叩けば当日ぶんが手に入るが、こちらは1ジャンルを歩き切るのに
 *   週2回×250ページで**4〜5週間**かかる（docs/OWN-LEDGER.md 6-3）。
 *   14日で落とすと、**構造上ほぼ常に落ちる**＝索引を作った意味が消える。
 *
 *   90日は「1周（4〜5週間）を1回落としても、次の周回までは持つ」長さ。
 *   ここを縮めるなら、先に周回の速さを上げること。
 */
const MAX_SWEEP_AGE_DAYS = 90

/** ○ にしてよい `lineup`。**`point` を入れないこと**（上の 3）。 */
const LINEUP_OK = new Set(['svod', 'both'])

interface CatalogEntry {
  id: string
  title: string
  lineup: string
  /** **この周回で見かけなかった**ときだけ入る ＝ 歩いた範囲から消えた作品 */
  lastSeenAt?: string
}

export interface UnextStock {
  /** U-NEXT の作品ID（`SID…`）。台帳との突き合わせに使う */
  id: string
  /** その作品を見かけた周回を歩き終えた日。凡例の「◯月◯日時点」に出す */
  sweptAt: Date
}

interface Index {
  /** ならした題名 → 見放題の作品（割れた題名は最初から入れない） */
  byTitle: Map<string, UnextStock>
  /** 歩き終えたジャンルのキー（点検用） */
  genres: string[]
}

let index: Index | null = null

/**
 * 台帳（`unext-titles.json`）で**終了日が過ぎている** SID を集める。
 *
 * ★ 索引は日付を持たない（一覧ページに出てこない）。日付を持っているのは台帳だけなので、
 *   「索引にはまだ載っているが、もう終わっている」作品はここでしか落とせない。
 * ★ **終了日を知らない作品は落とさない。** 台帳は歩いた範囲しか持たないので、
 *   「台帳に無い＝終わっている」ではない。ここでも「無い」を言わない。
 */
function expiredIds(now: number): Set<string> {
  const out = new Set<string>()
  const path = findUp('data', 'unext-titles.json') ?? findUp('..', 'data', 'unext-titles.json')
  // ★ 台帳が見つからない＝終了済みを落とせない。**索引ごと使わない**（下の catch と同じ扱い）
  if (!path) throw new Error('unext-titles.json が見つかりませんでした')
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      titles?: Record<string, { publicEndDate?: string }>
    }
    for (const [id, t] of Object.entries(raw.titles ?? {})) {
      if (!t.publicEndDate) continue
      const at = Date.parse(t.publicEndDate)
      if (Number.isFinite(at) && at < now) out.add(id)
    }
  } catch {
    // 壊れていても記事は出す。**終了済みを落とせないだけ**なので、
    // そのときは安全側に倒して索引ごと使わない。
    throw new Error('unext-titles.json を読めませんでした')
  }
  return out
}

function load(now = Date.now()): Index {
  if (index) return index
  const empty: Index = { byTitle: new Map(), genres: [] }
  const dir =
    findUp('data', 'unext-catalog') ?? findUp('..', 'data', 'unext-catalog')
  if (!dir) return (index = empty)

  let sweeps: Record<string, { completedAt?: string }>
  let expired: Set<string>
  try {
    sweeps = JSON.parse(readFileSync(join(dir, '_sweeps.json'), 'utf8'))
    expired = expiredIds(now)
  } catch {
    // 周回の記録が読めない＝「歩き終えたか」が分からない。**印を1つも出さない。**
    return (index = empty)
  }

  const byTitle = new Map<string, UnextStock>()
  /** 割れた題名。**一度割れたら二度と入れない**（あとから来た行に上書きさせない） */
  const split = new Set<string>()
  const genres: string[] = []

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const key = file.replace(/\.jsonl$/, '')
    const completedAt = sweeps[key]?.completedAt
    if (!completedAt) continue
    const sweptMs = Date.parse(completedAt)
    if (!Number.isFinite(sweptMs)) continue
    if (now - sweptMs > MAX_SWEEP_AGE_DAYS * 86_400_000) continue
    genres.push(key)
    const sweptAt = new Date(sweptMs)

    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let e: CatalogEntry
      try {
        e = JSON.parse(line) as CatalogEntry
      } catch {
        continue
      }
      // ★ 歩いた範囲から消えた作品（上の `lastSeenAt` の説明）
      if (e.lastSeenAt) continue
      if (expired.has(e.id)) continue
      const key2 = normalizeForSearch(e.title)
      if (!key2 || split.has(key2)) continue
      const ok = LINEUP_OK.has(e.lineup)
      const prev = byTitle.get(key2)
      if (prev) {
        // ★ 同名がもう1件。**扱いが違えば、どちらも捨てる**（上の 4）
        if (!ok) {
          byTitle.delete(key2)
          split.add(key2)
        }
        continue
      }
      if (!ok) {
        /*
         * ★ **ポイント作品も「見た」ことは覚える。**
         *   覚えずに素通りすると、あとから同名の見放題が来たときに
         *   ○ を出してしまう（割れているのに割れたと分からない）。
         */
        split.add(key2)
        continue
      }
      byTitle.set(key2, { id: e.id, sweptAt })
    }
  }
  return (index = { byTitle, genres: genres.sort() })
}

/**
 * 題名から「U-NEXT で見放題か」を引く。**引けなければ `undefined`。**
 *
 * ★ `undefined` を「U-NEXTに無い」と読み替えないこと（冒頭の 1）。
 *   歩いていないジャンル（2026-09-16 時点では邦画・アニメ・国内ドラマほか8つ）の
 *   作品は、**あっても引けない。**
 */
export function unextStockFor(title: string): UnextStock | undefined {
  const key = normalizeForSearch(title)
  if (!key) return undefined
  return load().byTitle.get(key)
}

/** 歩き終えたジャンル（点検・通知用）。 */
export function unextSweptGenres(): string[] {
  return load().genres
}

/** テスト用。読み込みをやり直させる。 */
export function resetUnextStock(): void {
  index = null
}
