/**
 * Wikidata から正式な現地語タイトルを解決する。
 *
 * ■ なぜ必要か
 * Streaming Availability API の output_language は en/es/fr/tr/de のみで
 * 日本語に対応していない。タイトルが英語で返るため、そのままでは
 * 日本語ブログとして成立しない（読者は邦題で検索する）。
 *
 * ■ なぜ Wikidata か
 * - CC0。商用利用に制約がない（TMDBと違ってここが決定的）
 * - APIキー不要・無料
 * - IMDb ID / TMDB ID で正確に引ける。APIがどちらも100%返すので相性が良い
 *
 * ■ なぜ LLM に訳させないか
 * 邦題は翻訳ではなく「配給時に決まった固有名詞」なので推測が効かない。
 *   Paul → ×ポール / ○宇宙人ポール
 *   The Northman → ×ノースマン / ○ノースマン 導かれし復讐者
 * SEOはこの正確さに直結するため、権威あるソースから引く。
 *
 * ■ 限界（実測値）
 * 映画は約77%、TVシリーズは約22%しか解決できない。
 * Wikidata に項目自体が無い新作（特に配信開始直後のオリジナル作品）が中心。
 * 解決できなかったものは原題のまま扱い、**LLMに邦題を捏造させない**こと。
 * 時間が経てば Wikidata 側に項目ができるため、refresh ジョブで再解決する。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ENDPOINT = 'https://query.wikidata.org/sparql'
export const TITLE_CACHE_PATH = join('data', 'titles.json')
export const ORIGIN_CACHE_PATH = join('data', 'origins.json')
export const COMPANY_CACHE_PATH = join('data', 'companies.json')
export const DIRECTOR_CACHE_PATH = join('data', 'directors.json')
export const CAST_CACHE_PATH = join('data', 'cast.json')

/** 1クエリあたりのID数。URL長とWDQSの負荷を考えた値。 */
const BATCH_SIZE = 50

/** WDQS は素性の分かるUser-Agentを求めている */
const USER_AGENT = 'brog/0.1 (automated blog pipeline; contact via repository)'

/** Wikidata のプロパティ */
const P_IMDB = 'P345'
const P_TMDB_MOVIE = 'P4947'
const P_TMDB_TV = 'P4983'
/**
 * 原語（original language of film or TV show）。
 *
 * ★ 製作国（P495）を使ってはいけない。共同製作の出資国がすべて並ぶため、
 *   「NOPE/ノープ」（P495 に日本を含む）や「ヤンヤン 夏の想い出」（台湾・日本）が
 *   邦画に化ける。実測で確認済み。原語なら両方とも正しく海外作品になる。
 */
const P_ORIGINAL_LANGUAGE = 'P364'
/**
 * 制作会社（production company）。
 *
 * 「同じ制作会社の作品が同じ日にまとめて配信開始された」というまとまりを、
 * 推測ではなく事実として書くために引く。
 */
const P_PRODUCTION_COMPANY = 'P272'
/**
 * 監督（P57）と出演者（P161）。
 *
 * ■ なぜ Wikidata から引くのか（2026-08-27 追加）
 * 配信APIが返す人名は**ローマ字**（`Tetsuya Nakashima`）で、日本の読者向けの記事に
 * そのまま出すと読みにくい。かといって記事側で漢字に起こすのは**推測**になり、
 * 同姓同名や表記ゆれで誤りが混ざる（テンプレートが禁じているのはそのため）。
 *
 * Wikidata なら**作品のIDから人物を辿る**ので名前の突き合わせが要らず、
 * 日本語ラベルをそのまま使える。制作会社（P272）で既に実証済みの経路。
 * 取れなかった作品はローマ字のまま出す（記事側がそう書き分ける）。
 */
const P_DIRECTOR = 'P57'
const P_CAST = 'P161'

/** 作品を指すID群。API はどちらも返すが、片方しか無いこともある。 */
export interface TitleRef {
  imdbId?: string
  /** "movie/1446033" または "tv/259288" の形式 */
  tmdbId?: string
}

/** キャッシュキー。imdbId を主キーとし、無ければ tmdbId で代用する。 */
export function titleCacheKey(ref: TitleRef): string | undefined {
  if (ref.imdbId) return ref.imdbId
  if (ref.tmdbId) return `tmdb:${ref.tmdbId}`
  return undefined
}

/** キー -> 現地語タイトル。null は「Wikidataに無いと確認済み」を意味する。 */
export type TitleCache = Record<string, string | null>

export async function loadTitleCache(): Promise<TitleCache> {
  try {
    return JSON.parse(await readFile(TITLE_CACHE_PATH, 'utf8')) as TitleCache
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

export async function saveTitleCache(cache: TitleCache): Promise<void> {
  await mkdir(dirname(TITLE_CACHE_PATH), { recursive: true })
  // キー順に並べて書き出す。git の差分を追加行だけにするため。
  const sorted: TitleCache = {}
  for (const k of Object.keys(cache).sort()) sorted[k] = cache[k]!
  await writeFile(TITLE_CACHE_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf8')
}

/**
 * Wikidata の曖昧さ回避の括弧。
 * 同名作品を区別するための注記であって作品名の一部ではない。
 * 実例: "ミュータント・タートルズ (2014年の映画)"
 *
 * 作品名の一部として括弧を持つ邦題（例: 『(500)日のサマー』）を壊さないよう、
 * 末尾にあり、かつ中身が注記だと分かるものだけを落とす。
 */
const DISAMBIGUATION =
  /[（(](?:\d{4}年の)?(?:映画|作品|テレビドラマ|ドラマ|テレビアニメ|アニメ|小説|漫画|ゲーム)[）)]$/

/**
 * Wikidata のラベルには前後の空白やゼロ幅文字が混入していることがある
 * （実例: "ブレイキング・コップス2﻿"）。
 * そのまま使うと記事タイトルやスラッグが壊れるため正規化する。
 */
function normalizeLabel(label: string): string {
  return label
    .replace(/[​-‍﻿⁠]/g, '') // ゼロ幅スペース・BOM 等
    .replace(/\s+/g, ' ')
    .trim()
    .replace(DISAMBIGUATION, '')
    .trim()
}

type Binding = Record<string, { value?: string } | undefined>

async function runBindings(sparql: string): Promise<Binding[]> {
  const res = await fetch(`${ENDPOINT}?format=json&query=${encodeURIComponent(sparql)}`, {
    headers: { 'User-Agent': USER_AGENT, accept: 'application/sparql-results+json' },
  })
  if (!res.ok) throw new Error(`Wikidata ${res.status} ${res.statusText}`)

  const json = (await res.json()) as { results?: { bindings?: Binding[] } }
  return json.results?.bindings ?? []
}

async function runQuery(sparql: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const b of await runBindings(sparql)) {
    const key = b.key?.value
    const label = b.label?.value ? normalizeLabel(b.label.value) : ''
    // 同一IDに複数ラベルが返ることがある。最初の1件を採用する。
    if (key && label && !out.has(key)) out.set(key, label)
  }
  return out
}

const literals = (vals: string[]) => vals.map((v) => `"${v}"`).join(' ')

/** IMDb ID で引く */
async function queryByImdb(ids: string[], lang: string): Promise<Map<string, string>> {
  return runQuery(`SELECT ?key ?label WHERE {
  VALUES ?key { ${literals(ids)} }
  ?item wdt:${P_IMDB} ?key .
  ?item rdfs:label ?label . FILTER(LANG(?label) = "${lang}")
}`)
}

/** TMDB ID で引く。IMDb で引けなかったぶんの取りこぼしを拾う。 */
async function queryByTmdb(
  refs: { movie: string[]; tv: string[] },
  lang: string,
): Promise<Map<string, string>> {
  const clauses: string[] = []
  if (refs.movie.length) {
    clauses.push(`{ VALUES ?key { ${literals(refs.movie)} } ?item wdt:${P_TMDB_MOVIE} ?key . }`)
  }
  if (refs.tv.length) {
    clauses.push(`{ VALUES ?key { ${literals(refs.tv)} } ?item wdt:${P_TMDB_TV} ?key . }`)
  }
  if (clauses.length === 0) return new Map()

  return runQuery(`SELECT ?key ?label WHERE {
  ${clauses.join('\n  UNION\n  ')}
  ?item rdfs:label ?label . FILTER(LANG(?label) = "${lang}")
}`)
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * 作品群の現地語タイトルを解決する。キャッシュ済みは問い合わせない。
 *
 * 1) IMDb ID でまとめて引く
 * 2) 1で引けなかったものを TMDB ID で引き直す
 *
 * Wikidata が落ちていても収集全体は止めない。失敗は警告に留め、
 * 解決できなかったぶんは原題のまま扱われる。
 */
export async function resolveTitles(
  refs: TitleRef[],
  lang: string,
  cache: TitleCache,
): Promise<TitleCache> {
  // 未問い合わせのものだけに絞る（キー単位で重複排除）
  const pending = new Map<string, TitleRef>()
  for (const ref of refs) {
    const key = titleCacheKey(ref)
    if (key && !(key in cache)) pending.set(key, ref)
  }
  if (pending.size === 0) return cache

  // --- 1) IMDb ID ---
  const byImdb = [...pending.entries()].filter(([, r]) => r.imdbId)
  for (const batch of chunk(byImdb, BATCH_SIZE)) {
    try {
      const found = await queryByImdb(
        batch.map(([, r]) => r.imdbId!),
        lang,
      )
      for (const [key, ref] of batch) {
        const hit = found.get(ref.imdbId!)
        if (hit) cache[key] = hit
      }
    } catch (err) {
      console.warn(`  ! Wikidata(IMDb)照会に失敗: ${err instanceof Error ? err.message : err}`)
    }
  }

  // --- 2) 取りこぼしを TMDB ID で ---
  const stillMissing = [...pending.entries()].filter(([key, r]) => !cache[key] && r.tmdbId)
  for (const batch of chunk(stillMissing, BATCH_SIZE)) {
    const movie: string[] = []
    const tv: string[] = []
    const backRef = new Map<string, string>() // tmdb数値ID -> cacheキー

    for (const [key, ref] of batch) {
      const [kind, id] = ref.tmdbId!.split('/')
      if (!id) continue
      backRef.set(id, key)
      if (kind === 'tv') tv.push(id)
      else movie.push(id)
    }

    try {
      const found = await queryByTmdb({ movie, tv }, lang)
      for (const [tmdbNumericId, label] of found) {
        const key = backRef.get(tmdbNumericId)
        if (key) cache[key] = label
      }
    } catch (err) {
      console.warn(`  ! Wikidata(TMDB)照会に失敗: ${err instanceof Error ? err.message : err}`)
    }
  }

  // 見つからなかったものは null で確定させ、毎回問い合わせ直さないようにする
  for (const key of pending.keys()) {
    if (!(key in cache)) cache[key] = null
  }
  return cache
}

// --- 作品の周辺情報（原語・制作会社） -------------------------------------

/**
 * キー -> ラベルの配列。null は「Wikidataに無いと確認済み」を意味する。
 *
 * ■ 何に使うか
 *   原語     ジャンル別記事（アニメ / 洋画 / 邦画）の振り分け
 *   制作会社 「同じ制作会社の作品が一斉に配信開始」というまとまりの裏付け
 *
 * 配信APIはどちらも返さないので、ここで補う。
 * **解釈はテーマパック側の仕事で、ここでは事実だけを持つ。**
 */
export type LabelCache = Record<string, string[] | null>

/** 後方互換のための別名 */
export type OriginCache = LabelCache

async function loadLabelCache(path: string): Promise<LabelCache> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LabelCache
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function saveLabelCache(path: string, cache: LabelCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const sorted: LabelCache = {}
  for (const k of Object.keys(cache).sort()) sorted[k] = cache[k]!
  await writeFile(path, JSON.stringify(sorted, null, 2) + '\n', 'utf8')
}

export const loadOriginCache = () => loadLabelCache(ORIGIN_CACHE_PATH)
export const saveOriginCache = (cache: LabelCache) => saveLabelCache(ORIGIN_CACHE_PATH, cache)
export const loadCompanyCache = () => loadLabelCache(COMPANY_CACHE_PATH)
export const saveCompanyCache = (cache: LabelCache) => saveLabelCache(COMPANY_CACHE_PATH, cache)
export const loadDirectorCache = () => loadLabelCache(DIRECTOR_CACHE_PATH)
export const saveDirectorCache = (cache: LabelCache) => saveLabelCache(DIRECTOR_CACHE_PATH, cache)
export const loadCastCache = () => loadLabelCache(CAST_CACHE_PATH)
export const saveCastCache = (cache: LabelCache) => saveLabelCache(CAST_CACHE_PATH, cache)

interface PropertyQuery {
  /** 引く Wikidata プロパティ（P364 など） */
  property: string
  /** ラベルの言語。`ja,en` のように優先順で並べる */
  labelLang: string
  /** 警告メッセージに出す名前 */
  name: string
}

/** 1作品が複数の値を持つことがある（多言語映画・共同制作）ので、キーごとに集める。 */
function collectLabels(bindings: Binding[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const b of bindings) {
    const key = b.key?.value
    const label = b.valueLabel?.value
    if (!key || !label) continue
    const values = out.get(key) ?? []
    if (!values.includes(label)) values.push(label)
    out.set(key, values)
  }
  return out
}

async function queryPropertyByImdb(ids: string[], q: PropertyQuery): Promise<Map<string, string[]>> {
  return collectLabels(
    await runBindings(`SELECT ?key ?valueLabel WHERE {
  VALUES ?key { ${literals(ids)} }
  ?item wdt:${P_IMDB} ?key .
  ?item wdt:${q.property} ?value .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${q.labelLang}". }
}`),
  )
}

async function queryPropertyByTmdb(
  refs: { movie: string[]; tv: string[] },
  q: PropertyQuery,
): Promise<Map<string, string[]>> {
  const clauses: string[] = []
  if (refs.movie.length) {
    clauses.push(`{ VALUES ?key { ${literals(refs.movie)} } ?item wdt:${P_TMDB_MOVIE} ?key . }`)
  }
  if (refs.tv.length) {
    clauses.push(`{ VALUES ?key { ${literals(refs.tv)} } ?item wdt:${P_TMDB_TV} ?key . }`)
  }
  if (clauses.length === 0) return new Map()

  return collectLabels(
    await runBindings(`SELECT ?key ?valueLabel WHERE {
  ${clauses.join('\n  UNION\n  ')}
  ?item wdt:${q.property} ?value .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${q.labelLang}". }
}`),
  )
}

/**
 * 作品群のあるプロパティを解決する。キャッシュ済みは問い合わせない。
 * 手順と失敗時の扱いは resolveTitles と同じ（止めない・欠けたまま扱う）。
 */
async function resolveProperty(
  refs: TitleRef[],
  cache: LabelCache,
  q: PropertyQuery,
): Promise<LabelCache> {
  const pending = new Map<string, TitleRef>()
  for (const ref of refs) {
    const key = titleCacheKey(ref)
    if (key && !(key in cache)) pending.set(key, ref)
  }
  if (pending.size === 0) return cache

  // --- 1) IMDb ID ---
  const byImdb = [...pending.entries()].filter(([, r]) => r.imdbId)
  for (const batch of chunk(byImdb, BATCH_SIZE)) {
    try {
      const found = await queryPropertyByImdb(
        batch.map(([, r]) => r.imdbId!),
        q,
      )
      for (const [key, ref] of batch) {
        const hit = found.get(ref.imdbId!)
        if (hit) cache[key] = hit
      }
    } catch (err) {
      console.warn(`  ! Wikidata(${q.name}/IMDb)照会に失敗: ${err instanceof Error ? err.message : err}`)
    }
  }

  // --- 2) 取りこぼしを TMDB ID で ---
  const stillMissing = [...pending.entries()].filter(([key, r]) => !cache[key] && r.tmdbId)
  for (const batch of chunk(stillMissing, BATCH_SIZE)) {
    const movie: string[] = []
    const tv: string[] = []
    const backRef = new Map<string, string>()

    for (const [key, ref] of batch) {
      const [kind, id] = ref.tmdbId!.split('/')
      if (!id) continue
      backRef.set(id, key)
      if (kind === 'tv') tv.push(id)
      else movie.push(id)
    }

    try {
      const found = await queryPropertyByTmdb({ movie, tv }, q)
      for (const [tmdbNumericId, values] of found) {
        const key = backRef.get(tmdbNumericId)
        if (key) cache[key] = values
      }
    } catch (err) {
      console.warn(`  ! Wikidata(${q.name}/TMDB)照会に失敗: ${err instanceof Error ? err.message : err}`)
    }
  }

  for (const key of pending.keys()) {
    if (!(key in cache)) cache[key] = null
  }
  return cache
}

/** 原語を解決する。ラベルは英語で持つ（`Japanese` のような言語名として使うため）。 */
export function resolveOrigins(refs: TitleRef[], cache: LabelCache): Promise<LabelCache> {
  return resolveProperty(refs, cache, {
    property: P_ORIGINAL_LANGUAGE,
    labelLang: 'en',
    name: '原語',
  })
}

/**
 * 制作会社を解決する。ラベルはサイトの言語で持つ（記事にそのまま出すため）。
 * 実測では日本のアニメ9件すべてが日本語ラベルで取れた
 * （京都アニメーション・東映アニメーション・シャフト・マッドハウス等）。
 */
export function resolveCompanies(
  refs: TitleRef[],
  lang: string,
  cache: LabelCache,
): Promise<LabelCache> {
  return resolveProperty(refs, cache, {
    property: P_PRODUCTION_COMPANY,
    labelLang: `${lang},en`,
    name: '制作会社',
  })
}

/**
 * 監督を解決する。ラベルはサイトの言語で持つ（記事にそのまま出すため）。
 *
 * ★ 日本語ラベルが無い人物は英語ラベルで返る。**それは推測ではないのでそのまま使ってよい。**
 *   記事側は「日本語で取れたか」を見て書き分ける（work-context.ts）。
 */
export function resolveDirectors(
  refs: TitleRef[],
  lang: string,
  cache: LabelCache,
): Promise<LabelCache> {
  return resolveProperty(refs, cache, {
    property: P_DIRECTOR,
    labelLang: `${lang},en`,
    name: '監督',
  })
}

/**
 * 出演者を解決する。
 *
 * ★ 1作品で数十人返ることがある（P161 は主演に限らない）。
 *   **記事に何人出すかは記事側で絞る。** ここでは取れたものをそのまま持つ。
 */
export function resolveCast(
  refs: TitleRef[],
  lang: string,
  cache: LabelCache,
): Promise<LabelCache> {
  return resolveProperty(refs, cache, {
    property: P_CAST,
    labelLang: `${lang},en`,
    name: '出演者',
  })
}
