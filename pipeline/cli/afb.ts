/**
 * afb（アフィリエイトB）の成果データを取り込む。
 *
 *   npm run afb                    直近30日ぶんを取り込む
 *   npm run afb -- --days 7        期間を短くする
 *   npm run afb -- --type 1        基準日を変える（1=クリック日 2=発生日 3=確定日）
 *   npm run afb -- --status 1      承認だけ（0=発生 1=承認 2=却下。カンマ区切り可）
 *   npm run afb -- --dry-run       取得して表示するだけ（何も書かない）
 *   npm run afb -- --raw           APIの生レスポンスをそのまま出す（形の確認用）
 *
 * ■ このAPIは「リンクを作る」ものではない（いちばん大事な前提）
 * afb が発行するAPIキーで読めるのは**成果データだけ**。
 * アフィリエイトリンクを生成するAPIは afb に存在しない。
 * リンクは管理画面（広告・提携管理 → 広告原稿取得）から**人手でコピーする**。
 * つまりこのファイルは「収益の計測」側であって、「設置」側ではない。
 * 設置の手順は docs/AFFILIATE.md 11節。
 *
 * ■ 何のためにあるか
 * Amazon は枠別トラッキングID（PUBLIC_AMAZON_TAG_*）で導線ごとに分けて測れる。
 * afb でも同じことを **id1** でやる（リンクコード末尾に `&id1=cta` のように付ける）。
 * その id1 は成果データの `keyword` 欄に入って返る。
 * **どの枠のリンクが登録に繋がったか**を、ここで突き合わせる。
 *
 * ■ 参照期間は本日から30日以内（APIの仕様）
 * 31日以上前を指定すると 400 `the reference term has passed` が返る。
 * だから**このスクリプトは履歴を積み上げる**。毎回上書きせず、
 * 既存の成果IDに新しい取得ぶんを重ねる（30日を過ぎた成果も手元には残る）。
 * 週1で回しておけば、APIが忘れても台帳には残る。
 *
 * ■ 認証
 *   .env に2つ。どちらも afb の管理画面から取る。
 *     AFB_PARTNER_ID … ログインに使うパートナーID
 *     AFB_API_KEY    … afb に申請して発行してもらうAPIキー
 *   ヘッダー名は `authorizationtoken`（Bearer ではない。仕様書のまま）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かない（環境変数で渡す）
}

/** 出力先。成果IDをキーにした台帳として積み上げる。 */
const OUT = resolve('data/afb-conversions.json')

const ENDPOINT = 'https://api.afi-b.com/partners'

/**
 * APIが遡れる上限（日）。仕様書の「本日から30日以内」。
 * ここを超えると 400 が返るので、指定されても切り詰める。
 */
const MAX_DAYS = 30

/**
 * 基準日の既定。
 *
 * ★ 2（発生日）にしてある。1（クリック日）だと「まだ成果になっていない
 *   クリック」まで拾って件数が水増しに見え、3（確定日）だと承認が下りるまで
 *   1〜2か月なにも返らない。**いま何が起きたか**を見るなら発生日。
 */
const DEFAULT_DATE_TYPE = '2'

/** 成果承認状態（レスポンスの commit_flg / リクエストの status）。 */
const STATUS_LABEL: Record<string, string> = {
  '0': '発生（未承認）',
  '1': '承認',
  '2': '却下',
}

/** 仕様書のレスポンスボディ。1件＝1成果。 */
export interface Conversion {
  commit_id?: string
  adv_id?: string
  adv_name?: string
  partner_site_id?: string
  partner_site_name?: string
  device?: string
  /** リンクコードに付けた id1〜id5 がここに返る（＝当サイトでは「枠」） */
  keyword?: string
  /** リンク元ページ。vref.js を入れていないと空になりやすい（docs/AFFILIATE.md 11-5） */
  ref?: string
  visit_time?: string
  commit_time?: string
  recognition_time?: string
  margin?: string | number
  commit_flg?: string | number
  error_message?: string
}

interface Ledger {
  fetchedAt: string
  /** 成果ID → 成果。**上書きではなく積み上げる**（APIは30日で忘れるため） */
  conversions: Record<string, Conversion>
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function yen(n: number): string {
  return `${Math.round(n).toLocaleString('ja-JP')}円`
}

/**
 * エラーの意味を、次の一手つきで日本語にする。
 *
 * ★ 403 は2種類あり、**直す場所が違う**（仕様書のエラー一覧）。
 *     `User is not authorized…`     → APIキーが違う
 *     `Missing Authentication Token` → URLが違う（パスの綴り）
 *   本文を見ないと区別できないので、必ず本文も出す。
 */
function explain(status: number, body: string): string {
  const lines = [`afb API が ${status} を返しました。`, body.trim()]
  if (status === 400 && body.includes('reference term')) {
    lines.push('→ 参照期間は**本日から30日以内**です。--days を30以下にしてください。')
  } else if (status === 400 && body.includes('partner not exist')) {
    lines.push('→ AFB_PARTNER_ID が違います。管理画面のログインIDを確認してください。')
  } else if (status === 401) {
    lines.push('→ AFB_API_KEY が未設定か、ヘッダーに乗っていません。')
  } else if (status === 403 && body.includes('Missing Authentication')) {
    lines.push('→ URLが違います（エンドポイントの綴り）。')
  } else if (status === 403) {
    lines.push('→ APIキーが違います。afb から発行されたキーを .env に入れ直してください。')
  } else if (status === 404) {
    lines.push('→ 指定されたURLが存在しません。partner_id を含むパスを確認してください。')
  } else if (status >= 500) {
    lines.push('→ afb 側の障害です。時間をおいて再実行してください。')
  }
  return lines.join('\n')
}

/**
 * レスポンスから成果の配列を取り出す。
 *
 * ★ 仕様書は `response` の下に各項目があるとしか書いておらず、
 *   **配列なのかオブジェクトなのかが確定していない**。
 *   実物を見るまで決め打ちせず、あり得る形をすべて受ける。
 *   `--raw` で生の形を確認できるようにしてあるのはこのため。
 *   実物の形が分かったら、この関数を素直な1行に縮めてよい。
 */
function extract(json: unknown): Conversion[] {
  if (Array.isArray(json)) return json as Conversion[]
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>
    const r = o.response ?? o.data ?? o.result
    if (Array.isArray(r)) return r as Conversion[]
    if (r && typeof r === 'object') {
      const inner = r as Record<string, unknown>
      // 1件だけのときにオブジェクトで返る形も受ける
      if ('commit_id' in inner) return [inner as Conversion]
      for (const v of Object.values(inner)) {
        if (Array.isArray(v)) return v as Conversion[]
      }
    }
  }
  return []
}

async function fetchConversions(
  partnerId: string,
  apiKey: string,
  params: URLSearchParams
): Promise<{ raw: unknown; rows: Conversion[] }> {
  const url = `${ENDPOINT}/${encodeURIComponent(partnerId)}/conversion?${params}`
  const res = await fetch(url, {
    headers: {
      'Content-type': 'application/json',
      // ★ 仕様書どおりの綴り。`Authorization` でも `Bearer` でもない。
      authorizationtoken: apiKey,
    },
  })
  const body = await res.text()
  if (!res.ok) throw new Error(explain(res.status, body))

  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    throw new Error(`JSONとして読めませんでした:\n${body.slice(0, 500)}`)
  }
  return { raw: json, rows: extract(json) }
}

/** 既存の台帳。無ければ空。壊れていても落とさない（取れたぶんは残したい）。 */
function loadLedger(): Ledger {
  if (!existsSync(OUT)) return { fetchedAt: '', conversions: {} }
  try {
    const parsed = JSON.parse(readFileSync(OUT, 'utf8')) as Partial<Ledger>
    return { fetchedAt: parsed.fetchedAt ?? '', conversions: parsed.conversions ?? {} }
  } catch {
    console.warn(`${OUT} が読めませんでした。新しく作り直します。`)
    return { fetchedAt: '', conversions: {} }
  }
}

/** 集計して表示する。**キーごとの件数と報酬**。 */
function summarize(rows: Conversion[]): void {
  const total = rows.reduce((s, r) => s + Number(r.margin ?? 0), 0)
  console.log(`成果 ${rows.length}件 / 報酬 ${yen(total)}`)
  if (rows.length === 0) return

  const group = (pick: (r: Conversion) => string) => {
    const m = new Map<string, { n: number; sum: number }>()
    for (const r of rows) {
      const k = pick(r) || '(なし)'
      const cur = m.get(k) ?? { n: 0, sum: 0 }
      cur.n += 1
      cur.sum += Number(r.margin ?? 0)
      m.set(k, cur)
    }
    return [...m.entries()].sort((a, b) => b[1].sum - a[1].sum || b[1].n - a[1].n)
  }

  const show = (title: string, entries: [string, { n: number; sum: number }][]) => {
    console.log('')
    console.log(title)
    for (const [k, v] of entries) console.log(`  ${k}  ${v.n}件 / ${yen(v.sum)}`)
  }

  show('承認状態', group((r) => STATUS_LABEL[String(r.commit_flg)] ?? String(r.commit_flg ?? '')))
  show('プロモーション', group((r) => r.adv_name ?? r.adv_id ?? ''))
  // ★ keyword はリンクコードに付けた id1。当サイトでは「どの枠か」が入る。
  //   (なし) ばかりなら id1 を付け忘れている（docs/AFFILIATE.md 11-4）。
  show('枠（id1）', group((r) => String(r.keyword ?? '')))
  // ★ ref はリンク元ページ。空ばかりなら vref.js が入っていない（同 11-5）。
  show('リンク元ページ（ref）', group((r) => String(r.ref ?? '')).slice(0, 10))
}

async function main(): Promise<void> {
  const partnerId = process.env.AFB_PARTNER_ID
  const apiKey = process.env.AFB_API_KEY

  if (!partnerId || !apiKey) {
    console.log('AFB_PARTNER_ID と AFB_API_KEY が未設定です。何もしません。')
    console.log('  AFB_PARTNER_ID=（afb のログインに使うパートナーID）')
    console.log('  AFB_API_KEY=（afb から発行されたAPIキー）')
    console.log('手順は docs/AFFILIATE.md 11節。')
    return
  }

  const requested = Number(arg('days') ?? MAX_DAYS)
  const days = Math.min(Number.isFinite(requested) && requested > 0 ? requested : MAX_DAYS, MAX_DAYS)
  if (requested > MAX_DAYS) {
    console.log(`--days ${requested} は上限を超えています。${MAX_DAYS}日に切り詰めました。`)
    console.log('（APIが遡れるのは本日から30日以内。仕様書のエラー一覧より）')
  }

  const end = new Date()
  const start = new Date(end.getTime() - days * 86_400_000)

  const params = new URLSearchParams({
    start_date: ymd(start),
    end_date: ymd(end),
    conversion_date_type: arg('type') ?? DEFAULT_DATE_TYPE,
  })
  for (const [flag, key] of [
    ['status', 'status'],
    ['promotion', 'promotion_id'],
    ['site', 'partner_site_id'],
  ] as const) {
    const v = arg(flag)
    if (v) params.set(key, v)
  }

  const { raw, rows } = await fetchConversions(partnerId, apiKey, params)

  if (has('raw')) {
    console.log(JSON.stringify(raw, null, 2))
    return
  }

  console.log(`${ymd(start)} 〜 ${ymd(end)}（基準日: ${params.get('conversion_date_type')}）`)
  summarize(rows)

  if (has('dry-run')) {
    console.log('')
    console.log('--dry-run のため何も書きませんでした。')
    return
  }

  // ★ 上書きではなく積み上げる。APIは30日で忘れるが、台帳は忘れない。
  //   同じ成果IDは新しい方で置き換える（未承認 → 承認 と状態が変わるため）。
  const ledger = loadLedger()
  const before = Object.keys(ledger.conversions).length
  for (const r of rows) {
    const id = String(r.commit_id ?? '')
    if (!id) continue
    ledger.conversions[id] = r
  }
  ledger.fetchedAt = new Date().toISOString()

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')

  const after = Object.keys(ledger.conversions).length
  console.log('')
  console.log(`${OUT} に書きました（台帳 ${before}件 → ${after}件）`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
