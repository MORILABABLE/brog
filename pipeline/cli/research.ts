/**
 * これから書く記事の作品を、日本語版 Wikipedia で下調べする。
 *
 *   npm run write -- --type upcoming --genre anime --service prime-video --emit
 *   npm run research                 ← ここで下調べ（1作品1リクエスト）
 *   npm run write -- --type upcoming --genre anime --service prime-video --emit
 *                                     ← もう一度出すと、素材にリサーチが入る
 *
 * ■ なぜ `--emit` のあとに走らせるのか
 * **調べる対象は「その記事に載る作品」だけでよい。**
 * `--emit` が `data/draft/context.json` に確定した作品リストを書いているので、
 * それを読めば選び方を二重に持たずに済む（記事タイプの絞り込みは1か所のまま）。
 *
 * ■ 何を貯めるか
 * `data/work-notes.json` に作品名で貯める。**一度調べた作品は二度引かない。**
 * 中身は「概要」「作風」「評価」系の節だけで、あらすじの詳細や登場人物は入れない
 * （理由は pipeline/sources/wikipedia.ts の冒頭）。
 *
 * ■ 文章は写さない
 * 貯めるのは**記事を書くための下調べ**。載せる文章ではない。
 * 事実を読み取ってこちらの言葉で書く（templates/writing.md 4節）。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fetchNote, NOTES_PATH, type WikipediaNote } from '../sources/wikipedia.ts'

export { NOTES_PATH }
const CONTEXT_PATH = join('data', 'draft', 'context.json')

/** 一度に引く上限。記事1本ぶん（〜120件）を想定しつつ、暴走の保険 */
const DEFAULT_MAX = 60

/** 見つからなかった作品を引き直すまでの日数。項目が後からできることがある */
const RECHECK_DAYS = 60

export interface WorkNotes {
  note: string
  updatedAt: string
  /** 作品名 -> 下調べ。null は「日本語版 Wikipedia に項目が無いと確認済み」 */
  works: Record<string, (WikipediaNote & { missing?: false }) | { missing: true; fetchedAt: string }>
}

const EMPTY: WorkNotes = {
  note:
    '記事を書くための下調べ（日本語版 Wikipedia の「概要」「作風」「評価」節）。' +
    'npm run research が書く。手で編集しない。文章は記事に写さず、事実だけを使う。',
  updatedAt: '',
  works: {},
}

export async function loadNotes(): Promise<WorkNotes> {
  try {
    return { ...EMPTY, ...(JSON.parse(await readFile(NOTES_PATH, 'utf8')) as Partial<WorkNotes>) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, works: {} }
    throw err
  }
}

export async function saveNotes(notes: WorkNotes): Promise<void> {
  await mkdir(dirname(NOTES_PATH), { recursive: true })
  const sorted: WorkNotes['works'] = {}
  for (const k of Object.keys(notes.works).sort()) sorted[k] = notes.works[k]!
  const body = { ...notes, updatedAt: new Date().toISOString(), works: sorted }
  await writeFile(NOTES_PATH, JSON.stringify(body, null, 2) + '\n', 'utf8')
}

/**
 * 引くときの言い換え。**題名そのままで当たらないときだけ使う。**
 *
 * 季節表記や放送枠の冠が付いた題名は、Wikipedia では本編の項目にまとまっている
 * （「ゆるキャン△ SEASON２」→「ゆるキャン△」）。
 */
export function queryVariants(title: string): string[] {
  const out: string[] = []
  const add = (v: string) => {
    const t = v.trim()
    if (t && t !== title && !out.includes(t)) out.push(t)
  }
  const half = title.replace(/　/g, ' ')
  add(half)
  const trimmed = half
    .replace(/\s*[（(](?:見逃し配信|独占配信|字幕版|吹替版|\d{4})[）)]\s*$/, '')
    .replace(/\s*(?:シーズン|SEASON|Season|シリーズ)\s*[0-9０-９]+(?:\s*[~～-]\s*[0-9０-９]+)?\s*$/u, '')
    .replace(/\s*S[0-9０-９]+(?:\s*[~～-]\s*[0-9０-９]+)?\s*$/u, '')
    .trim()
  add(trimmed)
  // 「◯◯ シーズン」まで落ちた形（「3月のライオン シーズンS1~2」→「3月のライオン」）
  const noSeasonWord = trimmed.replace(/\s*(?:シーズン|シリーズ|SEASON|Season)\s*$/u, '').trim()
  add(noSeasonWord)

  const bracket = trimmed.match(/[「『]([^「」『』]{2,})[」』]\s*$/)
  if (bracket) add(bracket[1]!)
  // 冠に作品名がある形（「『怪獣８号』オリジナルショートアニメ「鳴海の平日」」→「怪獣８号」）
  const leading = trimmed.match(/^[「『]([^「」『』]{2,})[」』]/)
  if (leading) add(leading[1]!)
  // 「劇場版チェンソーマン レゼ篇」のような冠を落とした形
  add(trimmed.replace(/^(?:劇場版|映画|アニメ映画|TVアニメ|テレビアニメ)\s*/, ''))

  // ★ 全角数字は Wikipedia 側では半角のことが多い（「怪獣８号」→「怪獣8号」）。
  //   ここまでに作った候補すべてについて、半角にした形も試す。
  for (const v of [...out, title]) {
    add(v.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)))
  }
  return out
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force')
  const max = Number(arg('max') ?? DEFAULT_MAX)

  let context: { items?: { work?: { localizedTitle?: string; title?: string } }[] }
  try {
    context = JSON.parse(await readFile(CONTEXT_PATH, 'utf8')) as typeof context
  } catch {
    throw new Error(
      `${CONTEXT_PATH} がありません。先に記事のプロンプトを書き出してください:\n` +
        '  npm run write -- --type <記事タイプ> … --emit',
    )
  }

  const titles = [
    ...new Set(
      (context.items ?? [])
        .map((e) => e.work?.localizedTitle ?? e.work?.title ?? '')
        .filter(Boolean),
    ),
  ]
  if (titles.length === 0) throw new Error('下書きの素材が空です')

  const notes = await loadNotes()
  const now = Date.now()
  const targets = titles.filter((t) => {
    if (force) return true
    const rec = notes.works[t]
    if (!rec) return true
    // 「項目が無い」は時間を置いて引き直す。新作は後から項目ができる
    if ('missing' in rec && rec.missing) {
      return now - Date.parse(rec.fetchedAt) > RECHECK_DAYS * 86_400_000
    }
    return false
  })

  console.log(`素材 ${titles.length}作品 / 未取得 ${targets.length}作品（上限 ${max}）`)
  if (targets.length === 0) {
    console.log('すべて取得済みです。もう一度 --emit すれば素材に入ります。')
    return
  }

  let found = 0
  let missing = 0
  for (const title of targets.slice(0, max)) {
    let note = null
    let failed = false
    for (const q of [title, ...queryVariants(title)]) {
      try {
        note = await fetchNote(q)
      } catch (err) {
        // 1件の失敗で全体を止めない（相手側の一時的な不調で下調べを諦めない）
        failed = true
        console.log(`  ${title}: ${(err as Error).message}`)
      }
      if (note) break
    }
    // ★ 通信に失敗しただけの作品を「項目なし」と記録しない。
    //   記録すると RECHECK_DAYS のあいだ引き直さなくなり、下調べが欠けたまま固定される。
    if (!note && failed) {
      console.log(`  ? ${title}（取得できず。次回また試します）`)
      continue
    }
    if (note) {
      notes.works[title] = note
      found++
      const via = note.pageTitle === title ? '' : `（→ ${note.pageTitle}）`
      console.log(`  ✓ ${title}${via} ${note.text.length}字`)
    } else {
      notes.works[title] = { missing: true, fetchedAt: new Date().toISOString() }
      missing++
      console.log(`  − ${title}（項目なし）`)
    }
  }

  await saveNotes(notes)
  console.log(`\n取得 ${found}件 / 項目なし ${missing}件 → ${NOTES_PATH}`)
  console.log('もう一度 --emit すると、素材にリサーチが入ります。')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
