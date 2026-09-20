/**
 * 作品画像の署名付きURLを取り直す。
 *
 *   npm run refresh:images                 今月ぶんだけ（期限の近い順に平準化）
 *   npm run refresh:images -- --within 200 期限が200日以内のものを対象に含める
 *   npm run refresh:images -- --limit 40   今月の上限を手で決める
 *   npm run refresh:images -- --dry-run    APIを叩かず対象だけ出す
 *   npm run refresh:images -- --all        台帳の全件を対象に含める（上限は効く）
 *
 * ■ 何のための取り直しか（2026-09-20 に位置づけが変わった）
 * 画像URLは署名付きで、6〜12ヶ月で失効する。**しかし失効しても掲載は続けられる。**
 * 規約の変更により、取得済みの画像は**手元に持ったまま使い続けてよい**
 * （現行規約6節 "may cache and store … for as long as required by the functional needs"。
 * 2026-09-20 に原文で確認した。それまでは 2026-08-25 の回答文にあった
 * 「最低でも6ヶ月ごとに取り直すこと」の**推奨**に従い、180日で必ず取り直していた。
 * 推奨であって規約上の義務ではなかった）。
 * `site/scripts/posters.mjs` も、署名が切れた作品は手元の原本を出し続ける。
 *
 * したがって取り直しは**義務ではなく、まだ手元に絵が無い環境のための保険**になった。
 *   - Cloudflare のビルドキャッシュが消えた回
 *   - `actions/cache` が流れた回
 *   - 新しく出てきた作品
 * この3つで「手元に原本が無く、URLも切れている」が重なったときだけ、
 * その作品が汎用画像に戻る。**戻っても記事は壊れない。**
 *
 * ■ なぜ平準化するのか
 * 台帳は 2026-09-20 時点で **1,800件**あり、**180日以内に457件が失効する。**
 * 1作品1リクエストなので、そのまま流すと **457回＝無料枠(500/月)の91%**が消える。
 * 以前の既定（`--within 90` ＋ 1回300件）は**「1回」の蓋であって「1か月」の蓋ではなく**、
 * 同じ月に二度流せば枠を使い切れた。
 *
 * いまは **月の予算**で止める。予算は「残り枠 − 月末までの定期実行ぶん」から出し、
 * 台帳の `refreshedAt` を数えて**今月すでに流したぶんを差し引く**ので、
 * 何度呼んでも月の合計は超えない。
 *
 * ■ 対象を絞る理由（従来どおり）
 * 収集済みの作品は1,000件を超えるが、対象は**サイトが実際に使っている作品だけ**。
 * その一覧は `npm run sections`（ビルド時に自動で走る）が
 * `data/image-manifest.json` に書き出している。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadTheme } from '../theme.ts'
import { StreamingAvailabilitySource } from '../sources/streaming-availability.ts'
import { addUsage, monthlyPlan } from '../core/api-usage.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かず、環境変数を直接渡す
}

const MANIFEST_PATH = join('data', 'image-manifest.json')

/**
 * 既定の取り直し範囲（日）。
 * 失効しても掲載は続くので「切羽詰まったもの」ではなく「そろそろのもの」を拾う幅。
 */
const DEFAULT_WITHIN_DAYS = 90

/**
 * 月に取り直す件数の**上限**。
 *
 * 予算（残り枠 − 定期実行の予約）がこれより多くても、ここで止める。
 * 予約の見積もりは概算なので、**丸ごと使い切る権利までは渡さない。**
 * 1,800件を年2回回すなら月150件で足りる計算だが、そこまで要らなくなった
 * （失効しても掲載が続くため）ので、手作業の枠を優先して低めに置く。
 */
const MONTHLY_CAP = 80

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

/**
 * 今月すでに取り直した件数。
 *
 * **状態ファイルを増やさずに台帳から数える。** `refreshedAt` は取り直した作品に
 * 必ず入るので、これがそのまま月の実績になる。別ファイルに持つと、
 * 台帳だけ戻したとき（`images` ワークフローは `git checkout -- data/image-manifest.json`
 * をする）に食い違う。
 */
function countRefreshedThisMonth(works: ManifestWork[], offsetMinutes: number): number {
  const month = new Date(Date.now() + offsetMinutes * 60_000).toISOString().slice(0, 7)
  return works.filter((w) => {
    if (!w.refreshedAt) return false
    const at = Date.parse(w.refreshedAt)
    return Number.isFinite(at) && new Date(at + offsetMinutes * 60_000).toISOString().slice(0, 7) === month
  }).length
}

async function main(): Promise<void> {
  const withinDays = Number(arg('within') ?? DEFAULT_WITHIN_DAYS)
  const all = process.argv.includes('--all')
  const dryRun = process.argv.includes('--dry-run')

  const manifest = await loadManifest()
  const works = Object.values(manifest.works)
  if (works.length === 0) {
    console.log('台帳が空です。先に `cd site && npm run sections` を実行してください。')
    return
  }

  const theme = await loadTheme()

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

  /*
   * ここから**月の予算**を決める（2026-09-20）。
   *
   * 以前は「1回あたり300件」という蓋しか無かった。1回の蓋は**同じ月に二度流せば
   * 効かない**ので、月の合計を見る形に変えた。
   *
   *   予算 = min( 残り枠 − 月末までの定期実行ぶん, 月の上限 ) − 今月すでに流したぶん
   *
   * `--limit` はこの予算を**下げる**ためだけに効く。上書きはさせない。
   * 上書きできると、いちばん危ない瞬間（月末・残り少ない）に
   * いちばん大きい数字を渡せてしまう。
   */
  const plan = await monthlyPlan(theme.utc_offset_minutes)
  const doneThisMonth = countRefreshedThisMonth(works, theme.utc_offset_minutes)
  const budget = Math.max(0, Math.min(plan.spare, MONTHLY_CAP) - doneThisMonth)

  const asked = arg('limit') != null ? Number(arg('limit')) : budget
  const limit = Math.min(asked, budget)

  console.log(
    `\n今月の消費 ${plan.used}/${plan.limit}` +
      (plan.tracked ? '' : '（※この月の記録がありません。実際の消費はもっと多い可能性があります）'),
  )
  console.log(`  月末までの定期実行ぶん  ${plan.reserve}回を確保`)
  console.log(`  手作業に回せるぶん      ${plan.spare}回`)
  console.log(`  今月すでに取り直した数  ${doneThisMonth}件（月の上限 ${MONTHLY_CAP}件）`)
  console.log(`  この実行で取り直す      ${Math.min(limit, targets.length)}件`)

  if (dryRun) {
    for (const w of targets.slice(0, 40)) {
      console.log(`  ${(w.expiresAt ?? '期限不明').slice(0, 10)}  ${w.title}`)
    }
    if (targets.length > 40) console.log(`  … ほか ${targets.length - 40}件`)
    console.log('\n--dry-run のためAPIは呼んでいません。')
    return
  }

  if (limit <= 0) {
    /*
     * **止めるが、慌てさせない。** 失効しても掲載は続く（冒頭の注記）。
     * ここで無理に流すと、月末の定期収集が 429 で落ちる。
     */
    console.log(
      '\n今月ぶんは終わっています。翌月にもう一度実行してください。\n' +
        '  ※ 取り直せなくても記事は壊れません。署名が切れた作品も、\n' +
        '     手元に原本があるかぎり掲載は続きます（規約の変更・2026-09-20）。',
    )
    return
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
    console.log(
      `残り ${targets.length - limit}件。` +
        '**翌月**もう一度実行すると続きから取り直します（今月ぶんは使い切りました）。',
    )
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
