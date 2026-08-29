/**
 * 日本語版 Wikipedia から**作品の背景**を読む（記事を書くためのリサーチ）。
 *
 * ■ なぜ要るのか
 * 配信APIが返すのは、題名・年・ジャンル・評価・出演者と、英語のあらすじ1〜2文だけ。
 * これだけで書くと「◯◯が××する話です」で終わり、**その作品がなぜ好かれているのかが出ない。**
 * 読者が知りたいのは「自分に合うかどうか」で、そこを決めるのは
 * 作風・評判・広がり方（累計発行部数、シリーズの展開、受賞）といった**事実**。
 *
 * ■ なぜ Wikipedia か
 *   - キー不要・無料。Wikidata（既に使用）と同じ運営元で、**日本語で書かれている**
 *   - 作品記事には「概要」「作風」「評価」の節があり、探している事実がそこにまとまっている
 *   - 出典を辿れる。孫引きになるが、**推測で書くよりはるかに確度が高い**
 *
 * ■ 文章は写さない
 * ここで取るのは**記事を書くための下調べ**であって、載せる文章ではない。
 * Wikipedia の本文は CC BY-SA で、そのまま貼れば同じ条件での再配布義務が生じる。
 * **事実だけを読み取って、こちらの言葉で書く**（`templates/writing.md` 4節）。
 * 事実そのものに著作権は無い。
 *
 * ■ 取る節を絞る理由
 * 全文は5万字を超える（実測: ゆるキャン△ 53,062字）。あらすじの詳細・登場人物・
 * 各話リストは記事に書かない（ネタバレになるし、素材のあらすじと食い違う）ので、
 * **「概要」「作風」「評価」系の節と導入部だけ**を残す。
 */

import { join } from 'node:path'

/**
 * 下調べの置き場。**CLI ではなくここに置く**
 * （記事側から参照するときに `pipeline/cli/research.ts` を読み込むと、
 *   その場で CLI が動き出してしまう）。
 */
export const NOTES_PATH = join('data', 'work-notes.json')

/** 素性の分かる User-Agent。Wikimedia は連絡先のある UA を求めている */
const USER_AGENT = 'brog/0.1 (streaming blog research; contact via repository)'

const API = 'https://ja.wikipedia.org/w/api.php'

/**
 * 同じホストへの連続取得の間隔。**匿名の API 利用は絞られている**
 * （1秒間隔だと 429 Too Many Requests が返ってきた・2026-08-29 実測）。
 * 記事1本ぶんで数十件なので、2.5秒でも数分で終わる。**下げないこと。**
 */
export const MIN_INTERVAL_MS = 2_500

/** 1作品ぶんに残す上限（文字）。記事1本で数十作品ぶんを渡すため頭を打つ */
const MAX_CHARS = 2_000

const FETCH_TIMEOUT_MS = 15_000

/**
 * 残す節。**作品がどう受け止められているかが書いてある節だけ。**
 * 「あらすじ」「登場人物」「各話」は落とす（ネタバレと、素材との食い違いを避ける）。
 */
const WANTED_SECTIONS =
  /^(概要|作風|特徴|評価|評価と反響|反響|批評|受賞|受賞歴|人気|影響|背景|制作背景|制作|企画|舞台|舞台となった地域|聖地巡礼)$/

export interface WikipediaNote {
  /** 引いたときに使った題名 */
  query: string
  /** リダイレクト解決後のページ名。**別作品を掴んでいないかの確認に使う** */
  pageTitle: string
  url: string
  /** 節を絞ったプレーンテキスト */
  text: string
  fetchedAt: string
}

let lastFetchAt = 0

async function get(params: Record<string, string>): Promise<unknown> {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastFetchAt)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastFetchAt = Date.now()

  const url = new URL(API)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  // 429（絞られた）と 5xx は待って引き直す。**1件の失敗で下調べ全体を諦めない。**
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (res.ok) return await res.json()
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`Wikipedia ${res.status} ${res.statusText}`)
    }
    const wait = MIN_INTERVAL_MS * 2 ** (attempt + 1)
    await new Promise((r) => setTimeout(r, wait))
    lastFetchAt = Date.now()
  }
  throw new Error('Wikipedia への問い合わせが繰り返し断られました（時間をおいて再実行）')
}

/**
 * 全文から、残すと決めた節だけを抜き出す。
 *
 * 導入部（最初の見出しより前）は必ず残す。作品の素性が1文で分かる場所なので。
 */
export function pickSections(extract: string): string {
  const lines = extract.split('\n')
  const out: string[] = []
  // 見出しの深さは問わない（`== 概要 ==` も `=== 評価 ===` も拾う）
  let keeping = true // 導入部から始まる

  for (const line of lines) {
    const heading = line.match(/^=+ *(.+?) *=+$/)
    if (heading) {
      keeping = WANTED_SECTIONS.test(heading[1]!.trim())
      if (keeping) out.push(`【${heading[1]!.trim()}】`)
      continue
    }
    if (keeping && line.trim()) out.push(line.trim())
  }

  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '…' : text
}

/**
 * 作品名から背景を引く。**1作品につき1リクエスト。**
 *
 * 見つからなければ null。曖昧さ回避ページを掴んだ場合も null にする
 * （どの作品の話か分からないものを素材に混ぜない）。
 */
export async function fetchNote(title: string): Promise<WikipediaNote | null> {
  const json = (await get({
    action: 'query',
    prop: 'extracts',
    explaintext: '1',
    redirects: '1',
    format: 'json',
    formatversion: '2',
    titles: title,
  })) as { query?: { pages?: { title?: string; missing?: boolean; extract?: string }[] } }

  const page = json.query?.pages?.[0]
  if (!page || page.missing || !page.extract) return null
  if (/曖昧さ回避/.test(page.extract)) return null

  const text = pickSections(page.extract)
  if (text.length < 80) return null // 中身が無いページ（一覧記事など）

  const pageTitle = page.title ?? title
  return {
    query: title,
    pageTitle,
    url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`,
    text,
    fetchedAt: new Date().toISOString(),
  }
}
