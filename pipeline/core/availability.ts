/**
 * 「その作品が、いまどのサービスで観られるか」の台帳。
 *
 * ■ 変化ログとは**別のもの**
 * パイプラインの本体が使っているのは `/changes`（変化の観測）で、
 * だからサイトは「配信中」と書けないという決まりがある
 * （`site/src/lib/works.ts` 冒頭「絶対に守ること」）。
 *
 * **この禁止は `/changes` の性質から来ていて、APIの限界ではない。**
 * `/shows/search/filters` が返す `streamingOptions.jp[]` は**その時点の在庫そのもの**で、
 * これを根拠にするなら「見放題」と書ける（docs/CROSS-SERVICE.md 4-2）。
 * **根拠が違うものを混ぜないため、置き場所を分けてある。**
 *
 * ■ 何のために取るのか
 * シリーズ記事の読者の問いは「いつ終わるか」ではなく
 * **「では、終わったあとどこで観るのか」**（docs/FUNNEL.md 7-3）。
 * その答えを裏付きで書くための材料。
 *
 * ■ 絶対に守ること
 *
 *   1. **`subscription` だけを見放題として扱う。**
 *      `addon` は Prime Video チャンネル等の**別料金**で、同じ作品に併存する。
 *      混同すると「別料金の作品を見放題と書く」ことになる
 *      （docs/CROSS-SERVICE.md 4-1。U-NEXT ガイドライン【4】と同じ性質の事故）。
 *
 *   2. **取得時点を必ず出す。** 在庫は日々変わる。
 *      `fetchedAt` を記事に書かせること（既存の「◯月◯日時点」と同じ作法）。
 *
 *   3. **古い在庫を根拠にしない。** `MAX_AGE_DAYS` を過ぎたものは
 *      「分からない」として扱う。**黙って古い事実を出さない。**
 */
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Work } from '../sources/types.ts'

export const AVAILABILITY_PATH = join('data', 'availability.json')

/**
 * この日数を過ぎた在庫は使わない。
 *
 * シリーズ記事は配信状況が変わるたびに書き直す前提なので、
 * **書き直しの間隔より短く**しておく。長くすると、
 * 「9月に取った在庫」を11月の読者に見せることになる。
 */
export const MAX_AGE_DAYS = 14

/** 見放題として扱ってよい取扱区分。**ここを広げないこと**（上の「絶対に守ること」1）。 */
export const SUBSCRIPTION_TYPES = ['subscription'] as const

export interface ServiceAvailability {
  /** テーマのサービスキー（`netflix` `prime-video` …）。API の `service.id` から解決する */
  service: string
  /** `subscription` / `addon` / `rent` / `buy` / `free` */
  types: string[]
  /** その作品ページへの直リンク。無いことがある */
  link?: string
}

export interface WorkAvailability {
  /** 取得時刻。**記事に出す。** */
  fetchedAt: string
  /** サービスごとの取扱。**空配列は「日本ではどこにも無い」と確認済み** */
  services: ServiceAvailability[]
  /**
   * 在庫検索が返した作品そのもの。**`npm run availability -- --adopt` のときだけ入る。**
   *
   * ■ なぜ台帳が作品を持つのか（2026-09-07 追加）
   * それまで台帳は「素材に載っている作品の注釈」でしかなく、
   * **素材そのものは `/changes`（変化ログ）だけから作られていた。**
   * 変化ログは収集を始めた日以降しか無いので、
   * **それ以前から在庫にある作品は、何年経っても記事に出ない。**
   *
   *   実測（2026-09-07・「仮面ライダー」）
   *     変化ログ由来の素材            11本（すべて8月31日に new が立った分）
   *     在庫で Prime Video の見放題    14本
   *     → シン・仮面ライダー / 仮面ライダーBLACK SUN / 風都探偵 などが欠けていた
   *
   * 在庫（`streamingOptions.jp[].type === 'subscription'`）は
   * **その時点で見放題であることの直接の根拠**なので（このファイル冒頭）、
   * これを素材にしてよい。根拠が違うことは `work` の有無で1件ずつ分かる。
   *
   * ★ **`at`（配信開始日）は持てない。** 在庫は「いまある」としか言わない。
   *   記事側はこの作品を「見放題配信中」として扱い、**日付を書かない**
   *   （`theme-packs/streaming-jp/article-types/series.ts` の `stockEvents`）。
   */
  work?: Work
}

export interface AvailabilityLedger {
  note: string
  updatedAt: string
  /** 作品ID（配信APIの `show.id`）→ 在庫 */
  works: Record<string, WorkAvailability>
}

const EMPTY: AvailabilityLedger = {
  note:
    'その時点の在庫（/shows/search/filters の streamingOptions.jp）。npm run availability が書く。' +
    '手で編集しない。★ subscription だけが見放題。addon は別料金。' +
    '★ fetchedAt から14日を過ぎたものは使わない（pipeline/core/availability.ts）。',
  updatedAt: '',
  works: {},
}

export async function loadAvailability(): Promise<AvailabilityLedger> {
  try {
    const raw = JSON.parse(await readFile(AVAILABILITY_PATH, 'utf8')) as Partial<AvailabilityLedger>
    return { ...EMPTY, ...raw, works: raw.works ?? {} }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, works: {} }
    throw err
  }
}

export async function saveAvailability(ledger: AvailabilityLedger): Promise<void> {
  await mkdir(dirname(AVAILABILITY_PATH), { recursive: true })
  const sorted: AvailabilityLedger['works'] = {}
  for (const k of Object.keys(ledger.works).sort()) sorted[k] = ledger.works[k]!
  const body = { ...EMPTY, ...ledger, updatedAt: new Date().toISOString(), works: sorted }
  await writeFile(AVAILABILITY_PATH, JSON.stringify(body, null, 2) + '\n', 'utf8')
}

/**
 * 同期で読む。**記事タイプ（theme-packs）用。**
 * あちらは素材を同期で組み立てるので、非同期版を混ぜられない
 * （`readAllEventsSync` と同じ事情）。
 */
export function loadAvailabilitySync(): AvailabilityLedger {
  try {
    const raw = JSON.parse(readFileSync(AVAILABILITY_PATH, 'utf8')) as Partial<AvailabilityLedger>
    return { ...EMPTY, ...raw, works: raw.works ?? {} }
  } catch {
    // 無ければ空。**在庫を取っていない状態は異常ではない**（記事は今までどおり書ける）
    return { ...EMPTY, works: {} }
  }
}

/** 取得から `MAX_AGE_DAYS` 以内か。**過ぎていたら「分からない」扱い。** */
export function isFresh(a: WorkAvailability | undefined, now = Date.now()): boolean {
  if (!a?.fetchedAt) return false
  const age = now - Date.parse(a.fetchedAt)
  return Number.isFinite(age) && age >= 0 && age <= MAX_AGE_DAYS * 86_400_000
}

/**
 * 見放題で観られるサービス。**`addon` を含めない。**
 *
 * ★ 呼び出し側が `types.includes('subscription')` を書かないこと。
 *   判定を散らすと、いつか誰かが `addon` を足す。
 */
export function subscriptionServices(a: WorkAvailability | undefined): string[] {
  if (!a) return []
  return a.services
    .filter((s) => s.types.some((t) => (SUBSCRIPTION_TYPES as readonly string[]).includes(t)))
    .map((s) => s.service)
}

/**
 * レンタル・購入で観られるサービス。見放題とは**別に**出す。
 * 「観られる」の意味が違うので、まとめて1つにしない。
 */
export function paidServices(a: WorkAvailability | undefined): string[] {
  if (!a) return []
  return a.services
    .filter((s) => s.types.some((t) => t === 'rent' || t === 'buy'))
    .map((s) => s.service)
}
