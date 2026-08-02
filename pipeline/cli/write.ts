/**
 * 記事を生成する。3つの使い方がある。
 *
 * ── A. API で生成（課金あり）
 *   npm run write
 *
 * ── B. このターミナル（Claude Code等）で生成（API課金なし）
 *   npm run write -- --emit     → data/draft/prompt.md を書き出す
 *   （prompt.md を読んで記事を書き、data/draft/response.md に保存）
 *   npm run write -- --apply    → 検証して site/ に書き出す
 *
 *   スラッシュコマンド /article で上記を自動化できる。
 *
 * ── C. プロンプトの確認だけ（無料）
 *   npm run write -- --dry-run
 *
 * ■ なぜ分割するか
 * 検証・frontmatter組み立て・書き出しは、どの方式でも共通の処理。
 * 「プロンプトを作る」と「応答を適用する」に分ければ、
 * 生成手段だけを差し替えられる。品質ゲートはどの経路でも必ず通る。
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadTheme, type Theme } from '../theme.ts'
import { loadLedger, readEvents, saveLedger } from '../core/events.ts'
import { currentYearMonth } from '../core/datetime.ts'
import { buildMarkdown, parseArticle, type ArticleType } from '../core/article.ts'
import { hasError, verifyArticle } from '../core/verify.ts'
import { createProvider } from '../llm/index.ts'
import { ATTRIBUTION } from '../sources/streaming-availability.ts'
import type { ChangeEvent } from '../sources/types.ts'
import { leavingArticle } from '../../theme-packs/streaming-jp/article-types/leaving.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かない
}

const POSTS_DIR = join('site', 'src', 'content', 'posts')
const DRAFT_DIR = join('data', 'draft')
const PROMPT_PATH = join(DRAFT_DIR, 'prompt.md')
const CONTEXT_PATH = join(DRAFT_DIR, 'context.json')
const RESPONSE_PATH = join(DRAFT_DIR, 'response.md')
const MAX_TOKENS = 16_000

const TYPES: Record<string, ArticleType> = {
  leaving: leavingArticle,
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

/** --apply のときに素材を復元するための保存内容 */
interface DraftContext {
  typeId: string
  createdAt: string
  items: ChangeEvent[]
}

/** 既存記事のタイトル一覧（重複検知用） */
async function existingTitles(): Promise<string[]> {
  try {
    const files = await readdir(POSTS_DIR)
    const titles: string[] = []
    for (const f of files.filter((f) => f.endsWith('.md'))) {
      const raw = await readFile(join(POSTS_DIR, f), 'utf8')
      const m = raw.match(/^title:\s*'(.*)'\s*$/m) ?? raw.match(/^title:\s*"(.*)"\s*$/m)
      if (m?.[1]) titles.push(m[1].replace(/''/g, "'"))
    }
    return titles
  } catch {
    return []
  }
}

/**
 * 生成された本文を検証し、記事として書き出す。
 * API経由でもターミナル経由でも、必ずここを通る。
 */
async function finalize(
  raw: string,
  type: ArticleType,
  items: ChangeEvent[],
  theme: Theme,
  now: Date,
  stopReason?: string,
): Promise<void> {
  const parsed = parseArticle(raw)
  if (!parsed) {
    console.error('出力を解釈できませんでした。指定した形式に従っていません。')
    console.error('TITLE: / DESCRIPTION: / ---BODY--- の3つが必要です。')
    console.error('--- 受け取った内容（先頭400字）---')
    console.error(raw.slice(0, 400))
    process.exit(1)
  }

  const issues = verifyArticle({
    parsed,
    items,
    existingTitles: await existingTitles(),
    stopReason,
  })
  const typeIssues = type.verify(parsed.body, items)

  for (const i of issues) console.log(`  [${i.level === 'error' ? 'NG' : '警告'}] ${i.message}`)
  for (const m of typeIssues) console.log(`  [NG] ${m}`)

  if (hasError(issues) || typeIssues.length > 0) {
    console.error('\n品質ゲートを通過しませんでした。記事は書き出しません。')
    console.error('本文を直して、もう一度 --apply してください。')
    process.exit(1)
  }
  if (issues.length === 0) console.log('  品質ゲート: 問題なし')

  const ctx = { theme, now }
  const md = buildMarkdown({
    parsed,
    category: type.category,
    tags: type.tags(items, ctx),
    sources: [
      { label: ATTRIBUTION.text, url: ATTRIBUTION.url },
      { label: '作品タイトル（Wikidata・CC0）', url: 'https://www.wikidata.org/' },
    ],
    dataAsOf: now,
    pubDate: now,
    offsetMinutes: theme.utc_offset_minutes,
  })

  const path = join(POSTS_DIR, `${type.slug(ctx)}.md`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, md, 'utf8')

  const ledger = await loadLedger()
  ledger.usedRankingThemes.push(`article:${type.slug(ctx)}`)
  await saveLedger(ledger)

  console.log(`\n書き出し: ${path}`)
  console.log(`タイトル: ${parsed.title}`)
  console.log(`本文: ${parsed.body.replace(/\s/g, '').length}字`)
  console.log('\n確認: cd site && npm run build')
}

/** --apply: 手元で書いた本文を取り込む */
async function applyDraft(theme: Theme): Promise<void> {
  let ctxRaw: string
  try {
    ctxRaw = await readFile(CONTEXT_PATH, 'utf8')
  } catch {
    console.error(`${CONTEXT_PATH} がありません。先に npm run write -- --emit を実行してください。`)
    process.exit(1)
  }
  const draft = JSON.parse(ctxRaw) as DraftContext

  let response: string
  try {
    response = await readFile(RESPONSE_PATH, 'utf8')
  } catch {
    console.error(`${RESPONSE_PATH} がありません。`)
    console.error(`${PROMPT_PATH} を読んで記事を書き、その内容を ${RESPONSE_PATH} に保存してください。`)
    process.exit(1)
  }

  const type = TYPES[draft.typeId]
  if (!type) throw new Error(`context.json の記事タイプが不明です: ${draft.typeId}`)

  console.log(`下書きを適用します（${type.id} / 素材${draft.items.length}件 / ${draft.createdAt}）\n`)
  await finalize(response, type, draft.items, theme, new Date(draft.createdAt))
}

/** --emit: プロンプトと素材をファイルに書き出す */
async function emitDraft(
  system: string,
  prompt: string,
  type: ArticleType,
  items: ChangeEvent[],
  now: Date,
): Promise<void> {
  await mkdir(DRAFT_DIR, { recursive: true })

  const doc = `# 記事の下書き依頼

このファイルの指示に従って記事を書き、**\`${RESPONSE_PATH}\` に保存**してください。
保存したら \`npm run write -- --apply\` を実行すると、検証を通して記事になります。

- 出力形式（TITLE / DESCRIPTION / ---BODY---）を必ず守ること
- frontmatter は書かないこと（日付・出典はパイプラインが機械的に組み立てる）

---

## 役割・記事の仕様

${system}

---

## 素材

${prompt}
`

  await writeFile(PROMPT_PATH, doc, 'utf8')
  await writeFile(
    CONTEXT_PATH,
    JSON.stringify({ typeId: type.id, createdAt: now.toISOString(), items } satisfies DraftContext, null, 2),
    'utf8',
  )

  console.log(`書き出し: ${PROMPT_PATH}`)
  console.log(`          ${CONTEXT_PATH}`)
  console.log('\n次の手順:')
  console.log(`  1. ${PROMPT_PATH} を読んで記事を書く`)
  console.log(`  2. その内容を ${RESPONSE_PATH} に保存する`)
  console.log('  3. npm run write -- --apply')
  console.log('\n（このセッションなら /article で1〜3を自動化できます）')
}

async function main(): Promise<void> {
  const theme = await loadTheme()

  // --apply は素材を context.json から復元するので、選択処理を行わない
  if (flag('apply')) return await applyDraft(theme)

  const typeId = arg('type') ?? 'leaving'
  const type = TYPES[typeId]
  if (!type) {
    throw new Error(`不明な記事タイプ: ${typeId}（有効: ${Object.keys(TYPES).join(', ')}）`)
  }

  const now = new Date()
  const ctx = { theme, now }
  const month = currentYearMonth(theme.utc_offset_minutes)
  const events = await readEvents(month)
  const ledger = await loadLedger()
  const items = type.select(events, ledger, ctx)

  console.log(`テーマ: ${theme.label}  記事タイプ: ${type.id}`)
  console.log(`素材: ${events.length}件中 ${items.length}件を選択\n`)

  if (items.length === 0) {
    console.log('記事にできる素材がありません。先に npm run collect を実行してください。')
    return
  }

  const { system, prompt } = type.buildPrompt(items, ctx)

  if (flag('dry-run')) {
    console.log('='.repeat(60))
    console.log('SYSTEM')
    console.log('='.repeat(60))
    console.log(system)
    console.log('\n' + '='.repeat(60))
    console.log('PROMPT')
    console.log('='.repeat(60))
    console.log(prompt)
    console.log('\n' + '='.repeat(60))
    console.log(`概算: system ${system.length}字 / prompt ${prompt.length}字`)
    console.log('--dry-run のためAPIは呼んでいません。')
    return
  }

  if (flag('emit')) return await emitDraft(system, prompt, type, items, now)

  // --- API で生成 ---
  const llm = createProvider({ provider: arg('provider'), model: arg('model') })
  console.log(`生成中... (${llm.name} / ${llm.model})`)

  const result = await llm.generate({
    system,
    prompt,
    maxTokens: MAX_TOKENS,
    effort: (arg('effort') as 'low' | 'medium' | 'high') ?? 'medium',
  })

  const cost = result.costUnknown
    ? 'コスト不明（LLM_PRICE_INPUT / LLM_PRICE_OUTPUT 未設定）'
    : `$${result.costUsd.toFixed(4)}`
  console.log(
    `完了: 入力 ${result.usage.inputTokens} / 出力 ${result.usage.outputTokens} トークン  ${cost}\n`,
  )

  await finalize(result.text, type, items, theme, now, result.stopReason)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
