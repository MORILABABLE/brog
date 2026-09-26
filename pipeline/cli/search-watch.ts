/**
 * Google 検索の表示が急に落ちていないかを毎日見る。**読むのと Issue を書くだけ。サイトには何も出さない。**
 *
 *   npm run search-watch               判定して、必要なら Issue を立てる／追記する／閉じる
 *   npm run search-watch -- --dry-run  判定と本文を表示するだけ（GitHub に触らない）
 *
 * ■ なぜ要るか（2026-09-26 追加）
 * 2026-09-23 17時（JST）に Google の表示が約9割消えた（1日 約220 → 約40）。**気づいたのは3日後。**
 * `npm run analytics` は GSC の反映待ちで終端を3日前に切るので、崖はそのあいだ見えない。
 * ここは `dataState: 'all'` で取り、GSC が「揃った」と返す日（`firstIncompleteDate` の前日）まで使う。
 *
 * ■ 判定
 *   直近 = 揃った日の最後の2日の表示の平均
 *   基準 = その前の28日の表示の中央値
 *   直近 < 基準 × 0.5 なら「落ちた」
 * ★ 2日にしてあるのは、ふだんの揺れ（1日 135〜276）では2日平均が基準の半分を割らず、
 *   崖なら翌日に当たるため。3日だと 9/23 の崖は 9/26 まで引っかからなかった。
 *
 * ■ Issue の動き（本文の印 `<!-- search-watch baseline=N -->` で見分ける）
 *   開いている監視 Issue が無い × 落ちた         → 立てる（そのときの基準を本文に書き残す）
 *   開いている × まだ戻っていない                → 1日1件コメントで数字を足す
 *   開いている × 直近 ≥ 書き残した基準 × 0.8     → 回復と書いて閉じる
 * ★ **開いているあいだは、書き残した基準で比べる。** 毎日の基準は落ちた日を含み始め、
 *   3週間ほどで「落ちた水準」が基準になる。そのまま比べると、戻っていないのに戻ったと言い出す。
 *
 * ■ 認証
 * queries.ts / analytics.ts と同じサービスアカウント（`webmasters.readonly`）。
 * Issue は Actions の `GITHUB_TOKEN`（permissions: issues: write）。
 */
import { createSign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かない（環境変数で渡す）
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const RECENT_DAYS = 2
const BASELINE_DAYS = 28
const DROP_RATIO = 0.5
const RECOVER_RATIO = 0.8
const MARK = 'search-watch'

interface ServiceAccount {
  client_email: string
  private_key: string
}

interface Day {
  date: string
  clicks: number
  impressions: number
}

const dryRun = process.argv.includes('--dry-run')
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (date: string, n: number) => ymd(new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000))
const b64 = (i: string) => Buffer.from(i).toString('base64url')

async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claim}`)
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signer.sign(sa.private_key, 'base64url')}`,
    }),
  })
  if (!res.ok) throw new Error(`トークンの取得に失敗しました (${res.status}): ${await res.text()}`)
  const json = (await res.json()) as { access_token?: string }
  if (!json.access_token) throw new Error('トークンが返りませんでした')
  return json.access_token
}

/**
 * 日別の表示とクリック。**揃った日だけを返す。**
 * ★ GSC は表示0の日を行ごと返さないので、揃った日の範囲で0を埋める。
 */
async function fetchDays(token: string, site: string): Promise<Day[]> {
  const end = ymd(new Date())
  const start = addDays(end, -(RECENT_DAYS + BASELINE_DAYS + 7))
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: start, endDate: end, dimensions: ['date'], type: 'web', dataState: 'all' }),
    }
  )
  if (!res.ok) throw new Error(`Search Console API が ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as {
    rows?: { keys: string[]; clicks: number; impressions: number }[]
    metadata?: { firstIncompleteDate?: string }
  }
  // ★ 印が無いときは2日前までを揃ったとみなす（GSC の通常の遅れ）。
  const lastComplete = addDays(json.metadata?.firstIncompleteDate ?? addDays(end, -1), -1)
  const byDate = new Map((json.rows ?? []).map((r) => [r.keys[0]!, r]))
  const first = json.rows?.[0]?.keys[0]
  if (!first) return []

  const out: Day[] = []
  for (let d = first; d <= lastComplete; d = addDays(d, 1)) {
    const r = byDate.get(d)
    out.push({ date: d, clicks: r?.clicks ?? 0, impressions: r?.impressions ?? 0 })
  }
  return out
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function table(days: Day[]): string {
  return [
    '| 日付（米国太平洋時間） | 表示 | クリック |',
    '|---|---:|---:|',
    ...days.map((d) => `| ${d.date} | ${d.impressions} | ${d.clicks} |`),
  ].join('\n')
}

// --- GitHub Issue ----------------------------------------------------------------

interface Issue {
  number: number
  body: string | null
  html_url: string
  pull_request?: unknown
}

async function gh(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const repo = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  if (!repo || !token) {
    throw new Error('GITHUB_REPOSITORY と GITHUB_TOKEN が要ります。手元で見るだけなら --dry-run')
  }
  const res = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repo}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      // GitHub API は User-Agent が無いと 403 を返す
      'user-agent': 'brog-search-watch',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!res.ok) throw new Error(`GitHub API ${path} が ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

async function openWatchIssue(): Promise<{ issue: Issue; baseline: number } | undefined> {
  const issues = (await gh('/issues?state=open&per_page=100')) as Issue[]
  for (const issue of issues) {
    if (issue.pull_request) continue
    const m = new RegExp(`<!-- ${MARK} baseline=([\\d.]+) -->`).exec(issue.body ?? '')
    if (m) return { issue, baseline: Number(m[1]) }
  }
  return undefined
}

// --- 本体 ----------------------------------------------------------------------

async function main(): Promise<void> {
  const site = process.env.GSC_SITE_URL
  const keyPath = process.env.GSC_SERVICE_ACCOUNT
  if (!site || !keyPath || !existsSync(keyPath)) {
    throw new Error('GSC_SITE_URL と GSC_SERVICE_ACCOUNT（鍵のJSONのパス）が要ります。設定は .env.example')
  }
  const sa = JSON.parse(readFileSync(keyPath, 'utf8')) as ServiceAccount
  const days = await fetchDays(await accessToken(sa), site)

  const recentDays = days.slice(-RECENT_DAYS)
  const baseDays = days.slice(-(RECENT_DAYS + BASELINE_DAYS), -RECENT_DAYS)
  if (recentDays.length < RECENT_DAYS || baseDays.length < 14) {
    console.log(`揃った日が足りません（${days.length}日）。判定しません。`)
    return
  }
  const recent = recentDays.reduce((s, d) => s + d.impressions, 0) / RECENT_DAYS
  const baseline = median(baseDays.map((d) => d.impressions))
  const last = recentDays.at(-1)!.date
  const recentTable = table(days.slice(-7))

  console.log(`揃っている最後の日: ${last}`)
  console.log(`直近${RECENT_DAYS}日の表示 平均 ${recent.toFixed(1)} ／ その前${baseDays.length}日の中央値 ${baseline}`)
  console.log(recentTable)

  const mention = process.env.NOTIFY_MENTION?.replace(/^@/, '').trim()
  const cc = mention ? `\n\ncc @${mention}` : ''
  const open = dryRun ? undefined : await openWatchIssue()

  if (!open) {
    if (recent >= baseline * DROP_RATIO) {
      console.log('→ 平常（基準の半分を割っていない）')
      return
    }
    const subject = `【検索流入】Google の表示が基準の${Math.round((recent / baseline) * 100)}%に落ちています（${last} まで）`
    const body = [
      `直近${RECENT_DAYS}日の表示の平均が **${recent.toFixed(1)}**、その前${baseDays.length}日の中央値が **${baseline}** です。`,
      '',
      recentTable,
      '',
      '**最初に見るところ**（Search Console の画面。API では見えない）',
      '- [ ] セキュリティと手動による対策 → 手動による対策',
      '- [ ] セキュリティと手動による対策 → セキュリティの問題',
      '- [ ] インデックス作成 → 削除（3つのタブ）',
      '',
      '3つとも問題なしならアルゴリズムによる評価です。前回（2026-09-23）の調べ方と結論は docs/INDEXING.md の末尾。',
      '',
      `この Issue は開いているあいだ毎日数字を追記し、直近の表示が ${Math.round(baseline * RECOVER_RATIO)}（基準の${RECOVER_RATIO * 100}%）に戻ったら自動で閉じます。`,
      '',
      `<!-- ${MARK} baseline=${baseline} -->${cc}`,
    ].join('\n')
    if (dryRun) {
      console.log(`\n[dry-run] Issue を立てます\n${subject}\n\n${body}`)
      return
    }
    const created = (await gh('/issues', { method: 'POST', body: { title: subject, body } })) as Issue
    console.log(`Issue を立てました: ${created.html_url}`)
    return
  }

  const { issue, baseline: kept } = open
  if (recent >= kept * RECOVER_RATIO) {
    await gh(`/issues/${issue.number}/comments`, {
      method: 'POST',
      body: {
        body: `**回復しました。** 直近${RECENT_DAYS}日の表示の平均 ${recent.toFixed(1)}（落ちる前の基準 ${kept} の${Math.round((recent / kept) * 100)}%）。\n\n${recentTable}${cc}`,
      },
    })
    await gh(`/issues/${issue.number}`, { method: 'PATCH', body: { state: 'closed' } })
    console.log(`→ 回復。Issue を閉じました: ${issue.html_url}`)
    return
  }

  // ★ 1日1件。同じ「揃った最後の日」のコメントが既にあれば足さない（手で再実行した日の重複よけ）。
  const comments = (await gh(`/issues/${issue.number}/comments?per_page=100`)) as { body: string }[]
  if (comments.some((c) => c.body.includes(`<!-- ${MARK} day=${last} -->`))) {
    console.log(`→ ${last} のぶんは追記済み`)
    return
  }
  await gh(`/issues/${issue.number}/comments`, {
    method: 'POST',
    body: {
      body: `${last} まで。直近${RECENT_DAYS}日の表示の平均 ${recent.toFixed(1)}（落ちる前の基準 ${kept} の${Math.round((recent / kept) * 100)}%）。\n\n${recentTable}\n\n<!-- ${MARK} day=${last} -->`,
    },
  })
  console.log(`→ まだ戻っていない。Issue に追記しました: ${issue.html_url}`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
