/**
 * Google サジェストで「その作品に、どの問いが付いているか」を確かめる。
 *
 * ■ 発見には使えない。**確認にだけ使う**
 * サジェストは入力語（シード）が要る。**シードを思いつくのは人**なので、
 * これで新しい主題を見つけることはできない。
 * できるのは、既に挙がっている候補について
 * 「読者はこの作品に何を尋ねているか」を見ることだけ。
 *
 *   `リコリス・リコイル 配信` → 配信サイト / 舞台 配信 / アニメ 配信
 *   `国宝 どこで`             → どこで見れる / どこで配信 / どこで見れる 映画館
 *
 * この区別は docs/KEYWORDS.md 冒頭の★（サジェストは検索ボリュームではない）と同じ。
 * **候補が0件でも需要ゼロではないが、その語形が一般的でない証拠にはなる。**
 *
 * ■ 公式APIではない
 * 補完候補の口であって、データ提供の口ではない。
 * だから**候補が確定してから、上位のものにだけ**叩く。
 * 一覧を作るために何百回も叩かないこと。間隔は下げない。
 *
 * ■ 文字化け
 * ★ **UTF-8 で明示的にデコードすること**（docs/KEYWORDS.md 9節）。
 *   既定のコードページのまま出すと化ける。
 */

const USER_AGENT = 'Mozilla/5.0'

const ENDPOINT = 'https://suggestqueries.google.com/complete/search'

/** 1回ごとに空ける間隔。**まとめて叩かない**（docs/KEYWORDS.md 9節と同じ値） */
export const MIN_INTERVAL_MS = 400

const FETCH_TIMEOUT_MS = 10_000

/**
 * 読者がその作品に付けている問いの型。
 * **どの記事が答えになるか**を決めるのはこの型で、閲覧数ではない。
 */
export const QUESTION_SHAPES = [
  { key: 'until', label: 'いつまで', pattern: /いつまで|終了|終わる|何時まで/ },
  { key: 'where', label: 'どこで', pattern: /どこで|配信サイト|見れる|見られる|サブスク|配信中/ },
  { key: 'from', label: 'いつから', pattern: /いつから|配信予定|配信日|いつ配信/ },
  { key: 'free', label: '無料', pattern: /無料|タダ|フル/ },
] as const

export type QuestionShapeKey = (typeof QUESTION_SHAPES)[number]['key']

export interface SuggestResult {
  seed: string
  candidates: string[]
  /** 候補に現れた問いの型 */
  shapes: QuestionShapeKey[]
}

/** 1語ぶんの候補を取る。**失敗しても落とさない**（確認のための道具なので） */
export async function fetchSuggest(seed: string): Promise<SuggestResult> {
  const url = `${ENDPOINT}?client=firefox&hl=ja&gl=jp&q=${encodeURIComponent(seed)}`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return { seed, candidates: [], shapes: [] }
    // ★ 明示的に UTF-8 でデコードする
    const text = new TextDecoder('utf-8').decode(new Uint8Array(await res.arrayBuffer()))
    const parsed = JSON.parse(text) as [string, string[]]
    const candidates = parsed[1] ?? []
    const shapes = QUESTION_SHAPES.filter((s) => candidates.some((c) => s.pattern.test(c))).map(
      (s) => s.key,
    )
    return { seed, candidates, shapes }
  } catch {
    return { seed, candidates: [], shapes: [] }
  }
}

/** 複数のシードを**間隔を空けて**順に引く */
export async function fetchSuggests(seeds: string[]): Promise<SuggestResult[]> {
  const out: SuggestResult[] = []
  for (const [i, seed] of seeds.entries()) {
    out.push(await fetchSuggest(seed))
    if (i < seeds.length - 1) await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS))
  }
  return out
}
