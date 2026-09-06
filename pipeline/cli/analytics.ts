/**
 * GA4 と Search Console を1本のファネルに並べる。**読み取りだけ。何も公開しない。**
 *
 *   npm run analytics                直近28日
 *   npm run analytics -- --days 90   期間を変える
 *   npm run analytics -- --write     data/analytics.json に落とす（.gitignore 済み）
 *
 * ■ なぜ queries.ts と別なのか
 * `queries.ts` は**記事に焼き込む素材**（ページごとの検索語）を取るためのもので、
 * 出力は `data/search-queries.json` → `src/lib/page-intent.ts` に流れる。
 * こちらは**運用の判断材料**で、サイトには1文字も出ない。
 * 混ぜると「素材の取得」が「レポートの都合」で壊れるので、口を分けてある。
 *
 * ■ 何を見るためのものか
 * 読者は次の順に落ちていく。**どの段で落ちているかを1画面で見る。**
 *
 *   検索結果に出る（表示回数）
 *     → クリックされる（CTR・掲載順位）
 *       → セッションになる（GA4）
 *         → 2ページ目を見る（PV/セッション）
 *           → **外部リンクを踏む（ここが収益の入口）**
 *
 * ★ 最後の段は GA4 の拡張計測イベント `click`（`outbound: true`）で取れる。
 *   別途タグを入れる必要はないが、**枠の区別は付かない**（記事末尾のCTAなのか
 *   追従枠なのかが分からない）。枠別が要るなら `data-affiliate` を見る
 *   カスタムイベントを足すこと。docs/FUNNEL.md 5-3。
 *
 * ■ 認証
 * Search Console と同じサービスアカウントを使い回す。**GA4 側にも権限が要る。**
 *   GA4 管理 → プロパティのアクセス管理 → サービスアカウントのメールを「閲覧者」で追加
 * プロパティIDは .env の `GA4_PROPERTY_ID`（管理 → プロパティの詳細 の数字）。
 *
 * ★ スコープが2つ要る（`analytics.readonly` と `webmasters.readonly`）。
 *   JWT はスコープごとに取り直す。使い回すと 403 になる。
 *
 * ■ 数字を鵜呑みにしないための注意
 *   - GSC は**2〜3日遅れる**。終端を3日前で切っている（queries.ts と同じ）
 *   - GA4 の `totalUsers` と GSC の `clicks` は**別の数え方**。突き合わせない
 *   - `hostName` の内訳を必ず見ること。localhost やプレビュー配信が混ざる
 */
import { createSign } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かない（環境変数で渡す）
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const OUT = resolve('data/analytics.json')

/** 既定の集計期間（日）。GSC の反映待ちを引いた実日数はこれより3日短い。 */
const DEFAULT_DAYS = 28

interface ServiceAccount {
  client_email: string
  private_key: string
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(`--${name}`)
const b64 = (i: string) => Buffer.from(i).toString('base64url')
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const n = (v: number, w = 0) => String(v).padStart(w)
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

/** スコープごとにアクセストークンを取る。**使い回さないこと**（スコープ違いで403）。 */
async function accessToken(sa: ServiceAccount, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64(
    JSON.stringify({ iss: sa.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 })
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claim}`)
  const assertion = `${header}.${claim}.${signer.sign(sa.private_key, 'base64url')}`

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  if (!res.ok) throw new Error(`トークンの取得に失敗しました (${res.status}): ${await res.text()}`)
  const json = (await res.json()) as { access_token?: string }
  if (!json.access_token) throw new Error('トークンが返りませんでした')
  return json.access_token
}

interface GscRow {
  keys: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

async function gsc(
  token: string,
  site: string,
  start: string,
  end: string,
  dimensions: string[]
): Promise<GscRow[]> {
  const ep = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    site
  )}/searchAnalytics/query`
  const res = await fetch(ep, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ startDate: start, endDate: end, dimensions, type: 'web', rowLimit: 25_000 }),
  })
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(
        'Search Console が 403。**「ユーザーと権限」にサービスアカウントを追加しましたか。**\n' +
          `切り分けは npm run queries -- --sites\n${await res.text()}`
      )
    }
    throw new Error(`Search Console API が ${res.status}: ${await res.text()}`)
  }
  return ((await res.json()) as { rows?: GscRow[] }).rows ?? []
}

interface Ga4Row {
  dims: string[]
  mets: number[]
}

/**
 * 添字アクセスのヘルパ。**tsconfig が `noUncheckedIndexedAccess` なので、
 * `row.mets[0]` は `number | undefined` になる。**
 * APIが列を返さない状況（権限はあるがデータが0件）でも落ちないように、
 * 「無ければ 0 / 空文字」に倒す。数字が出ないことと落ちることは別の事故。
 */
const dim = (r: Ga4Row, i: number): string => r.dims[i] ?? ''
const met = (r: Ga4Row, i: number): number => r.mets[i] ?? 0

async function ga4(
  token: string,
  property: string,
  start: string,
  end: string,
  dimensions: string[],
  metrics: string[],
  limit = 50,
  extra: Record<string, unknown> = {}
): Promise<Ga4Row[]> {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
        limit,
        ...extra,
      }),
    }
  )
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(
        'GA4 が 403。**GA4 の「プロパティのアクセス管理」にサービスアカウントを\n' +
          `「閲覧者」で追加しましたか。** Search Console の権限とは別物です。\n${await res.text()}`
      )
    }
    throw new Error(`GA4 Data API が ${res.status}: ${await res.text()}`)
  }
  const json = (await res.json()) as {
    rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[]
  }
  return (json.rows ?? []).map((r) => ({
    dims: (r.dimensionValues ?? []).map((v) => v.value),
    mets: (r.metricValues ?? []).map((v) => Number(v.value)),
  }))
}

/** URL → サイト内のパス。GSC は絶対URL、GA4 はパスで返すので揃える。 */
function pathOf(url: string): string {
  try {
    const p = new URL(url).pathname
    return p === '/' ? '/' : p.replace(/\.html$/, '').replace(/\/$/, '')
  } catch {
    return url
  }
}

/** `/works/5346` → `/works/*`。ページの「種類」で束ねる。 */
function kindOf(path: string): string {
  const m = /^\/(works|person|posts|leaving|arrivals|category|service|archive|genre)\b/.exec(path)
  return m ? `/${m[1]}/*` : path
}

/**
 * 掲載順位のバケツ。**11位以下（＝2ページ目）はクリックがほぼ0になる。**
 * 「表示はあるのにクリックが無い」の正体がここで見える。
 */
const BUCKETS: [string, number][] = [
  ['1〜3位  ', 3.5],
  ['4〜10位 ', 10.5],
  ['11〜20位', 20.5],
  ['21位以下', Infinity],
]

/**
 * **本番として数えるホスト名。** これ以外は集計から外す。
 *
 * ■ なぜホスト名で絞るのか（2026-09-06・実測で判明）
 * GA4 の `hostName` には、**このサイトを一度も開いていないヒット**が混ざる。
 * 90日ぶんを見たときの内訳:
 *
 *     mihoudairader.com      161セッション  215PV  エンゲージ 53%   ← 本番
 *     www.mihoudairader.com   20セッション   23PV  エンゲージ 40%   ← **本番。下の★**
 *     localhost               10セッション   42PV （ユーザー1人）  ← 開発機
 *     mitokou.com              8セッション    8PV  エンゲージ  0%   ← **実在しない**
 *
 * `mitokou.com` は旧サイト名（観とこう）の候補ドメインで、**DNS が Cloudflare を
 * 指していない＝このサイトを配信していない**（2026-09-06 に確認）。
 * それでもセッションが立つのは、**測定IDがHTMLに書いてあるので誰でも送れる**ため。
 * 8件すべてが「アメリカ・(direct)・着地は `/`・エンゲージ0・1PV」で揃っており、
 * 実在の読者ではない。
 *
 * ★ **GA4 側では止められない。** これらのヒットはサイトのJSを一度も実行していない
 *   （計測エンドポイントに直接送られている）ので、`ga-disable` も内部トラフィック除外も
 *   効かない。GA4 のデータフィルタにホスト名の条件は無い。
 *   **レポートの側で外すしかない。それをここでやっている。**
 *
 * ★ **`www.` を外さないこと。** 実測でこちらは**本物の読者**だった
 *   （日本・google/yahoo/t.co・着地は `/works/2036` などの実在ページ）。
 *   `www` は全パスで apex へ 301 されていることを確認済み（2026-09-06）が、
 *   それでも `hostName` が `www` で記録される行がある。
 *   **除外すると実在の読者を20セッション捨てることになる。**
 */
function productionHosts(siteUrl: string): string[] {
  const override = process.env.GA4_HOSTS?.trim()
  if (override) return override.split(',').map((h) => h.trim()).filter(Boolean)

  // 既定は GSC_SITE_URL のホスト名と、その www 版。
  // `sc-domain:example.com` 形式にも `https://example.com/` 形式にも合わせる。
  const bare = siteUrl.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return bare.startsWith('www.') ? [bare, bare.slice(4)] : [bare, `www.${bare}`]
}

/**
 * 枠名 → どこに出ている枠か。**出力を読む人のための注釈**で、判定には使わない。
 * 枠を足したらここにも足すこと（無くても数字は出る）。
 */
const SLOT_NOTE: Record<string, string> = {
  work: '作品ページの状態行のボタン',
  find: '作品ページ「他のサービスで探す」（U-NEXT検索を含む・成果にはならない）',
  cta: '本文のCTA',
  bar: '画面下の追従枠（1200px未満）',
  rail: '右の追従枠（1200px以上）',
  table: '表の作品名リンク',
  poster: '記事本文の節ポスター',
  body: '記事本文の地の文のリンク',
  prime: 'Amazonプライムの無料体験（専用リンク・500円/件）',
  unext: 'U-NEXT の afb 枠',
}

async function main(): Promise<void> {
  const site = process.env.GSC_SITE_URL
  const keyPath = process.env.GSC_SERVICE_ACCOUNT
  const property = process.env.GA4_PROPERTY_ID

  if (!site || !keyPath) {
    console.log('GSC_SITE_URL と GSC_SERVICE_ACCOUNT が未設定です。設定は .env.example。')
    return
  }
  if (!existsSync(keyPath)) {
    console.error(`サービスアカウントのJSONが見つかりません: ${keyPath}`)
    process.exitCode = 1
    return
  }

  const days = Number(arg('days') ?? DEFAULT_DAYS)
  // ★ GSC は反映が2〜3日遅れる。終端を今日にすると必ず空の日が入る。
  const end = new Date(Date.now() - 3 * 86_400_000)
  const start = new Date(end.getTime() - days * 86_400_000)
  const range = { start: ymd(start), end: ymd(end) }

  const sa = JSON.parse(readFileSync(keyPath, 'utf8')) as ServiceAccount
  const gscToken = await accessToken(sa, 'https://www.googleapis.com/auth/webmasters.readonly')

  console.log(`期間: ${range.start} 〜 ${range.end}（${days}日・GSCの反映待ちで終端は3日前）`)
  console.log('')

  // --- Search Console -------------------------------------------------------
  const [total] = await gsc(gscToken, site, range.start, range.end, [])
  const byDate = await gsc(gscToken, site, range.start, range.end, ['date'])
  const byPage = await gsc(gscToken, site, range.start, range.end, ['page'])
  const byQuery = await gsc(gscToken, site, range.start, range.end, ['query'])

  const activeDays = byDate.length || 1
  console.log('■ 検索（Search Console）')
  if (!total) {
    console.log('  行が返りませんでした。公開直後なら異常ではありません。')
  } else {
    console.log(
      `  表示 ${total.impressions}／クリック ${total.clicks}／CTR ${pct(total.ctr)}／平均掲載順位 ${total.position.toFixed(1)}`
    )
    console.log(
      `  データのある日数 ${activeDays}日 → 1日あたり 表示 ${(total.impressions / activeDays).toFixed(0)}・クリック ${(total.clicks / activeDays).toFixed(1)}`
    )
    // ★ GSC は件数の少ない検索語を匿名化して返さない。その割合を出しておく。
    //   ここが大きいほどロングテールが効いている（＝面を増やす方針は当たっている）。
    const named = byQuery.reduce((s, r) => s + r.impressions, 0)
    console.log(
      `  個別に返った検索語 ${byQuery.length}語・表示 ${named}（全体の ${pct(named / total.impressions)}）` +
        ` → 残り ${pct(1 - named / total.impressions)} は匿名化されたロングテール`
    )
  }

  console.log('')
  console.log('■ ページの種類別（表示の多い順）')
  console.log('  種類          ページ    表示  クリック    CTR  平均順位')
  const kinds = new Map<string, { pages: number; imp: number; clicks: number; posw: number }>()
  for (const r of byPage) {
    const k = kindOf(pathOf(r.keys[0] ?? ''))
    const v = kinds.get(k) ?? { pages: 0, imp: 0, clicks: 0, posw: 0 }
    v.pages++
    v.imp += r.impressions
    v.clicks += r.clicks
    v.posw += r.position * r.impressions
    kinds.set(k, v)
  }
  for (const [k, v] of [...kinds].sort((a, b) => b[1].imp - a[1].imp)) {
    console.log(
      `  ${k.padEnd(12)}  ${n(v.pages, 6)}  ${n(v.imp, 6)}  ${n(v.clicks, 8)}  ${pct(v.clicks / v.imp).padStart(5)}  ${(v.posw / v.imp).toFixed(1).padStart(8)}`
    )
  }

  console.log('')
  console.log('■ クリックを集めているページ（上位10）')
  const ranked = [...byPage].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
  for (const r of ranked.slice(0, 10)) {
    console.log(
      `  ${n(r.impressions, 5)}表示 ${n(r.clicks, 3)}click ${pct(r.ctr).padStart(6)} ${r.position.toFixed(1).padStart(5)}位  ${pathOf(r.keys[0] ?? '')}`
    )
  }

  console.log('')
  console.log('■ 掲載順位の分布（表示ベース）')
  let lower = 0
  for (const [label, upper] of BUCKETS) {
    const rows = byPage.filter((r) => r.position >= lower && r.position < upper)
    lower = upper
    const imp = rows.reduce((s, r) => s + r.impressions, 0)
    if (imp === 0) continue
    const clicks = rows.reduce((s, r) => s + r.clicks, 0)
    console.log(
      `  ${label}  ${n(rows.length, 4)}ページ  表示 ${n(imp, 5)}  クリック ${n(clicks, 4)}  CTR ${pct(clicks / imp)}`
    )
  }

  /*
   * ■ 順位帯 × ページ種類。**この表だけが「順位の問題」と「タイトルの問題」を分ける。**
   *
   * 種類ごとのCTRを素で比べると、順位が違うぶんの差が混ざって何も言えない。
   * 順位帯を揃えて初めて「同じ順位に居るのにクリックされない種類」が見える。
   * 2026-09-06 の実測では 4〜10位帯で 記事 9.9% / 作品ページ 2.9% が出て、
   * 作品ページの問題が順位ではなくタイトルであることが確定した（docs/FUNNEL.md 3-2）。
   */
  console.log('')
  console.log('■ 順位帯 × ページの種類（同じ順位で比べる）')
  lower = 0
  for (const [label, upper] of BUCKETS) {
    const rows = byPage.filter((r) => r.position >= lower && r.position < upper)
    lower = upper
    if (rows.length === 0) continue
    const g = new Map<string, { pages: number; imp: number; clicks: number }>()
    for (const r of rows) {
      const k = kindOf(pathOf(r.keys[0] ?? ''))
      const v = g.get(k) ?? { pages: 0, imp: 0, clicks: 0 }
      v.pages++
      v.imp += r.impressions
      v.clicks += r.clicks
      g.set(k, v)
    }
    for (const [k, v] of [...g].sort((a, b) => b[1].imp - a[1].imp)) {
      console.log(
        `  ${label}  ${k.padEnd(12)} ${n(v.pages, 4)}ページ  表示 ${n(v.imp, 5)}  クリック ${n(v.clicks, 4)}  CTR ${pct(v.clicks / v.imp)}`
      )
    }
    console.log('')
  }

  // --- GA4 ------------------------------------------------------------------
  const out: Record<string, unknown> = { fetchedAt: new Date().toISOString(), range, site }
  out.gsc = { total, byDate, byPage, byQuery }

  if (!property) {
    console.log('')
    console.log('GA4_PROPERTY_ID が未設定なので、サイト内の数字は出しません（.env.example 参照）。')
  } else {
    const gaToken = await accessToken(sa, 'https://www.googleapis.com/auth/analytics.readonly')
    const hostList = productionHosts(site)

    /** 本番ホストだけに絞る条件。**GA4 のすべての問い合わせに掛ける。** */
    const prodFilter = {
      filter: { fieldName: 'hostName', inListFilter: { values: hostList } },
    }

    /**
     * ★ 既存の条件がある問い合わせは `andGroup` で束ねる。
     *   `dimensionFilter` は1つしか渡せないので、**片方を上書きしない**こと。
     */
    const withProd = (extra?: Record<string, unknown>): Record<string, unknown> => {
      const own = extra?.['dimensionFilter']
      if (!own) return { ...extra, dimensionFilter: prodFilter }
      return { ...extra, dimensionFilter: { andGroup: { expressions: [prodFilter, own] } } }
    }

    const g = (
      dims: string[],
      mets: string[],
      limit?: number,
      extra?: Record<string, unknown>
    ) => ga4(gaToken, property, range.start, range.end, dims, mets, limit, withProd(extra))

    /** ホスト名の内訳だけは**絞らずに**取る（何を外したかを見せるため）。 */
    const allHosts = await ga4(
      gaToken,
      property,
      range.start,
      range.end,
      ['hostName'],
      ['sessions', 'screenPageViews', 'engagementRate'],
      50
    )

    const [overall] = await g([], [
      'sessions',
      'totalUsers',
      'screenPageViews',
      'screenPageViewsPerSession',
      'engagementRate',
    ])
    const channels = await g(['sessionDefaultChannelGroup'], ['sessions', 'engagementRate'], 20)
    // ★ 拡張計測の `click` は外部リンクだけに付く（`outbound: true`）。
    //   `linkDomain` で行き先が分かるので、どのサービスへ流しているかが出る。
    const clickDomains = await g(['linkDomain'], ['eventCount'], 30, {
      dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'click' } } },
    })
    const landing = await g(
      ['landingPage'],
      ['sessions', 'screenPageViewsPerSession', 'engagementRate'],
      15
    )
    /*
     * 枠別のアフィリエイトクリック（2026-09-06 追加）。
     *
     * ★ **イベント名に枠名が入っている**（`aff_cta` `aff_work` …）。
     *   パラメータで送るとGA4の管理画面でカスタムディメンションに登録するまで
     *   レポートに出ないので、名前に埋めてある（layouts/BaseLayout.astro）。
     *
     * ★ 上の「外部リンククリック」（拡張計測の `click`）とは**別に数える**。
     *   あちらは外部リンク全部の合計、こちらは枠別。
     *   **合計がずれていてよい** — `data-slot` の無いリンクはこちらに出ない。
     */
    const bySlot = await g(['eventName'], ['eventCount'], 50, {
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { matchType: 'BEGINS_WITH', value: 'aff_' } },
      },
    })

    console.log('')
    console.log(`■ サイト内（GA4・本番ホストのみ: ${hostList.join(' / ')}）`)
    if (overall) {
      const pv = met(overall, 2)
      console.log(
        `  セッション ${met(overall, 0)}／ユーザー ${met(overall, 1)}／PV ${pv}` +
          `／PV per セッション ${met(overall, 3).toFixed(2)}／エンゲージメント率 ${pct(met(overall, 4))}`
      )
      const outbound = clickDomains.reduce((s, r) => s + met(r, 0), 0)
      console.log(
        `  **外部リンククリック ${outbound}件（PVの ${pct(pv ? outbound / pv : 0)}）** ← 収益の入口はここ`
      )
      for (const r of [...clickDomains].sort((a, b) => met(b, 0) - met(a, 0))) {
        console.log(`     ${n(met(r, 0), 5)}  ${dim(r, 0) || '(不明)'}`)
      }
    }

    /*
     * ★ **何を外したかを必ず見せる。** 上の数字は本番ホストだけで出しているので、
     *   ここを黙って隠すと「外した判断そのもの」が検証できなくなる。
     *   知らないホストが増えていたら、それが本物かどうかを人が見て決めること
     *   （判定の材料は `productionHosts()` の注意書き）。
     */
    console.log('')
    console.log('■ 枠別のアフィリエイトクリック')
    if (bySlot.length === 0) {
      console.log('  まだ0件。計測を入れたのは 2026-09-06 で、それ以前のクリックは枠が分からない。')
    } else {
      const total = bySlot.reduce((acc, r) => acc + met(r, 0), 0)
      for (const r of [...bySlot].sort((a, b) => met(b, 0) - met(a, 0))) {
        const slot = dim(r, 0).replace(/^aff_/, '')
        console.log(
          `  ${n(met(r, 0), 5)}回 ${pct(met(r, 0) / total).padStart(6)}  ${slot}  ${SLOT_NOTE[slot] ?? ''}`
        )
      }
    }

    console.log('')
    console.log('■ ホスト名の内訳（上の集計に入れたもの／外したもの）')
    let excluded = 0
    for (const r of allHosts) {
      const host = dim(r, 0)
      const included = hostList.includes(host)
      if (!included) excluded += met(r, 0)
      console.log(
        `  ${included ? '入' : '外'}  ${n(met(r, 0), 5)}セッション ${n(met(r, 1), 5)}PV` +
          `  エンゲージ ${pct(met(r, 2)).padStart(6)}  ${host}`
      )
    }
    if (excluded > 0) {
      console.log(`  → ${excluded}セッションを集計から外した。`)
      console.log(
        '     GA4 側では止められない（サイトのJSを実行していないヒットが混ざるため）。'
      )
      console.log('     本番ホストを足したいときは .env の GA4_HOSTS。')
    }

    console.log('')
    console.log('■ 流入経路（GA4）')
    for (const r of channels) {
      console.log(
        `  ${n(met(r, 0), 5)}セッション  エンゲージメント率 ${pct(met(r, 1)).padStart(6)}  ${dim(r, 0)}`
      )
    }

    /*
     * ★ **目標を測るのはこの1行。** ホスト名で絞っても `Direct` にボットが残る。
     *   実測（2026-09-06・90日）では Direct の着地はほぼ全部 `/` で、
     *   国はアメリカ・中国・フランス・台湾など、エンゲージメント率は0が並ぶ。
     *   **IPの内部トラフィック除外では消えない**（国内からではないため）。
     *
     *   `Organic Search` は着地も国も検索語も筋が通っていて、**汚れていない。**
     *   目標（1日100人）はもともと検索流入の話なので、**ここで判断する。**
     *   総セッション数を目標に使わないこと。
     */
    /*
     * ★ **期間全体で割らないこと。** このサイトは 2026-08-27 ごろに流入が立ち上がった。
     *   28日で割ると、流入が0だった日まで分母に入って実態の1/4になる。
     *   **直近7日だけを見る。**
     */
    const organicByDate = await g(['date'], ['sessions', 'totalUsers'], 400, {
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: { value: 'Organic Search' },
        },
      },
    })
    const last7 = [...organicByDate].sort((a, b) => dim(a, 0).localeCompare(dim(b, 0))).slice(-7)
    if (last7.length > 0) {
      const sessions = last7.reduce((acc, r) => acc + met(r, 0), 0)
      const users = last7.reduce((acc, r) => acc + met(r, 1), 0)
      console.log('')
      console.log(
        `  → **検索流入（直近${last7.length}日）: ${users}人 = ${(users / last7.length).toFixed(1)}人/日。**` +
          ' 目標（100人/日）はこの数字で見る'
      )
      console.log(
        `     ${dim(last7[0]!, 0)} 〜 ${dim(last7.at(-1)!, 0)}／${sessions}セッション。` +
          '期間全体で割らないこと（流入が0だった日が分母に入る）'
      )
      console.log(
        '     Direct はボットが多く、IPの内部トラフィック除外では消えない（コード中の注意書き）'
      )
    }
    out.organicByDate = organicByDate

    console.log('')
    console.log('■ 着地ページ（上位15）')
    for (const r of landing) {
      console.log(
        `  ${n(met(r, 0), 5)}セッション  ${met(r, 1).toFixed(2)}PV/s` +
          `  エンゲージ ${pct(met(r, 2)).padStart(6)}  ${dim(r, 0)}`
      )
    }

    out.ga4 = { hostList, overall, allHosts, channels, clickDomains, landing, bySlot }
  }

  if (has('write')) {
    writeFileSync(OUT, JSON.stringify(out, null, 1))
    console.log('')
    console.log(`→ ${OUT}`)
  }
}

main().catch((e) => {
  console.error(String(e))
  process.exitCode = 1
})
