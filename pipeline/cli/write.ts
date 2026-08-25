/**
 * 記事を生成する。
 *
 * ── どの記事が作れるかを見る
 *   npm run write -- --list
 *
 * ── A. API で生成（課金あり）
 *   npm run write -- --type arrivals --genre anime
 *
 * ── B. このターミナル（Claude Code等）で生成（API課金なし）
 *   npm run write -- --type arrivals --genre anime --emit
 *   （prompt.md を読んで記事を書き、data/draft/response.md に保存）
 *   npm run write -- --apply    → 検証して site/ に書き出す
 *
 *   スラッシュコマンド /article で上記を自動化できる。
 *
 * ── C. プロンプトの確認だけ（無料）
 *   npm run write -- --type arrivals --genre anime --dry-run
 *
 * ■ なぜ分割するか
 * 検証・frontmatter組み立て・書き出しは、どの方式でも共通の処理。
 * 「プロンプトを作る」と「応答を適用する」に分ければ、
 * 生成手段だけを差し替えられる。品質ゲートはどの経路でも必ず通る。
 *
 * ■ 記事タイプはここに書かない
 * どんな記事があるかはテーマパックの `article-types/index.ts` が決める。
 * この CLI は記事タイプの中身を知らないまま、一覧・選択・実行だけを担う。
 * 記事を1種類増やしてもこのファイルは変わらない。
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadArticleTypes, loadTheme, type Theme } from '../theme.ts'
import { loadLedger, readAllEvents, saveLedger } from '../core/events.ts'
import { currentYearMonth } from '../core/datetime.ts'
import {
  buildMarkdown,
  parseArticle,
  type ArticleType,
  type ArticleVariant,
} from '../core/article.ts'
import { hasError, verifyArticle } from '../core/verify.ts'
import { createProvider } from '../llm/index.ts'
import { ATTRIBUTION } from '../sources/streaming-availability.ts'
import type { ChangeEvent } from '../sources/types.ts'

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

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

/** --apply のときに素材を復元するための保存内容 */
interface DraftContext {
  typeId: string
  createdAt: string
  /** 記事が対象とする月。--emit 時の指定を --apply でも再現するため保存する。 */
  targetMonth?: string
  /** 選択したバリアント（ジャンル）。同じく --apply で再現するため保存する。 */
  variantKey?: string
  items: ChangeEvent[]
}

/** 「記事タイプ×バリアント」1通り。これが記事1本に対応する。 */
interface Recipe {
  type: ArticleType
  variant?: ArticleVariant
}

/** 登録されている記事タイプから、作れる記事の組み合わせをすべて並べる。 */
function recipes(types: ArticleType[]): Recipe[] {
  return types.flatMap((type) =>
    type.variants?.length ? type.variants.map((variant) => ({ type, variant })) : [{ type }],
  )
}

/** バリアントのCLIフラグ名。既定は genre（ジャンル別記事が元の形だったため）。 */
function variantFlag(type: ArticleType): string {
  return type.variantFlag ?? 'genre'
}

/** バリアントの人間向けの呼び方。エラー文と一覧の見出しに使う。 */
function variantNoun(type: ArticleType): string {
  return type.variantNoun ?? 'ジャンル'
}

function recipeLabel(r: Recipe): string {
  return r.variant ? `${r.type.id} --${variantFlag(r.type)} ${r.variant.key}` : r.type.id
}

/**
 * frontmatter に載せる出典。**素材の出どころから機械的に決める。**
 *
 * ★ 固定で書いてはいけない。U-NEXT は Streaming Availability API から
 *   取っていないので、一律に載せると**取得していないAPIを出典として偽る**。
 *   記事タイプ側で書き分けると、タイプを増やしたときの書き分け漏れが
 *   そのまま嘘の出典になるため、データ側から決める。
 */
function sourcesFor(items: ChangeEvent[]): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = []

  if (items.some((e) => e.work.meta.source !== 'u-next')) {
    out.push({ label: ATTRIBUTION.text, url: ATTRIBUTION.url })
    out.push({ label: '作品タイトル（Wikidata・CC0）', url: 'https://www.wikidata.org/' })
  }
  if (items.some((e) => e.work.meta.source === 'u-next')) {
    out.push({
      label: '配信状況・見放題終了日は U-NEXT の作品ページに掲載されている情報',
      url: 'https://video.unext.jp/',
    })
  }
  return out
}

/**
 * 既存記事のタイトル一覧（重複検知用）。
 *
 * これから書き出すファイル自身は除く。除かないと、
 * 一度書き出した記事を直して再実行したときに
 * 「同じタイトルの記事が既に存在します」で自分自身に弾かれ、
 * 記事を修正できなくなる。
 */
async function existingTitles(excludeSlug: string): Promise<string[]> {
  try {
    const files = await readdir(POSTS_DIR)
    const titles: string[] = []
    for (const f of files.filter((f) => f.endsWith('.md') && f !== `${excludeSlug}.md`)) {
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
  recipe: Recipe,
  items: ChangeEvent[],
  theme: Theme,
  now: Date,
  targetMonth: string,
  stopReason?: string,
): Promise<void> {
  const { type } = recipe
  const parsed = parseArticle(raw)
  if (!parsed) {
    console.error('出力を解釈できませんでした。指定した形式に従っていません。')
    console.error('TITLE: / DESCRIPTION: / ---BODY--- の3つが必要です。')
    console.error('--- 受け取った内容（先頭400字）---')
    console.error(raw.slice(0, 400))
    process.exit(1)
  }

  const ctx = { theme, now, targetMonth, variant: recipe.variant }
  const slug = type.slug(ctx)
  const issues = [
    ...verifyArticle({
      parsed,
      items,
      existingTitles: await existingTitles(slug),
      stopReason,
    }),
    ...type.verify(parsed.body, items, ctx),
  ]

  for (const i of issues) console.log(`  [${i.level === 'error' ? 'NG' : '警告'}] ${i.message}`)

  if (hasError(issues)) {
    console.error('\n品質ゲートを通過しませんでした。記事は書き出しません。')
    console.error('本文を直して、もう一度 --apply してください。')
    process.exit(1)
  }
  if (issues.length === 0) console.log('  品質ゲート: 問題なし')

  const md = buildMarkdown({
    parsed,
    category: type.category,
    tags: type.tags(items, ctx),
    sources: sourcesFor(items),
    dataAsOf: now,
    pubDate: now,
    offsetMinutes: theme.utc_offset_minutes,
  })

  const path = join(POSTS_DIR, `${slug}.md`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, md, 'utf8')

  const ledger = await loadLedger()
  ledger.usedRankingThemes.push(`article:${slug}`)
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

  const type = (await loadArticleTypes(theme)).find((t) => t.id === draft.typeId)
  if (!type) throw new Error(`context.json の記事タイプが不明です: ${draft.typeId}`)

  const variant = draft.variantKey
    ? type.variants?.find((v) => v.key === draft.variantKey)
    : undefined
  if (draft.variantKey && !variant) {
    throw new Error(
      `context.json の${variantNoun(type)}が不明です: ${draft.typeId} / ${draft.variantKey}`,
    )
  }

  const now = new Date(draft.createdAt)
  const targetMonth = draft.targetMonth ?? currentYearMonth(theme.utc_offset_minutes)

  console.log(
    `下書きを適用します（${recipeLabel({ type, variant })} / 対象 ${targetMonth} / ` +
      `素材${draft.items.length}件 / ${draft.createdAt}）\n`,
  )
  await finalize(response, { type, variant }, draft.items, theme, now, targetMonth)
}

/** --emit: プロンプトと素材をファイルに書き出す */
async function emitDraft(
  system: string,
  prompt: string,
  recipe: Recipe,
  items: ChangeEvent[],
  now: Date,
  targetMonth: string,
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
    JSON.stringify(
      {
        typeId: recipe.type.id,
        createdAt: now.toISOString(),
        targetMonth,
        variantKey: recipe.variant?.key,
        items,
      } satisfies DraftContext,
      null,
      2,
    ),
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

/**
 * --list: 作れる記事を素材の件数つきで並べる。
 *
 * 記事タイプが増えても、使う側はこれを見れば選べる。
 * スラッシュコマンドに記事の一覧を書き写さずに済ませるための入口。
 */
async function listRecipes(theme: Theme, targetMonth: string, now: Date): Promise<void> {
  const events = await readAllEvents()
  const ledger = await loadLedger()
  const existing = new Set(
    (await readdir(POSTS_DIR).catch(() => []))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, '')),
  )

  console.log(`テーマ: ${theme.label}  対象月: ${targetMonth}  収集済み ${events.length}件\n`)
  console.log('  記事                              素材  状態  スラッグ')
  console.log('  ' + '-'.repeat(72))

  for (const r of recipes(await loadArticleTypes(theme))) {
    const ctx = { theme, now, targetMonth, variant: r.variant }
    const items = r.type.select(events, ledger, ctx)
    const slug = r.type.slug(ctx)
    const min = r.type.minItems ?? 0
    const state = existing.has(slug)
      ? '作成済'
      : items.length === 0
        ? '素材なし'
        : // 少ない月に無理に1本立てると表がスカスカの記事になる。
          // 止めはしないが、運用者が気づけるように出す。
          items.length < min
          ? '素材不足'
          : '未作成'
    console.log(
      `  ${recipeLabel(r).padEnd(32)}${String(items.length).padStart(4)}  ${state.padEnd(6)}${slug}`,
    )
  }

  console.log('\n書き出す:  npm run write -- --type <記事> [--<区分> <値>] --emit')
  console.log('           区分は上の一覧に出ている形（--genre / --service）をそのまま使う')
}

/** `--type` と バリアントのフラグ（`--genre` / `--service`）から作る記事を1つに決める。 */
function pickRecipe(types: ArticleType[]): Recipe {
  const all = recipes(types)
  const typeId = arg('type') ?? types[0]!.id
  const type = types.find((t) => t.id === typeId)
  if (!type) {
    throw new Error(
      `不明な記事タイプ: ${typeId}（有効: ${types.map((t) => t.id).join(', ')}）\n` +
        '  一覧は npm run write -- --list',
    )
  }

  const flag = variantFlag(type)
  const noun = variantNoun(type)
  const picked = arg(flag)
  if (!type.variants?.length) {
    if (picked) throw new Error(`記事タイプ ${type.id} は${noun}で分かれていません（--${flag} は不要）`)
    return { type }
  }

  if (!picked) {
    throw new Error(
      `記事タイプ ${type.id} には --${flag} が必要です（有効: ${type.variants.map((v) => v.key).join(' / ')}）\n` +
        `  例: npm run write -- --type ${type.id} --${flag} ${type.variants[0]!.key} --emit`,
    )
  }
  const variant = type.variants.find((v) => v.key === picked)
  if (!variant) {
    throw new Error(
      `不明な${noun}: ${picked}（${type.id} で有効: ${type.variants.map((v) => v.key).join(' / ')}）`,
    )
  }
  return all.find((r) => r.type === type && r.variant === variant)!
}

async function main(): Promise<void> {
  const theme = await loadTheme()

  // --apply は素材を context.json から復元するので、選択処理を行わない
  if (flag('apply')) return await applyDraft(theme)

  const now = new Date()
  const targetMonth = arg('month') ?? currentYearMonth(theme.utc_offset_minutes)
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
    throw new Error(`--month は YYYY-MM 形式で指定してください: ${targetMonth}`)
  }

  if (flag('list')) return await listRecipes(theme, targetMonth, now)

  const recipe = pickRecipe(await loadArticleTypes(theme))
  const { type } = recipe

  const ctx = { theme, now, targetMonth, variant: recipe.variant }
  const events = await readAllEvents()
  const ledger = await loadLedger()
  const items = type.select(events, ledger, ctx)

  console.log(`テーマ: ${theme.label}  記事: ${recipeLabel(recipe)}  対象月: ${targetMonth}`)
  console.log(`素材: ${events.length}件中 ${items.length}件を選択\n`)

  if (items.length === 0) {
    console.log(`${targetMonth} を対象にできる素材がありません。先に npm run collect を実行してください。`)
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

  if (flag('emit')) return await emitDraft(system, prompt, recipe, items, now, targetMonth)

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

  await finalize(result.text, recipe, items, theme, now, targetMonth, result.stopReason)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
