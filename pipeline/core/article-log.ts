/**
 * **書いた記事を、もう一度同じ条件で作り直せるようにするための控え。**
 *
 * ■ なぜ要るか（2026-09-02 追加）
 * シリーズ記事（`article-types/series.ts`）は**同じURLを何か月も書き直す**記事で、
 * 状態（終了予定／終了済み／見放題に復帰）は素材から自動で決まる。
 * つまり「書き直せば正しくなる」ように作ってある。
 *
 * **ところが書き直すのに必要な指示が、どこにも残っていなかった。**
 *
 *   npm run write -- --type series --topic "「名探偵コナン」劇場版シリーズ" --slug conan-movies --match "名探偵コナン" --emit
 *
 * このうち `--topic` と `--match` は**人が決めた値**で、記事の frontmatter にも
 * 本文にも入らない。残っているのは運用者のシェル履歴だけで、
 * 数か月後に「コナンの記事を終了済みへ移す」と思っても、
 * **どの正規表現で束ねたのかを思い出すところから始まる。**
 *
 * だから書き出したときに、その記事を作った指示ごと1件記録しておく。
 * 控えがあれば、書き直しどきの判定（`core/stale.ts`）も
 * 貼れるコマンドの組み立ても、人の記憶に頼らずにできる。
 *
 * ■ 台帳（`data/ledger.json`）と分ける理由
 * 台帳が持っているのは「この変化はもう拾った」という**素材側の既出管理**で、
 * 記事1本ぶんの単位を持っていない（`usedRankingThemes` に `article:<スラッグ>` を
 * 積んでいるが、これはスラッグの文字列だけで、指示は入っていない）。
 * ここが持つのは**記事側の作り方**なので、混ぜると両方が読みにくくなる。
 *
 * ■ frontmatter に書かない理由
 * `--match` はサイトの読者には何の意味も無い運用の値で、
 * 記事ページに出す理由がない。frontmatter に足すと
 * `site/src/content.config.ts` のスキーマにも足すことになり、
 * **サイト側が運用の都合を知る**形になる。控えは `data/` に置く。
 *
 * ■ 記事タイプを知らない
 * 記録するのは記事タイプが宣言したフラグ（`ArticleType.flags`）の値そのままで、
 * このファイルは意味を解釈しない。`variants` や `flags` と同じ考え方で、
 * 記事タイプが増えてもここは変わらない。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { variantFlag, type ArticleType } from './article.ts'

export const ARTICLE_LOG_PATH = join('data', 'articles.json')

/** 書き出した記事1本ぶん。**この内容だけで同じ記事をもう一度作れること。** */
export interface ArticleRecord {
  /** 記事のスラッグ。**控えの主キー**（同じスラッグ＝同じURL＝同じ記事） */
  slug: string
  /** `--type` の値 */
  typeId: string
  /** バリアント（`--genre` / `--service`）のキー。持たない記事タイプでは undefined */
  variantKey?: string
  /** `--month`。書き直すときも同じ月を対象にする */
  targetMonth: string
  /** 記事タイプが宣言したフラグの値（`--topic` / `--slug` / `--match` など） */
  flags?: Record<string, string>
  /**
   * 書き出した時点のカテゴリ。**書き直しどきの判定はここと今の計算結果を比べる**
   * （`core/stale.ts`）。記事の frontmatter からも読めるが、
   * 人が手で直したときに控えと食い違うことが分かるよう、両方を持っておく。
   */
  category: string
  /**
   * その記事が拠って立つデータの基準日（記事の `dataAsOf` と同じ意味）。
   * **これより後に期日が過ぎた作品**が、書き直しどきの手がかりになる。
   */
  writtenAt: string
}

interface ArticleLogFile {
  articles: ArticleRecord[]
  updatedAt: string
}

/** 控えを読む。無ければ空。**壊れていても記事生成は止めない**（控えは補助） */
export async function loadArticleLog(): Promise<ArticleRecord[]> {
  try {
    const raw = await readFile(ARTICLE_LOG_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ArticleLogFile>
    return Array.isArray(parsed.articles) ? parsed.articles : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * 1本ぶんを記録する。**同じスラッグは上書きする**（同じURLの記事は1件しかない）。
 *
 * ★ スラッグ順に並べて書く。台帳と同じ理由で、git の差分を追加行だけにするため。
 */
export async function recordArticle(record: ArticleRecord): Promise<void> {
  const articles = (await loadArticleLog()).filter((a) => a.slug !== record.slug)
  articles.push(record)
  articles.sort((a, b) => a.slug.localeCompare(b.slug))

  const body: ArticleLogFile = { articles, updatedAt: new Date().toISOString() }
  await mkdir(dirname(ARTICLE_LOG_PATH), { recursive: true })
  await writeFile(ARTICLE_LOG_PATH, JSON.stringify(body, null, 2) + '\n', 'utf8')
}

/**
 * シェルにそのまま貼れる形の値。半角英数字と `._/-` だけならそのまま、
 * それ以外（空白・日本語・`|` などの正規表現）は二重引用符で囲む。
 *
 * ★ 囲むのは**二重引用符**。PowerShell でも bash でも同じ意味になり、
 *   運用者が中身だけ書き換えるときに引用符の種類で迷わない。
 */
export function shellValue(v: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(v) ? v : `"${v.replace(/"/g, '""')}"`
}

/**
 * 控え1件を、**そのまま貼れる1行のコマンド**に戻す。
 *
 * ■ なぜ文字列で返すのか
 * 書き直しは記事1本ずつ人が確かめながら進める作業で、
 * 一覧にも通知にも「次にこれを打てばよい」という形で出したい。
 * **控えの値をそのまま並べるだけ**にしてあるので、
 * 記事タイプがフラグを増やしてもここは変わらない。
 *
 * ★ **必ず1行にする。** 折り返すと PowerShell では続かず、
 *   2行目以降のフラグが落ちたまま実行される（`cli/write.ts` の
 *   `assertNoLineContinuation`）。読みにくくても1行のまま出すこと。
 */
export function rewriteCommand(record: ArticleRecord, type: ArticleType, tail = '--emit'): string {
  const parts = ['npm run write --', `--type ${record.typeId}`]
  if (record.variantKey) parts.push(`--${variantFlag(type)} ${record.variantKey}`)
  for (const f of type.flags ?? []) {
    const v = record.flags?.[f.name]
    if (v !== undefined) parts.push(`--${f.name} ${shellValue(v)}`)
  }
  /*
   * ★ 月を名乗る記事だけ `--month` を付ける。既定は当月なので、
   *   先月の記事を書き直すときに付けないと**別の月の記事**が出来上がる。
   *   月を名乗らない記事（`evergreen`）に付けると、URLに月が入らないのに
   *   コマンドだけが月を持つ形になり、読む人を迷わせる。
   */
  if (!type.evergreen) parts.push(`--month ${record.targetMonth}`)
  return [...parts, tail].join(' ')
}
