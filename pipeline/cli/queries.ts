/**
 * Search Console から「どのページに、どの検索語で来ているか」を取り込む。
 *
 *   npm run queries                  直近28日ぶんを取り込む
 *   npm run queries -- --days 90     期間を変える
 *   npm run queries -- --dry-run     取得して表示するだけ（何も書かない）
 *   npm run queries -- --sites       **権限のあるプロパティを一覧する（設定の切り分け用）**
 *
 * ■ 何のためにあるか
 * サイトのAmazon導線は「そのページが扱っている作品」を検索語に使っている。
 * だが**ページの題材と、読者が実際に打った言葉はずれる**。
 * ずれの実測値を持っているのは Search Console だけなので、そこから取る。
 * 使い道はサイト側の src/lib/page-intent.ts（CTAと追従枠の検索語）。
 *
 * ■ なぜ「訪問時」ではなく「ビルド時」なのか
 * **検索エンジンは検索語をリファラに渡さない。** Google も Yahoo! も
 * HTTPS化以降 `Referrer-Policy: strict-origin-when-cross-origin` 相当で、
 * ブラウザが渡すのは `https://www.google.com/` というオリジンだけ。
 * 「いま来たこの人が何で検索したか」は原理的に取れない。
 * 取れるのは**URL単位の統計**で、それをビルド時に焼き込むのが唯一の形になる。
 *
 * ■ 認証（サービスアカウント）
 * ブラウザを開く OAuth フローは CI で回らないので、サービスアカウントを使う。
 *   1. Google Cloud でプロジェクトを作り、Search Console API を有効化する
 *   2. サービスアカウントを作り、JSONキーをダウンロードする
 *   3. **Search Console の設定 → ユーザーと権限**で、そのサービスアカウントの
 *      メールアドレス（`…@….iam.gserviceaccount.com`）を「制限付き」で追加する
 *      → **これを忘れると 403 になる。** APIを有効化しただけでは読めない
 *   4. .env に GSC_SITE_URL と GSC_SERVICE_ACCOUNT を書く
 *
 * ★ 依存を増やさないため、JWT の署名は node:crypto で自前で組んでいる
 *   （googleapis を入れると依存が数十パッケージ増える）。
 *   やっていることは「RS256でJWTを作ってアクセストークンと交換する」だけ。
 *
 * ■ データが無い時期がある
 * Search Console は**反映まで2〜3日**かかり、公開直後のサイトは
 * そもそも行が返らない。0件は異常ではないので、**失敗にはしない。**
 * 既存のファイルも壊さない（0件のときは上書きしない）。
 */
import { createSign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かない（環境変数で渡す）
}

/** 出力先。サイト側は src/lib/page-intent.ts がこれを読む。 */
const OUT = resolve('data/search-queries.json')

/** 1ページあたり何本の検索語を残すか。CTAが使うのは1本目だけだが、後から見直せるように少し持つ。 */
const KEEP_PER_PAGE = 5

/** APIの1回あたり上限（Search Console の仕様上の最大） */
const ROW_LIMIT = 25_000

/** 既定の集計期間（日）。短すぎると母数が足りず、長すぎると古い作品に引っぱられる。 */
const DEFAULT_DAYS = 28

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

interface ServiceAccount {
  client_email: string
  private_key: string
}

export interface PageQuery {
  query: string
  clicks: number
  impressions: number
  position: number
}

export interface SearchQueries {
  fetchedAt: string
  range: { start: string; end: string }
  /** サイト内のパス（`/posts/xxx`）→ 検索語。クリック数の多い順 */
  pages: Record<string, PageQuery[]>
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/**
 * サービスアカウントのJSONでアクセストークンを取る。
 *
 * ★ private_key は .env 経由だと `\n` が文字列のまま入りがち。
 *   ファイルパスで渡す前提にしてあるのはそのため。
 */
async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claim}`)
  const signature = signer.sign(sa.private_key, 'base64url')
  const assertion = `${header}.${claim}.${signature}`

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  if (!res.ok) {
    throw new Error(`トークンの取得に失敗しました (${res.status}): ${await res.text()}`)
  }
  const json = (await res.json()) as { access_token?: string }
  if (!json.access_token) throw new Error('トークンが返りませんでした')
  return json.access_token
}

/**
 * このサービスアカウントが読めるプロパティを一覧する。**設定の切り分け用。**
 *
 * ■ なぜ要るか
 * `searchAnalytics/query` は、プロパティ名が違うときも、権限が無いときも
 * **同じ 403 を返す**（存在しないプロパティと権限の無いプロパティを
 * 区別できないようにするため）。エラーだけでは次の一手が決まらない。
 *
 *   一覧が空       … サービスアカウントが Search Console に追加されていない
 *   一覧に出るのに403 … GSC_SITE_URL の表記が違う（**出てきた文字列をそのまま使う**）
 *
 * ★ `sc-domain:example.com` と `https://example.com/` は**別のプロパティ**。
 *   見た目が同じサイトでも、登録した種類によって文字列が変わる。
 */
async function listSites(token: string): Promise<{ siteUrl: string; permissionLevel: string }[]> {
  const res = await fetch('https://searchconsole.googleapis.com/webmasters/v3/sites', {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`プロパティ一覧の取得に失敗 (${res.status}): ${await res.text()}`)
  const json = (await res.json()) as {
    siteEntry?: { siteUrl: string; permissionLevel: string }[]
  }
  return json.siteEntry ?? []
}

interface ApiRow {
  keys: string[]
  clicks: number
  impressions: number
  position: number
}

/** 1ページぶん取る。25,000行を超える場合は startRow をずらして続ける。 */
async function fetchRows(
  token: string,
  siteUrl: string,
  start: string,
  end: string
): Promise<ApiRow[]> {
  const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    siteUrl
  )}/searchAnalytics/query`

  const out: ApiRow[] = []
  for (let startRow = 0; ; startRow += ROW_LIMIT) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        startDate: start,
        endDate: end,
        // ★ この2つの組み合わせでしか「ページ×検索語」は取れない。
        //   管理画面のCSVエクスポートはページと検索語が別々の表なので使えない。
        dimensions: ['page', 'query'],
        type: 'web',
        rowLimit: ROW_LIMIT,
        startRow,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      if (res.status === 403) {
        throw new Error(
          `403。**Search Console の「ユーザーと権限」にサービスアカウントを追加しましたか。**\n` +
            `APIを有効化しただけでは読めません。\n${body}`
        )
      }
      throw new Error(`Search Console API が ${res.status} を返しました: ${body}`)
    }
    const json = (await res.json()) as { rows?: ApiRow[] }
    const rows = json.rows ?? []
    out.push(...rows)
    if (rows.length < ROW_LIMIT) break
  }
  return out
}

/** 絶対URL → サイト内のパス。`/posts/xxx`（末尾スラッシュなし）に揃える。 */
function pathOf(url: string): string | null {
  try {
    const p = new URL(url).pathname
    return p === '/' ? '/' : p.replace(/\.html$/, '').replace(/\/$/, '')
  } catch {
    return null
  }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

async function main(): Promise<void> {
  const siteUrl = process.env.GSC_SITE_URL
  const keyPath = process.env.GSC_SERVICE_ACCOUNT

  if (!siteUrl || !keyPath) {
    console.log('GSC_SITE_URL と GSC_SERVICE_ACCOUNT が未設定です。何もしません。')
    console.log('  GSC_SITE_URL=sc-domain:mihoudairader.com')
    console.log('  GSC_SERVICE_ACCOUNT=./secrets/gsc.json')
    console.log('設定手順はこのファイルの冒頭と docs/AFFILIATE.md。')
    return
  }
  if (!existsSync(keyPath)) {
    console.error(`サービスアカウントのJSONが見つかりません: ${keyPath}`)
    process.exitCode = 1
    return
  }

  const days = Number(arg('days') ?? DEFAULT_DAYS)
  // ★ Search Console のデータは2〜3日遅れる。終端を「今日」にすると
  //   必ず空の日を含むので、3日前で切る。
  const end = new Date(Date.now() - 3 * 86_400_000)
  const start = new Date(end.getTime() - days * 86_400_000)

  const sa = JSON.parse(readFileSync(keyPath, 'utf8')) as ServiceAccount
  const token = await accessToken(sa)

  if (has('sites')) {
    const sites = await listSites(token)
    console.log(`サービスアカウント: ${sa.client_email}`)
    if (sites.length === 0) {
      console.log('')
      console.log('読めるプロパティが**0件**です。')
      console.log('Search Console → 設定 → ユーザーと権限 → ユーザーを追加 で、')
      console.log(`上のメールアドレスを「制限付き」で追加してください。`)
      console.log('（APIを有効化しただけでは読めません）')
      return
    }
    console.log(`読めるプロパティ ${sites.length}件:`)
    for (const s of sites) console.log(`  ${s.siteUrl}  (${s.permissionLevel})`)
    console.log('')
    console.log(`いまの GSC_SITE_URL: ${siteUrl}`)
    console.log(
      sites.some((s) => s.siteUrl === siteUrl)
        ? '→ 一致しています。'
        : '→ **一致しません。** 上の一覧の文字列をそのまま .env に書いてください。',
    )
    return
  }

  const rows = await fetchRows(token, siteUrl, ymd(start), ymd(end))

  console.log(`${rows.length}行 取得（${ymd(start)} 〜 ${ymd(end)}）`)
  if (rows.length === 0) {
    console.log('0件でした。公開直後なら正常です（反映まで数日かかります）。')
    console.log('既存のファイルは触りません。')
    return
  }

  const pages: Record<string, PageQuery[]> = {}
  for (const r of rows) {
    const [page, query] = r.keys
    const path = pathOf(page ?? '')
    if (!path || !query) continue
    ;(pages[path] ??= []).push({
      query,
      clicks: r.clicks,
      impressions: r.impressions,
      position: Math.round(r.position * 10) / 10,
    })
  }

  // クリックの多い順。同数なら表示回数の多い順。
  for (const [path, list] of Object.entries(pages)) {
    pages[path] = list
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
      .slice(0, KEEP_PER_PAGE)
  }

  const data: SearchQueries = {
    fetchedAt: new Date().toISOString(),
    range: { start: ymd(start), end: ymd(end) },
    pages,
  }

  const count = Object.keys(pages).length
  if (has('dry-run')) {
    console.log(`--dry-run のため書きません。${count}ページぶん。`)
    for (const [path, qs] of Object.entries(pages).slice(0, 10)) {
      console.log(`  ${path}\n    ${qs.map((q) => `${q.query} (${q.clicks})`).join(' / ')}`)
    }
    return
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  console.log(`${count}ページぶんを ${OUT} に書きました。`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
