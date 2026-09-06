/**
 * これから書く記事の作品について、**いまどこで観られるか**を取る。
 *
 *   npm run write -- --type series --topic "「◯◯」シリーズ" --slug x --match ◯◯ --emit
 *   npm run availability                ← ここで在庫を取る
 *   npm run write -- ... --emit         ← もう一度出すと、素材に在庫が入る
 *
 *   npm run availability -- --dry-run   取って表示するだけ（**枠は消費する**）
 *   npm run availability -- --keyword "Harry Potter"   下書きを使わず直接
 *
 * ■ なぜ `--emit` のあとなのか
 * **調べる対象は「その記事に載る作品」だけでよい。**
 * `--emit` が `data/draft/context.json` に確定した作品リストを書いているので、
 * それを読めば選び方を二重に持たずに済む（`npm run research` と同じ流れ）。
 *
 * ■ 何を取るのか
 * `/shows/search/filters` の `streamingOptions.jp[]` ＝ **その時点の在庫**。
 * `/changes`（変化の観測）とは根拠が違うので、置き場所も分けてある
 * （`data/availability.json`。core/availability.ts の冒頭）。
 *
 * ■ 枠の消費
 * **1キーワード＝1〜3リクエスト**（ページングした場合）。無料枠は500/月。
 * 実測（2026-09-06）で `keyword=Harry Potter` が **8作品を1リクエスト**で返した。
 * 作品ごとに `/shows/{id}` を叩くと559リクエストになって枠を超えるので、
 * **キーワードでまとめて取るのがこの施策の前提**（docs/CROSS-SERVICE.md 9-4）。
 *
 * ★ **キーワードは記事の主題から作る。** `--topic "「ハリー・ポッター」シリーズ"`
 *   のような日本語の主題からは当たらないことがある（APIの題名は英語）。
 *   当たらなければ `--keyword` で原題を渡すこと。**推測で日本語を投げ続けない。**
 *
 * ★ **取れなかった作品を「無い」と書かせない。** 台帳に載らなかった作品は
 *   `data/availability.json` に現れない ＝ 記事側は「分からない」として扱う。
 *   0件と未取得を混同すると、**在庫が無いと断定する記事**ができる。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadTheme } from '../theme.ts'
import { StreamingAvailabilitySource } from '../sources/streaming-availability.ts'
import { addUsage } from '../core/api-usage.ts'
import {
  AVAILABILITY_PATH,
  loadAvailability,
  saveAvailability,
  isFresh,
  type WorkAvailability,
} from '../core/availability.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かない
}

const CONTEXT_PATH = join('data', 'draft', 'context.json')

interface DraftContext {
  typeId?: string
  flags?: Record<string, string>
  items?: { work?: { id?: string | number; title?: string; localizedTitle?: string } }[]
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(`--${name}`)

/**
 * U-NEXT 由来の作品か。**IDの体系が配信APIと違う**（`SID0240341` の形）。
 *
 * ★ この作品はキーワード検索でも**絶対に一致しない。**
 *   IDが別体系なうえ、[GROWTH 2-3](../../docs/GROWTH.md) で
 *   U-NEXT をカタログとして扱わないと決めてある。
 *   「取れなかった」に数えると、毎回必ず失敗が出て警告が意味を失う。
 */
function isUnextWork(id: string): boolean {
  return /^SID/i.test(id)
}

/**
 * 記事の下書きから検索キーワードを決める。
 *
 * ★ **ラテン文字の題だけを使う。** APIの `keyword` は英語の題に当たる。
 *   素材の `title` は配信API由来なら原題（英語）だが、
 *   **U-NEXT 由来の作品は最初から邦題**で、原題を持たない。
 *   混ぜると日本語を投げて0件になる（2026-09-06 に1リクエスト無駄にした）。
 *
 * ★ 原題から**共通の頭**を取る。シリーズは
 *   「Harry Potter and the ...」のように前方が揃うため。
 *
 * ★ **決まらなければ undefined を返す。** 当てずっぽうで投げない。
 *   1回の失敗が無料枠を1つ食う。呼び出し側が `--keyword` を促す。
 */
function keywordFrom(items: DraftContext['items']): string | undefined {
  const titles = (items ?? [])
    .filter((e) => e.work?.id == null || !isUnextWork(String(e.work.id)))
    .map((e) => e.work?.title)
    // ラテン文字を半分以上含む題だけ（日本語の題を除く）
    .filter((t): t is string => !!t && (t.match(/[A-Za-z]/g)?.length ?? 0) >= t.length / 2)
  if (titles.length === 0) return undefined
  if (titles.length === 1) return titles[0]

  const words = titles.map((t) => t.split(/\s+/))
  const head: string[] = []
  for (let i = 0; i < words[0]!.length; i++) {
    const w = words[0]![i]!
    if (!words.every((ws) => ws[i]?.toLowerCase() === w.toLowerCase())) break
    head.push(w)
  }
  // 1語だけの共通頭（"The" など）は当たりが広すぎるので使わない
  return head.length >= 2 ? head.join(' ') : titles[0]
}

async function main(): Promise<void> {
  const theme = await loadTheme()
  const apiKey = process.env.STREAMING_API_KEY
  if (!apiKey) {
    console.error('STREAMING_API_KEY が未設定です。.env を確認してください。')
    process.exitCode = 1
    return
  }

  let ctx: DraftContext = {}
  try {
    ctx = JSON.parse(await readFile(CONTEXT_PATH, 'utf8')) as DraftContext
  } catch {
    // --keyword を直接渡す使い方なら下書きは要らない
  }

  const keyword = arg('keyword') ?? keywordFrom(ctx.items)
  if (!keyword) {
    console.log('検索キーワードが決まりません。**投げずに止めます**（1回の失敗が枠を1つ食うため）。')
    console.log('  先に  npm run write -- ... --emit  を走らせるか、')
    console.log('  原題を  --keyword "Harry Potter"  のように渡してください。')
    console.log('  ★ APIの題名は英語です。日本語の主題からは当たりません。')
    return
  }

  const ledger = await loadAvailability()
  const wanted = new Map<string, string>()
  for (const e of ctx.items ?? []) {
    const id = e.work?.id
    if (id == null) continue
    // ★ U-NEXT 由来は最初から対象外。IDの体系が違い、絶対に一致しない。
    if (isUnextWork(String(id))) continue
    wanted.set(String(id), e.work?.localizedTitle ?? e.work?.title ?? '')
  }

  // ★ すでに新しい在庫を持っている作品しか無いなら、叩かない。**枠を守る。**
  const stale = [...wanted.keys()].filter((id) => !isFresh(ledger.works[id]))
  if (wanted.size > 0 && stale.length === 0) {
    console.log(`下書きの${wanted.size}作品はすべて新しい在庫を持っています。取得しません。`)
    console.log(`（${AVAILABILITY_PATH} / 有効期限は core/availability.ts の MAX_AGE_DAYS）`)
    return
  }

  console.log(`キーワード: ${keyword}`)
  if (wanted.size > 0) console.log(`下書きの作品: ${wanted.size}件（うち要取得 ${stale.length}件）`)

  const source = new StreamingAvailabilitySource(apiKey, theme)
  const found = await source.fetchAvailability(keyword)
  const fetchedAt = new Date().toISOString()

  console.log(`APIが返した作品: ${found.size}件  リクエスト: ${source.requestCount}`)
  console.log('')

  let hit = 0
  for (const [id, row] of found) {
    // 下書きがあるときは、その作品だけを台帳へ入れる。
    // キーワード検索は無関係な作品も返すので、記事に関係ないものまで貯めない。
    if (wanted.size > 0 && !wanted.has(id)) continue
    hit++
    const entry: WorkAvailability = { fetchedAt, services: row.services }
    if (!has('dry-run')) ledger.works[id] = entry
    const subs = row.services.filter((s) => s.types.includes('subscription')).map((s) => s.service)
    const paid = row.services.filter((s) => s.types.includes('rent') || s.types.includes('buy'))
    const addon = row.services.filter((s) => s.types.includes('addon')).map((s) => s.service)
    console.log(`  ${(wanted.get(id) || id).slice(0, 34).padEnd(34)}`)
    console.log(`     見放題: ${subs.join(' / ') || '（なし）'}`)
    if (paid.length) console.log(`     レンタル・購入: ${paid.map((s) => s.service).join(' / ')}`)
    // ★ addon は見放題ではない。**必ず別に出す**（core/availability.ts の「絶対に守ること」）
    if (addon.length) console.log(`     ★別料金チャンネル(addon): ${addon.join(' / ')}`)
  }

  console.log('')
  if (wanted.size > 0) {
    /*
     * ★ **「取れなかった」に、すでに新しい在庫を持っている作品を数えないこと。**
     *   キーワードを分けて2回叩くと（`Harry Potter` → `Fantastic Beasts`）、
     *   2回目の応答に1回目の作品は入らない。それを「取れなかった」と出すと
     *   **毎回7件の偽の警告**が出て、本当の取りこぼしが埋もれる。
     *   見るべきは「**この実行のあと台帳に無いもの**」。
     */
    const missed = [...wanted.keys()].filter((id) => !isFresh(ledger.works[id]))
    console.log(`台帳に入れた: ${hit}件 / 下書き ${wanted.size}件`)
    const already = wanted.size - hit - missed.length
    if (already > 0) console.log(`（${already}件はすでに新しい在庫を持っていました）`)
    if (missed.length > 0) {
      console.log(`**取れなかった: ${missed.length}件** — ${missed.map((id) => wanted.get(id) || id).slice(0, 5).join(' / ')}`)
      console.log('  ★ これらは「在庫が無い」ではなく「分からない」。記事側もそう扱う。')
      console.log('  ★ 別のキーワードで取り直すなら --keyword を渡すこと。')
    }
  }

  if (has('dry-run')) {
    console.log('')
    console.log('--dry-run なので保存しませんでした（**リクエストは消費しています**）。')
    return
  }

  await saveAvailability(ledger)
  await addUsage(source.requestCount, theme.utc_offset_minutes)
  console.log(`→ ${AVAILABILITY_PATH}`)
}

main().catch((e) => {
  console.error(String(e))
  process.exitCode = 1
})
