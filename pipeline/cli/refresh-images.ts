/**
 * 作品画像の署名付きURLを取り直す。
 *
 *   npm run refresh:images                 期限が90日以内に迫ったものだけ
 *   npm run refresh:images -- --within 200 期限が200日以内のもの
 *   npm run refresh:images -- --all        台帳の全件（枠に注意）
 *   npm run refresh:images -- --dry-run    APIを叩かず対象だけ出す
 *
 * ■ なぜ要るか
 * 画像URLは署名付きで、**6〜12ヶ月で失効する**。サイトはビルド時に画像を
 * 取得して自分のドメインから配信しているので（再ホストは提供元の許諾済み・
 * 2026-08-25）、URLが切れると過去記事の画像が取れなくなり、
 * 文字だけのカードに戻ってしまう。
 * 提供元からは「**最低でも6ヶ月ごとに取り直すこと**」を推奨されている。
 *
 * ■ 対象を絞る理由
 * 収集済みの作品は1,000件を超えるが、無料枠は 500リクエスト/月。
 * 全部を取り直すと枠を使い切って収集が止まる。
 * そこで **サイトが実際に使っている作品だけ**を対象にする。
 * その一覧は `npm run sections`（ビルド時に自動で走る）が
 * `data/image-manifest.json` に書き出している。
 *
 * ■ 実行の目安
 * 記事が増えるほど対象も増える。半年に1回、収集の空いている時期に流す。
 * 消費は「対象件数 = リクエスト数」でそのまま読める。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadTheme } from '../theme.ts'
import { StreamingAvailabilitySource } from '../sources/streaming-availability.ts'
import { addUsage, FREE_TIER_LIMIT, readUsage } from '../core/api-usage.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かず、環境変数を直接渡す
}

const MANIFEST_PATH = join('data', 'image-manifest.json')

/** 既定の取り直し範囲（日）。提供元の推奨（6ヶ月ごと）より手前で回すため */
const DEFAULT_WITHIN_DAYS = 90

/** 1回の実行で使うリクエストの上限。無料枠を1回で溶かさないための保険 */
const DEFAULT_LIMIT = 300

interface ManifestWork {
  id: string
  title: string
  url: string
  expiresAt?: string
  backdropUrl?: string
  refreshedAt?: string
}

interface Manifest {
  note?: string
  updatedAt?: string
  works: Record<string, ManifestWork>
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 署名付きURLの `Expires=`（Unix秒）。site/scripts/posters.mjs と同じ読み方。 */
function expiryOf(url: string | undefined): string | undefined {
  const m = /[?&]Expires=(\d+)/.exec(url ?? '')
  if (!m) return undefined
  const ms = Number(m[1]) * 1000
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** ポスターを持たない作品に返る代替画像（題名を書いただけのSVG）か */
function isPlaceholder(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.svg')
  } catch {
    return false
  }
}

async function loadManifest(): Promise<Manifest> {
  try {
    const raw = await readFile(MANIFEST_PATH, 'utf8')
    return { works: {}, ...(JSON.parse(raw) as Partial<Manifest>) } as Manifest
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${MANIFEST_PATH} がありません。\n` +
          '先に `cd site && npm run sections` を実行してください' +
          '（サイトがどの作品の画像を使っているかを書き出します）。',
      )
    }
    throw err
  }
}

async function saveManifest(manifest: Manifest): Promise<void> {
  const body = {
    ...manifest,
    updatedAt: new Date().toISOString(),
    works: Object.fromEntries(
      Object.entries(manifest.works).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  }
  await writeFile(MANIFEST_PATH, JSON.stringify(body, null, 2) + '\n', 'utf8')
}

async function main(): Promise<void> {
  const withinDays = Number(arg('within') ?? DEFAULT_WITHIN_DAYS)
  const limit = Number(arg('limit') ?? DEFAULT_LIMIT)
  const all = process.argv.includes('--all')
  const dryRun = process.argv.includes('--dry-run')

  const manifest = await loadManifest()
  const works = Object.values(manifest.works)
  if (works.length === 0) {
    console.log('台帳が空です。先に `cd site && npm run sections` を実行してください。')
    return
  }

  const deadline = Date.now() + withinDays * 86_400_000
  const targets = works
    .filter((w) => {
      if (all) return true
      // 期限が読めないものは「いつ切れるか分からない」ので取り直す
      const at = w.expiresAt ?? expiryOf(w.url)
      return !at || Date.parse(at) <= deadline
    })
    // 期限の近いものから。上限で打ち切られても危ないものから片付く。
    .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? ''))

  const theme = await loadTheme()
  const soonest = works.map((w) => w.expiresAt).filter(Boolean).sort()[0]

  console.log(`台帳の作品: ${works.length}件（最短の期限 ${soonest?.slice(0, 10) ?? '不明'}）`)
  console.log(
    `取り直す対象: ${targets.length}件` +
      (all ? '（--all）' : `（期限が${withinDays}日以内）`),
  )

  if (targets.length === 0) {
    console.log('\n期限に余裕があります。実行の必要はありません。')
    return
  }

  if (dryRun) {
    for (const w of targets.slice(0, 40)) {
      console.log(`  ${(w.expiresAt ?? '期限不明').slice(0, 10)}  ${w.title}`)
    }
    if (targets.length > 40) console.log(`  … ほか ${targets.length - 40}件`)
    console.log('\n--dry-run のためAPIは呼んでいません。')
    return
  }

  // 残り枠の確認。ここで止めておかないと、途中で 429 になって
  // 「半分だけ新しいURL」という中途半端な台帳が残る。
  const usage = await readUsage(theme.utc_offset_minutes)
  const remaining = FREE_TIER_LIMIT - usage.used
  const planned = Math.min(targets.length, limit)

  console.log(
    `今月の消費 ${usage.used}/${FREE_TIER_LIMIT}` +
      (usage.tracked ? '' : '（※この月の記録がありません。実際の消費はもっと多い可能性があります）'),
  )
  if (planned > remaining) {
    throw new Error(
      `残り枠 ${remaining}回 に対して ${planned}件 を取り直そうとしています。\n` +
        '`--limit <件数>` で分割するか、翌月に回してください。',
    )
  }

  const source = new StreamingAvailabilitySource(process.env.STREAMING_API_KEY ?? '', theme)
  let updated = 0
  let failed = 0

  try {
    for (const w of targets.slice(0, limit)) {
      try {
        const images = await source.fetchImages(w.id)
        // ポスターを持たない作品には「題名を書いただけのSVG」が返る。
        // 載せても読者に何も伝わらないので、無かったものとして扱う
        // （サイト側も同じ判定をしている: site/scripts/posters.mjs の isPlaceholder）。
        if (!images.posterUrl || isPlaceholder(images.posterUrl)) {
          console.warn(`  ! ポスターがありません: ${w.title} (${w.id})`)
          failed++
          continue
        }
        w.url = images.posterUrl
        w.expiresAt = expiryOf(images.posterUrl)
        if (images.backdropUrl) w.backdropUrl = images.backdropUrl
        w.refreshedAt = new Date().toISOString()
        updated++
      } catch (err) {
        // 1件の失敗で全体を止めない。ただし 429 は続けても無駄なので投げ直す。
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('429')) throw err
        console.warn(`  ! ${w.title} (${w.id}): ${message}`)
        failed++
      }
    }
  } finally {
    // 途中で落ちてもリクエストは消費されている。取れたぶんは必ず残す。
    await saveManifest(manifest)
    const after = await addUsage(source.requestCount, theme.utc_offset_minutes)
    console.log(
      `\nAPIリクエスト ${source.requestCount}回  ` +
        `${after.month} の消費 ${after.used}/${after.limit}`,
    )
  }

  console.log(`取り直し ${updated}件${failed ? ` / 失敗 ${failed}件` : ''}`)
  if (targets.length > limit) {
    console.log(`残り ${targets.length - limit}件。もう一度実行すると続きから取り直します。`)
  }
  console.log(
    '\n画像そのものは次のビルドで取り直されます。' +
      '手元で今すぐ反映するなら `cd site && npm run sections -- --refresh`。',
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
