/**
 * 記事を生成する。
 *
 *   npm run write -- --dry-run        LLMを呼ばずにプロンプトだけ表示（無料）
 *   npm run write                     生成して site/ に書き出す
 *   npm run write -- --provider gemini --model xxx
 *
 * ■ --dry-run を先に用意している理由
 * プロンプトが意図通り組み上がっているかは、APIを叩かなくても確認できる。
 * テンプレートを直すたびに課金するのは無駄なので、まず --dry-run で見る。
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadTheme } from '../theme.ts'
import { loadLedger, readEvents, saveLedger } from '../core/events.ts'
import { currentYearMonth } from '../core/datetime.ts'
import { buildMarkdown, parseArticle, type ArticleType } from '../core/article.ts'
import { hasError, verifyArticle } from '../core/verify.ts'
import { createProvider } from '../llm/index.ts'
import { ATTRIBUTION } from '../sources/streaming-availability.ts'
import { leavingArticle } from '../../theme-packs/streaming-jp/article-types/leaving.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // CI では .env を置かない
}

const POSTS_DIR = join('site', 'src', 'content', 'posts')
const MAX_TOKENS = 16_000

const TYPES: Record<string, ArticleType> = {
  leaving: leavingArticle,
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

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

async function main(): Promise<void> {
  const theme = await loadTheme()
  const typeId = arg('type') ?? 'leaving'
  const type = TYPES[typeId]
  if (!type) {
    throw new Error(`不明な記事タイプ: ${typeId}（有効: ${Object.keys(TYPES).join(', ')}）`)
  }

  const now = new Date()
  const ctx = { theme, now }

  // --- 素材を選ぶ ---
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

  // --- dry-run: プロンプトを見るだけ ---
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

  // --- 生成 ---
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

  // --- パース ---
  const parsed = parseArticle(result.text)
  if (!parsed) {
    console.error('LLMの出力を解釈できませんでした。指定した出力形式に従っていません。')
    console.error('--- 生の出力（先頭500字）---')
    console.error(result.text.slice(0, 500))
    process.exit(1)
  }

  // --- 検証 ---
  const issues = verifyArticle({
    parsed,
    items,
    existingTitles: await existingTitles(),
    stopReason: result.stopReason,
  })
  const typeIssues = type.verify(parsed.body, items)

  for (const i of issues) {
    console.log(`  [${i.level === 'error' ? 'NG' : '警告'}] ${i.message}`)
  }
  for (const m of typeIssues) {
    console.log(`  [NG] ${m}`)
  }

  if (hasError(issues) || typeIssues.length > 0) {
    console.error('\n品質ゲートを通過しませんでした。記事は書き出しません。')
    process.exit(1)
  }
  if (issues.length === 0) console.log('  品質ゲート: 問題なし')

  // --- 書き出し ---
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

  // 記事化した素材を台帳に記録し、次回以降は選ばれないようにする
  ledger.usedRankingThemes.push(`article:${type.slug(ctx)}`)
  await saveLedger(ledger)

  console.log(`\n書き出し: ${path}`)
  console.log(`タイトル: ${parsed.title}`)
  console.log('\n確認: cd site && npm run dev')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
