/**
 * **サジェスト調査の画面**（スピンアウトツール）。手元で語形を調べるためのもの。
 *
 *   npm run suggest:ui                 http://127.0.0.1:5178 を開く
 *   npm run suggest:ui -- --port 5200  ポートを変える
 *
 * ■ 立ち位置
 * `npm run demand -- --suggest` の取得部分（`pipeline/sources/demand/google-suggest.ts`）を
 * **人が自分で叩けるようにした画面**。サイトにもパイプラインにも何も書かない。
 * 本体との接点は `google-suggest.ts` の import だけで、
 * 間隔・User-Agent・UTF-8 のデコードの決まりを**二重に持たないため**にそうしている。
 *
 * ■ なぜ Artifact（claude.ai の公開ページ）にしないか
 * サジェストの口は**公式APIではなく、CORS も許していない**。ブラウザから直接は叩けない。
 * それに、叩く間隔を守れるのは**叩く側が1か所にまとまっているとき**だけで、
 * 開いた人のブラウザがそれぞれ叩く形では守れない。だから手元のサーバーが代わりに叩く。
 *
 * ■ 叩き方の決まり（`google-suggest.ts` 冒頭と同じ）
 *   - 1回ごとに **0.4秒空ける**。複数タブから同時に投げても、ここで1列に並べる
 *   - **1回の実行は最大 MAX_SEEDS 語**。一覧を作るために何百回も叩かない
 *   - 同じ語は **CACHE_TTL_MS のあいだ取り直さない**（深掘りを繰り返しても増えない）
 *   ★ 「あ〜ん」「a〜z」を総当たりで付ける展開は**入れていない**。
 *     1語で70回を超え、上の決まりに正面から反する。
 *
 * ■ Search Console を重ねる（画面のスイッチで ON/OFF）
 * `/api/gsc` が自分のサイトの「検索語ごとの表示回数・順位」を返す。取得は `search-console.ts`。
 * **ディスクには書かない**（このリポジトリは公開。`data/analytics.json` を .gitignore しているのと同じ理由）。
 *
 * ■ 127.0.0.1 だけで待ち受ける
 * 外から叩かれると、**このマシンの回線で Google を叩く口**になり、Search Console の数字も読める。
 * 同じ理由で、`/api` はすべて Host の一致を求め（DNS リバインディング対策）、
 * POST は `Content-Type: application/json` を求める（他のサイトのフォーム送信で実行させないため）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fetchSuggest,
  MIN_INTERVAL_MS,
  QUESTION_SHAPES,
  type SuggestResult,
} from '../../pipeline/sources/demand/google-suggest.ts'
import { fetchFromApi, readFromFile, type GscSnapshot } from './search-console.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // .env が無ければ Search Console は控えのファイルだけを見る
}

const HOST = '127.0.0.1'
const DEFAULT_PORT = 5178

/** 1回の実行で引ける語の上限 */
const MAX_SEEDS = 40
/** 1語の長さの上限（貼り間違いで長文を投げないため） */
const MAX_SEED_LENGTH = 100
/** 同じ語を取り直さない時間 */
const CACHE_TTL_MS = 30 * 60_000
/** Search Console を取り直さない時間。日次でしか動かない数字なので長めでよい */
const GSC_TTL_MS = 60 * 60_000
/** 画面で選べる期間（日） */
const GSC_DAYS = [7, 28, 90]

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_HTML = resolve(HERE, 'index.html')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// --- 叩き方 -----------------------------------------------------------------

const cache = new Map<string, { result: SuggestResult; at: number }>()

/** 最後に Google を叩いた時刻。タブをまたいで共有する */
let lastFetchAt = 0
/** 叩く順番待ちの列。ここに繋ぐことで、同時に来た要求も1本ずつ流れる */
let queue: Promise<unknown> = Promise.resolve()

function throttled(seed: string): Promise<SuggestResult> {
  const run = async (): Promise<SuggestResult> => {
    const wait = lastFetchAt + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    try {
      return await fetchSuggest(seed)
    } finally {
      lastFetchAt = Date.now()
    }
  }
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

async function suggest(seed: string): Promise<SuggestResult & { cached: boolean }> {
  const hit = cache.get(seed)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.result, cached: true }
  const result = await throttled(seed)
  // ★ 失敗は貯めない。貯めると「0件」が30分居座る
  if (!result.error) cache.set(seed, { result, at: Date.now() })
  return { ...result, cached: false }
}

// --- Search Console ---------------------------------------------------------

const gscCache = new Map<number, { snapshot: GscSnapshot; at: number }>()

/**
 * API → 控えのファイルの順に試す。どちらも駄目なら理由を返す（画面がそのまま出す）。
 * ★ 控えに落ちたときは `apiError` を添える。期間が選んだものと違うことを画面で言うため。
 */
async function gsc(days: number, refresh: boolean): Promise<Record<string, unknown>> {
  const hit = gscCache.get(days)
  if (!refresh && hit && Date.now() - hit.at < GSC_TTL_MS) return { available: true, ...hit.snapshot, cached: true }
  let apiError: string | undefined
  try {
    const snapshot = await fetchFromApi(days)
    gscCache.set(days, { snapshot, at: Date.now() })
    return { available: true, ...snapshot, cached: false }
  } catch (e) {
    apiError = e instanceof Error ? e.message : String(e)
  }
  try {
    return { available: true, ...readFromFile(), cached: false, apiError }
  } catch (e) {
    return { available: false, apiError, fileError: e instanceof Error ? e.message : String(e) }
  }
}

// --- HTTP -------------------------------------------------------------------

function sameHost(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host ?? ''
  return host === `${HOST}:${port}` || host === `localhost:${port}`
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64_000) throw new Error('本文が大きすぎます')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function normalizeSeeds(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('seeds は文字列の配列で渡してください')
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    // 末尾の空白は意味がある（「◯◯␣」は次の語の候補を出す）。先頭と連続空白だけ畳む
    const seed = raw.replace(/^\s+/, '').replace(/\s{2,}/g, ' ')
    if (!seed.trim() || seed.length > MAX_SEED_LENGTH) continue
    seen.add(seed)
  }
  const seeds = [...seen]
  if (seeds.length === 0) throw new Error('調べる語がありません')
  if (seeds.length > MAX_SEEDS) {
    throw new Error(`1回に調べられるのは ${MAX_SEEDS} 語までです（指定: ${seeds.length} 語）`)
  }
  return seeds
}

/** 結果を1語ずつ流す（NDJSON）。画面は届いた順に描く */
async function handleSuggest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    return send(res, 415, 'text/plain', 'Content-Type は application/json にしてください')
  }

  let seeds: string[]
  try {
    seeds = normalizeSeeds((await readJson(req) as { seeds?: unknown }).seeds)
  } catch (e) {
    return send(res, 400, 'text/plain', e instanceof Error ? e.message : String(e))
  }

  let closed = false
  res.on('close', () => {
    closed = true
  })
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' })
  for (const seed of seeds) {
    // 画面で「中止」を押すと接続が切れる。残りは叩かない
    if (closed) break
    const result = await suggest(seed)
    res.write(JSON.stringify(result) + '\n')
  }
  res.end()
}

function main(): void {
  const port = Number(arg('port') ?? DEFAULT_PORT)

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${port}`)
    if (req.method === 'GET' && url.pathname === '/') {
      // 毎回読む。画面を直したらリロードだけで反映される
      return send(res, 200, 'text/html', readFileSync(INDEX_HTML, 'utf8'))
    }
    if (url.pathname.startsWith('/api/') && !sameHost(req, port)) {
      return send(res, 403, 'text/plain', 'Host が一致しません')
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(
        res,
        200,
        'application/json',
        JSON.stringify({
          maxSeeds: MAX_SEEDS,
          intervalMs: MIN_INTERVAL_MS,
          cacheTtlMs: CACHE_TTL_MS,
          shapes: QUESTION_SHAPES.map((s) => ({ key: s.key, label: s.label, pattern: s.pattern.source })),
          gscDays: GSC_DAYS,
        }),
      )
    }
    if (req.method === 'GET' && url.pathname === '/api/gsc') {
      const days = Number(url.searchParams.get('days'))
      if (!GSC_DAYS.includes(days)) {
        return send(res, 400, 'text/plain', `days は ${GSC_DAYS.join(' / ')} のどれかです`)
      }
      gsc(days, url.searchParams.get('refresh') === '1')
        .then((body) => send(res, 200, 'application/json', JSON.stringify(body)))
        .catch((e) => send(res, 500, 'text/plain', String(e)))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/suggest') {
      handleSuggest(req, res).catch((e) => {
        if (!res.headersSent) send(res, 500, 'text/plain', String(e))
        else res.end()
      })
      return
    }
    send(res, 404, 'text/plain', 'not found')
  })

  server.listen(port, HOST, () => {
    console.log(`サジェスト調査: http://${HOST}:${port}`)
    console.log(`  間隔 ${MIN_INTERVAL_MS}ms ／ 1回 ${MAX_SEEDS} 語まで ／ 同じ語は ${CACHE_TTL_MS / 60_000} 分取り直さない`)
    console.log('  止めるときは Ctrl+C')
  })
}

main()
