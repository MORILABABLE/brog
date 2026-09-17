/**
 * サジェスト調査の画面に重ねる、**自分のサイトの Search Console 実績**（読み取りだけ）。
 *
 * ■ 取得元は2つ。上から順に試す
 *   1. Search Console API … `.env` の GSC_SITE_URL / GSC_SERVICE_ACCOUNT（`npm run queries` と同じ設定）
 *   2. `data/analytics.json` … `npm run analytics -- --write` が落とした手元の控え（API が使えないとき）
 *
 * ■ 認証は `pipeline/cli/queries.ts` / `analytics.ts` と同じ作り
 * あちらの `accessToken()` は CLI の中に閉じていて、import すると CLI 本体が走る。
 * スピンアウトツールの側から本体の CLI を組み替えないため、ここに同じ手順を持つ。
 * （RS256 の JWT を node:crypto で組み、アクセストークンと交換するだけ）
 *
 * ★ **ディスクに何も書かない。** このリポジトリは公開で、`data/analytics.json` を
 *   .gitignore しているのと同じ理由（表示回数の実数を公開しない）。
 *   取ったものはサーバーのメモリにだけ置き、127.0.0.1 の画面にだけ返す。
 *
 * ★ **個別に返る検索語は全体の一部だけ。** 件数の少ない語は Google が匿名化して返さない
 *   （2026-09-16 の実測で表示の約23%しか語が分からない）。「実績なし」は「検索されていない」ではない。
 */
import { createSign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ROW_LIMIT = 25_000
const ANALYTICS_PATH = resolve('data/analytics.json')

export interface GscQueryRow {
  query: string
  clicks: number
  impressions: number
  position: number
}

export interface GscSnapshot {
  source: 'api' | 'file'
  siteUrl: string
  range: { start: string; end: string }
  fetchedAt: string
  /** サイト全体の表示回数（匿名化されたぶんも含む）。分かるときだけ */
  totalImpressions?: number
  rows: GscQueryRow[]
}

interface ServiceAccount {
  client_email: string
  private_key: string
}

const ymd = (d: Date) => d.toISOString().slice(0, 10)

let token: { value: string; expiresAt: number } | undefined

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (token && Date.now() < token.expiresAt) return token.value
  const now = Math.floor(Date.now() / 1000)
  const b64 = (s: string) => Buffer.from(s).toString('base64url')
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claim}`)
  const assertion = `${header}.${claim}.${signer.sign(sa.private_key, 'base64url')}`

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  if (!res.ok) throw new Error(`トークンの取得に失敗しました (${res.status})`)
  const json = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!json.access_token) throw new Error('トークンが返りませんでした')
  // 期限の少し前に取り直す
  token = { value: json.access_token, expiresAt: Date.now() + ((json.expires_in ?? 3600) - 300) * 1000 }
  return token.value
}

interface ApiRow {
  keys?: string[]
  clicks: number
  impressions: number
  position: number
}

async function query(accessToken: string, siteUrl: string, body: Record<string, unknown>): Promise<ApiRow[]> {
  const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'web', ...body }),
  })
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error('Search Console が 403。切り分けは npm run queries -- --sites')
    }
    throw new Error(`Search Console API が ${res.status} を返しました`)
  }
  return ((await res.json()) as { rows?: ApiRow[] }).rows ?? []
}

/** API から「検索語ごと」の実績を取る。設定が無ければ理由つきで投げる */
export async function fetchFromApi(days: number): Promise<GscSnapshot> {
  const siteUrl = process.env.GSC_SITE_URL
  const keyPath = process.env.GSC_SERVICE_ACCOUNT
  if (!siteUrl || !keyPath) throw new Error('.env に GSC_SITE_URL と GSC_SERVICE_ACCOUNT がありません')
  if (!existsSync(keyPath)) throw new Error(`サービスアカウントのJSONが見つかりません: ${keyPath}`)

  const sa = JSON.parse(readFileSync(keyPath, 'utf8')) as ServiceAccount
  const accessTokenValue = await accessToken(sa)

  // ★ 反映が2〜3日遅れる。終端を今日にすると必ず空の日が入る（queries.ts と同じ）
  const end = new Date(Date.now() - 3 * 86_400_000)
  const start = new Date(end.getTime() - (days - 1) * 86_400_000)
  const range = { start: ymd(start), end: ymd(end) }

  const [total] = await query(accessTokenValue, siteUrl, { startDate: range.start, endDate: range.end, dimensions: [] })
  const rows: GscQueryRow[] = []
  for (let startRow = 0; ; startRow += ROW_LIMIT) {
    const page = await query(accessTokenValue, siteUrl, {
      startDate: range.start,
      endDate: range.end,
      dimensions: ['query'],
      rowLimit: ROW_LIMIT,
      startRow,
    })
    for (const r of page) {
      rows.push({ query: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions, position: r.position })
    }
    if (page.length < ROW_LIMIT) break
  }

  return {
    source: 'api',
    siteUrl,
    range,
    fetchedAt: new Date().toISOString(),
    totalImpressions: total?.impressions,
    rows,
  }
}

/** `npm run analytics -- --write` の控えから読む。期間は控えを取ったときのまま */
export function readFromFile(): GscSnapshot {
  if (!existsSync(ANALYTICS_PATH)) {
    throw new Error('data/analytics.json がありません（npm run analytics -- --write で作れます）')
  }
  const json = JSON.parse(readFileSync(ANALYTICS_PATH, 'utf8')) as {
    fetchedAt?: string
    site?: string
    range?: { start: string; end: string }
    gsc?: { total?: { impressions?: number }; byQuery?: ApiRow[] }
  }
  const byQuery = json.gsc?.byQuery
  if (!byQuery || !json.range) throw new Error('data/analytics.json に検索語ごとの行がありません')
  return {
    source: 'file',
    siteUrl: json.site ?? '',
    range: json.range,
    fetchedAt: json.fetchedAt ?? '',
    totalImpressions: json.gsc?.total?.impressions,
    rows: byQuery.map((r) => ({
      query: r.keys?.[0] ?? '',
      clicks: r.clicks,
      impressions: r.impressions,
      position: r.position,
    })),
  }
}
