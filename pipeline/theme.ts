/**
 * テーマパックの読み込み。
 *
 * パイプライン本体はテーマの中身を知らず、この形に正規化されたものだけを扱う。
 * テーマ差し替え = theme-packs/ 配下のディレクトリを差し替えること。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { SearchLinkConfig } from './core/search-links.ts'
import type { ArticleType } from './core/article.ts'
import type { UnextConfig } from './sources/unext.ts'
import type { AnnouncementConfig } from './sources/announcement.ts'

export interface CatalogConfig {
  /** テーマ内で使う安定したキー。記事やファイル名で使う。 */
  key: string
  /** 表示名 */
  label: string
  /** API 側のカタログID（例: netflix, prime.subscription） */
  id: string
  /**
   * expiring / upcoming（未来の変化）に対応しているか。
   * Streaming Availability API 側の制約で、対応は
   * Netflix / Prime Video / Disney+ / Apple TV / Max / Mubi のみ。
   */
  supports_upcoming: boolean
}

export interface Theme {
  key: string
  label: string
  /** ISO 3166-1 alpha-2（小文字） */
  country: string
  /**
   * API に送る出力言語。Streaming Availability API は en/es/fr/tr/de のみ対応。
   * サイトの言語とは別物である点に注意。
   */
  api_language: string
  /**
   * ブログを書く言語。Wikidata から正式タイトルを引くときのラベル言語にも使う。
   */
  site_language: string
  /**
   * サイトの基準タイムゾーン（UTCからの分オフセット）。
   * 開発機はJST・CIはUTCで動くため、日付の表示と月別集計は必ずこれを経由する。
   * 日本なら 540。
   */
  utc_offset_minutes: number
  show_types: ('movie' | 'series')[]
  catalogs: CatalogConfig[]
  /**
   * 対象外サービスへの検索リンク。
   * 配信状況のデータを持たないサービスに、断定せずに導線だけを作るための設定。
   */
  search_links?: SearchLinkConfig[]
  /**
   * U-NEXT の収集設定。
   *
   * catalogs（Streaming Availability API）と別枠なのは、素性がまったく違うため。
   * catalogs は API のカタログID、こちらはサイトのメニューIDで、
   * 取得手段も（API / 実ブラウザ）別物。同じ配列に混ぜると両方が歪む。
   * 未設定なら U-NEXT の収集を行わない。
   */
  unext?: UnextConfig
  /**
   * 各社が前月末に出す「翌月の配信開始ラインナップ」の告知。
   *
   * catalogs（API）とも unext（実ブラウザ）とも別枠なのは、取れるものが違うため。
   * ここから取れるのは**まだ始まっていない配信の予定**だけで、
   * API の `upcoming` が日本では0件を返し続けている穴を埋める。
   * 未設定なら告知の取り込みを行わない。
   */
  announcements?: AnnouncementConfig[]
}

export const THEME_ROOT = 'theme-packs'

/** 環境変数 THEME で切り替え可能。既定は streaming-jp。 */
export function activeThemeKey(): string {
  return process.env.THEME ?? 'streaming-jp'
}

export async function loadTheme(key = activeThemeKey()): Promise<Theme> {
  const path = join(THEME_ROOT, key, 'theme.yaml')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error(`テーマパックが見つかりません: ${path}`)
  }

  const theme = parse(raw) as Theme

  // 最低限の検証。ここが壊れていると後段が静かに空回りするため早期に落とす。
  if (!theme.catalogs?.length) throw new Error(`${path}: catalogs が空です`)
  if (!theme.show_types?.length) throw new Error(`${path}: show_types が空です`)
  if (!theme.country) throw new Error(`${path}: country が未設定です`)
  if (!theme.api_language) throw new Error(`${path}: api_language が未設定です`)
  if (!theme.site_language) throw new Error(`${path}: site_language が未設定です`)
  if (typeof theme.utc_offset_minutes !== 'number') {
    throw new Error(`${path}: utc_offset_minutes が未設定です（日本なら 540）`)
  }

  const dupes = theme.catalogs
    .map((c) => c.key)
    .filter((k, i, a) => a.indexOf(k) !== i)
  if (dupes.length) throw new Error(`${path}: catalogs.key が重複しています: ${dupes.join(', ')}`)

  // unext は任意。書いてあるなら、収集が空振りしないところまで見ておく。
  // IDが1つ欠けるとそのジャンルだけ静かに0件になるため、ここで落とす。
  if (theme.unext) {
    const u = theme.unext
    if (!u.service_key) throw new Error(`${path}: unext.service_key が未設定です`)
    if (!u.genres?.length) throw new Error(`${path}: unext.genres が空です`)
    for (const g of u.genres) {
      const lack = (['key', 'label', 'id', 'arrivals', 'all'] as const).filter((k) => !g[k])
      if (lack.length) {
        throw new Error(
          `${path}: unext.genres[${g.key ?? '?'}] の ${lack.join(', ')} が未設定です` +
            '（`npm run unext:menu` で調べ直せます）',
        )
      }
    }
    const gd = u.genres.map((g) => g.key).filter((k, i, a) => a.indexOf(k) !== i)
    if (gd.length) throw new Error(`${path}: unext.genres.key が重複しています: ${gd.join(', ')}`)
  }

  // announcements も任意。1つでも欠けると収集が静かに空振りするので、ここで落とす。
  for (const a of theme.announcements ?? []) {
    const lack = (['service', 'label', 'publisher', 'parser', 'url'] as const).filter((k) => !a[k])
    if (lack.length) {
      throw new Error(`${path}: announcements[${a.service ?? '?'}] の ${lack.join(', ')} が未設定です`)
    }
    if (!a.url.includes('{')) {
      throw new Error(
        `${path}: announcements[${a.service}].url に月を埋める場所がありません` +
          '（{year} / {month_en} / {month} のいずれかを含めます）',
      )
    }
  }

  return theme
}

/** テーマパック内のファイルパス */
export function themeFile(theme: Theme, ...parts: string[]): string {
  return join(THEME_ROOT, theme.key, ...parts)
}

/**
 * テーマパックが提供する記事タイプを読み込む。
 *
 * ■ なぜ動的インポートか
 * 記事タイプはテーマ固有の資産で、増減する。パイプライン側に
 * `import { leavingArticle } from '../../theme-packs/streaming-jp/...'` と書くと、
 * 記事を1種類増やすたびにパイプラインを直すことになり、
 * 「テーマパックを差し替えるだけ」という前提が崩れる。
 *
 * テーマパックは `article-types/index.ts` から `ARTICLE_TYPES` を出す約束。
 */
export async function loadArticleTypes(theme: Theme): Promise<ArticleType[]> {
  const specifier = `../theme-packs/${theme.key}/article-types/index.ts`
  let mod: { ARTICLE_TYPES?: ArticleType[] }
  try {
    mod = (await import(specifier)) as { ARTICLE_TYPES?: ArticleType[] }
  } catch (err) {
    throw new Error(
      `テーマ ${theme.key} の記事タイプを読み込めません（${THEME_ROOT}/${theme.key}/article-types/index.ts）: ` +
        (err instanceof Error ? err.message : String(err)),
    )
  }
  if (!mod.ARTICLE_TYPES?.length) {
    throw new Error(`${THEME_ROOT}/${theme.key}/article-types/index.ts が ARTICLE_TYPES を出していません`)
  }
  return mod.ARTICLE_TYPES
}
