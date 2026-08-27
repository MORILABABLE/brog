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
 *
 * ■ ショート動画の台本（2026-08-25 追加）
 * `buildShortPrompt` を実装した記事タイプは、記事と同時に台本のたたき台を作る。
 *   --emit  … prompt.md の末尾に台本の指示が付く
 *   --apply … data/draft/short.md があれば shorts/<スラッグ>.md に書き出す
 * **台本は記事の品質ゲートを通らない**（別ファイル・検査はすべて warn）。
 * 台本の不備で記事の公開が止まるのは優先順位が逆なので、そう作ってある。
 * B（LLM API）経路では台本を作らない。/article だけが作る。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadArticleTypes, loadTheme, type Theme } from '../theme.ts'
import { loadLedger, readAllEvents, saveLedger } from '../core/events.ts'
import { currentYearMonth } from '../core/datetime.ts'
import {
  buildMarkdown,
  parseArticle,
  type ArticleContext,
  type ArticleType,
  type ArticleVariant,
} from '../core/article.ts'
import { hasError, verifyArticle } from '../core/verify.ts'
import {
  articleUrl,
  buildShortMarkdown,
  estimateSeconds,
  hashtags,
  parseShort,
  speechChars,
  verifyShort,
} from '../core/short.ts'
import { loadFixedPhrases, render } from '../core/fixed-phrases.ts'
import { themeFile } from '../theme.ts'
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
/** ショート動画の台本の下書き。★ response.md に混ぜない（下の finalizeShort 参照） */
const SHORT_DRAFT_PATH = join(DRAFT_DIR, 'short.md')
/**
 * 出来上がった台本の置き場。**docs/ でも data/ でもなくリポジトリ直下。**
 * ユーザーが手で開いて詰める前提のファイルなので、生成物置き場にも読み物にも入れない。
 * git で管理して、手を入れた内容が残るようにする。
 */
const SHORTS_DIR = 'shorts'
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
  /**
   * 記事タイプが宣言したフラグの値（特報の `--topic` など）。
   * ★ これが無いと `--apply` で主題もスラッグも復元できず、別の記事が書き出される。
   */
  flags?: Record<string, string>
  items: ChangeEvent[]
}

/** 「記事タイプ×バリアント」1通り。これが記事1本に対応する。 */
interface Recipe {
  type: ArticleType
  variant?: ArticleVariant
  /** 記事タイプが `flags` で宣言したフラグの値。宣言していない記事タイプでは undefined。 */
  flags?: Readonly<Record<string, string>>
}

/** 登録されている記事タイプから、作れる記事の組み合わせをすべて並べる。 */
function recipes(types: ArticleType[]): Recipe[] {
  return types.flatMap((type) =>
    type.variants?.length ? type.variants.map((variant) => ({ type, variant })) : [{ type }],
  )
}

/**
 * 作れる記事のスラッグが1つも重複していないことを確かめる。
 *
 * ■ なぜ要るか
 * スラッグは記事の身元そのもので、**同じスラッグ＝同じURL＝同じファイル**。
 * 別々の記事タイプが同じスラッグに落ちると、片方がもう片方を黙って上書きする。
 * いま `arrivals`（ジャンル別）と `arrivals-service`（サービス別）は
 * どちらも `{月}-arrivals-{キー}` の形で、**名前空間を共有している。**
 * 衝突していないのはジャンルキーとサービスキーがたまたま被っていないからにすぎない。
 *
 * 起動のたびに確かめておけば、記事タイプやバリアントを増やした**その場で**分かる。
 */
function assertUniqueSlugs(all: Recipe[], theme: Theme, now: Date, targetMonth: string): void {
  // ★ ここではフラグを渡さない（--list と同じ状態）。フラグでスラッグが決まる記事タイプは
  //   `slug()` が指定なしでも落ちない形にしておくこと（例: `2026-09-special-<slug>`）。
  const seen = new Map<string, string>()
  for (const r of all) {
    const slug = r.type.slug({ theme, now, targetMonth, variant: r.variant })
    const prev = seen.get(slug)
    if (prev) {
      throw new Error(
        `記事のスラッグが重複しています: ${slug}\n` +
          `  「${prev}」と「${recipeLabel(r)}」が同じURLになります。\n` +
          '  1つのURLに2種類の記事は置けません。どちらかの slug() を変えてください。',
      )
    }
    seen.set(slug, recipeLabel(r))
  }
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
 *
 * 書き出したスラッグ・タイトル・タグを返すのは、ショート動画の台本が
 * それらを必要とするため（記事URLと概要欄の組み立て）。
 */
async function finalize(
  raw: string,
  recipe: Recipe,
  items: ChangeEvent[],
  theme: Theme,
  now: Date,
  targetMonth: string,
  stopReason?: string,
): Promise<{ slug: string; title: string; tags: string[] }> {
  const { type } = recipe
  const parsed = parseArticle(raw)
  if (!parsed) {
    console.error('出力を解釈できませんでした。指定した形式に従っていません。')
    console.error('TITLE: / DESCRIPTION: / ---BODY--- の3つが必要です。')
    console.error('--- 受け取った内容（先頭400字）---')
    console.error(raw.slice(0, 400))
    process.exit(1)
  }

  const ctx = { theme, now, targetMonth, variant: recipe.variant, flags: recipe.flags }
  const slug = type.slug(ctx)
  const issues = [
    ...verifyArticle({
      parsed,
      items,
      existingTitles: await existingTitles(slug),
      stopReason,
    }),
    ...type.verify(parsed.body, items, ctx),
    // ★ タイトルは verify() に渡っていない（`ArticleType.verifyTitle` のコメント）。
    //   ここを足すまで、タイトルは長さしか見られていなかった。
    ...(type.verifyTitle?.(parsed.title, ctx) ?? []),
  ]

  for (const i of issues) console.log(`  [${i.level === 'error' ? 'NG' : '警告'}] ${i.message}`)

  if (hasError(issues)) {
    console.error('\n品質ゲートを通過しませんでした。記事は書き出しません。')
    console.error('本文を直して、もう一度 --apply してください。')
    process.exit(1)
  }
  if (issues.length === 0) console.log('  品質ゲート: 問題なし')

  const tags = type.tags(items, ctx)
  const md = buildMarkdown({
    parsed,
    // 特報のようにカテゴリが実行時に決まる記事タイプがある（ArticleType.categoryOf）
    category: type.categoryOf?.(ctx) ?? type.category,
    tags,
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

  return { slug, title: parsed.title, tags }
}

/**
 * ショート動画の台本を書き出す。
 *
 * ■ 記事とは完全に切り離す
 * 記事の書き出しが**成功したあとにだけ**呼ばれ、ここで何が起きても記事は取り消さない。
 * 台本の下書きが無ければ黙って何もしない。検査は `verifyShort` がすべて warn で返す。
 * 台本は人が詰めて完成させるたたき台で、この時点で公開されるものではない。
 * ここを厳しくすると、台本の粗が記事の公開を止めることになり優先順位が逆転する。
 *
 * ■ frontmatter と概要欄は人にもLLMにも書かせない
 * 記事URL・出典表記は機械的に決まる事実で、**出典表記は動画にも義務がある**
 * （YouTube は記事とは別の配布先）。人が毎回書く形にすると、
 * 忘れた回がそのまま規約違反になる。
 */
async function finalizeShort(
  article: { slug: string; title: string; tags: string[] },
  recipe: Recipe,
  items: ChangeEvent[],
  theme: Theme,
  now: Date,
): Promise<void> {
  if (!recipe.type.buildShortPrompt) return

  let raw: string
  try {
    raw = await readFile(SHORT_DRAFT_PATH, 'utf8')
  } catch {
    console.log(`\n（${SHORT_DRAFT_PATH} が無いので台本は作りませんでした）`)
    return
  }

  const short = parseShort(raw)
  if (!short) {
    console.log(`\n[警告] ${SHORT_DRAFT_PATH} を解釈できませんでした。記事はそのまま書き出してあります。`)
    console.log('       NOTE: / ---CUTS--- / カット表 の3つが必要です。')
    return
  }

  // 締めの固定文言。プロンプトに出したものと同じ値でなければ検査が意味を持たない。
  const phrases = loadFixedPhrases(themeFile(theme, 'templates', 'fixed-phrases.md'), [
    'short-closer',
    'short-description',
  ])
  const closer = phrases.get('short-closer')!

  const issues = verifyShort({
    short,
    items,
    closer,
    offsetMinutes: theme.utc_offset_minutes,
  })
  for (const i of issues) console.log(`  [台本/警告] ${i.message}`)

  const url = articleUrl(article.slug)

  /*
   * ★ 出典は記事の frontmatter と**同じ関数**から作る。
   *   概要欄用に別で書き起こすと、U-NEXT の記事に API の帰属表示が付くような
   *   食い違いが静かに生まれる。出どころが違えば表示も違う。
   */
  const sources = sourcesFor(items)
    .map((s) => `${s.label.replace(/^>\s*/, '')}\n${s.url}`)
    .join('\n')

  const description = render(phrases.get('short-description')!, {
    記事タイトル: article.title,
    記事URL: url,
    出典: sources,
    ハッシュタグ: hashtags(article.tags),
  })

  const md = buildShortMarkdown({
    slug: article.slug,
    typeId: recipe.type.id,
    variantKey: recipe.variant?.key,
    articleTitle: article.title,
    articleUrl: url,
    short,
    description,
    generatedAt: now,
    offsetMinutes: theme.utc_offset_minutes,
  })

  const path = join(SHORTS_DIR, `${article.slug}.md`)
  await mkdir(SHORTS_DIR, { recursive: true })
  await writeFile(path, md, 'utf8')

  const chars = short.cuts.reduce((n, c) => n + speechChars(c.narration), 0)
  console.log(`\n台本: ${path}`)
  console.log(
    `      ${short.cuts.length}カット / 読み上げ ${chars}字 / 推定 ${estimateSeconds(short.cuts).toFixed(1)}秒`,
  )
  console.log('      カット画像: cd site && npm run shorts')
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
  // ★ フラグも復元する。無いまま進むと、特報が主題もURLも失った別記事になる。
  const flags = draft.flags ?? {}
  assertRequiredFlags(type, flags)

  console.log(
    `下書きを適用します（${recipeLabel({ type, variant })} / 対象 ${targetMonth} / ` +
      `素材${draft.items.length}件 / ${draft.createdAt}）\n`,
  )
  const recipe = { type, variant, flags: type.flags?.length ? flags : undefined }
  const article = await finalize(response, recipe, draft.items, theme, now, targetMonth)
  await finalizeShort(article, recipe, draft.items, theme, now)
  console.log('\n確認: cd site && npm run build')
}

/** --emit: プロンプトと素材をファイルに書き出す */
async function emitDraft(
  system: string,
  prompt: string,
  recipe: Recipe,
  items: ChangeEvent[],
  ctx: ArticleContext,
): Promise<void> {
  await mkdir(DRAFT_DIR, { recursive: true })

  /*
   * ショート動画の台本。**記事タイプが実装しているときだけ付く。**
   * CLI は台本の中身を知らない（記事タイプの構成を知らないのと同じ扱い）。
   * `ended` のように意図的に実装していないタイプでは、この節がそのまま消える。
   */
  const shortSection = recipe.type.buildShortPrompt?.(items, ctx)

  /*
   * ★ 前の記事の台本を消しておく。
   *   消さないと、記事Aで書いた台本が残ったまま記事Bを --emit → --apply したとき、
   *   **記事Bの台本として記事Aの内容が書き出される**。
   *   記事本体（response.md）は固定文言の検査が食い違いを弾くが、
   *   台本にはそういう歯止めが無いので、ここで断ち切る。
   */
  await rm(SHORT_DRAFT_PATH, { force: true })

  const doc = `# 記事の下書き依頼

このファイルの指示に従って記事を書き、**\`${RESPONSE_PATH}\` に保存**してください。
保存したら \`npm run write -- --apply\` を実行すると、検証を通して記事になります。

- 出力形式（TITLE / DESCRIPTION / ---BODY---）を必ず守ること
- frontmatter は書かないこと（日付・出典はパイプラインが機械的に組み立てる）
${shortSection ? `- 記事を書いたら、続けて**ショート動画の台本**を \`${SHORT_DRAFT_PATH}\` に書くこと（末尾の節）\n` : ''}
---

## 役割・記事の仕様

${system}

---

## 素材

${prompt}
${shortSection ? `\n---\n\n${shortSection}\n` : ''}`

  await writeFile(PROMPT_PATH, doc, 'utf8')
  await writeFile(
    CONTEXT_PATH,
    JSON.stringify(
      {
        typeId: recipe.type.id,
        createdAt: ctx.now.toISOString(),
        targetMonth: ctx.targetMonth,
        variantKey: recipe.variant?.key,
        // ★ 特報の --topic / --slug はここに保存しないと --apply で失われ、
        //   主題の無いタイトルと違うURLの記事が書き出される。
        flags: recipe.flags ? { ...recipe.flags } : undefined,
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
  if (shortSection) console.log(`  2b. ショート動画の台本を ${SHORT_DRAFT_PATH} に保存する`)
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
    const slug = r.type.slug(ctx)

    // ★ 特報のように「何を書くかを毎回指示する」記事タイプは、
    //   指示が無い状態で素材を数えても意味がない。0件と出すと
    //   「素材が無い」と読めてしまうので、そうではないと分かる形にする。
    if (r.type.flags?.some((f) => f.required)) {
      const need = r.type.flags.filter((f) => f.required).map((f) => `--${f.name}`).join(' ')
      console.log(`  ${recipeLabel(r).padEnd(32)}   —  要指示  ${need}`)
      continue
    }

    const items = r.type.select(events, ledger, ctx)
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

/**
 * 記事タイプが宣言したフラグ（`ArticleType.flags`）を CLI から集める。
 *
 * **CLI はフラグの意味を知らない。** 名前も必須かどうかも記事タイプ側の宣言だけを見る。
 * `variants` と同じ考え方で、記事タイプを増やしてもこの関数は変わらない。
 */
function collectFlags(type: ArticleType): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of type.flags ?? []) {
    const v = arg(f.name)
    if (v !== undefined) out[f.name] = v
  }
  return out
}

/** 必須フラグが揃っているか。揃っていなければ、何を渡せばよいかを見せて落とす。 */
function assertRequiredFlags(type: ArticleType, flags: Readonly<Record<string, string>>): void {
  const missing = (type.flags ?? []).filter((f) => f.required && !flags[f.name])
  if (missing.length === 0) return
  const all = (type.flags ?? [])
    .map((f) => `    --${f.name} <値>  ${f.required ? '【必須】' : '（任意）'}${f.description}`)
    .join('\n')
  throw new Error(
    `記事タイプ ${type.id} には ${missing.map((f) => `--${f.name}`).join(' / ')} が必要です。\n` +
      `  この記事タイプが受け取るフラグ:\n${all}`,
  )
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

  const flags = collectFlags(type)
  assertRequiredFlags(type, flags)
  const declared = type.flags?.length ? flags : undefined

  const vFlag = variantFlag(type)
  const noun = variantNoun(type)
  const picked = arg(vFlag)
  if (!type.variants?.length) {
    if (picked) throw new Error(`記事タイプ ${type.id} は${noun}で分かれていません（--${vFlag} は不要）`)
    return { type, flags: declared }
  }

  if (!picked) {
    throw new Error(
      `記事タイプ ${type.id} には --${vFlag} が必要です（有効: ${type.variants.map((v) => v.key).join(' / ')}）\n` +
        `  例: npm run write -- --type ${type.id} --${vFlag} ${type.variants[0]!.key} --emit`,
    )
  }
  const variant = type.variants.find((v) => v.key === picked)
  if (!variant) {
    throw new Error(
      `不明な${noun}: ${picked}（${type.id} で有効: ${type.variants.map((v) => v.key).join(' / ')}）`,
    )
  }
  const base = all.find((r) => r.type === type && r.variant === variant)!
  return { ...base, flags: declared }
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

  const types = await loadArticleTypes(theme)
  assertUniqueSlugs(recipes(types), theme, now, targetMonth)

  if (flag('list')) return await listRecipes(theme, targetMonth, now)

  const recipe = pickRecipe(types)
  const { type } = recipe

  const ctx = { theme, now, targetMonth, variant: recipe.variant, flags: recipe.flags }
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

  if (flag('emit')) return await emitDraft(system, prompt, recipe, items, ctx)

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

  // ★ API経路では台本を作らない。台本には別の指示が要り、2度目の呼び出しになる。
  //   台本は `/article`（このセッションで書く経路）だけが作る。
  await finalize(result.text, recipe, items, theme, now, targetMonth, result.stopReason)
  console.log('\n確認: cd site && npm run build')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
