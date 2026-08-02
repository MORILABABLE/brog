/**
 * 対象外サービスへの「検索リンク」を生成する。
 *
 * ■ なぜデータではなくリンクなのか
 * U-NEXT / Hulu / DMM TV の作品別配信状況を取得できるAPIは、
 * 個人ブログの予算では存在しない（TMDB商用$149/月、Watchmode$349/月）。
 *
 * そこで「配信中」と主張する代わりに、各社のサイト内検索へ作品名を渡す
 * リンクだけを生成する。
 *   - 他社データを一切使わないので規約上クリーン
 *   - 「配信中」と断定しないので誤情報にならない
 *   - 読者は1クリックで確認できるため実用性はむしろ高い
 *   - ASPのディープリンクに差し替えれば成果計測もできる
 *
 * ■ URLは実測で検証済み（2026-08-01）
 * theme.yaml の url_template を参照。形式が変わった場合はそこだけ直せばよい。
 */
import type { Work } from '../sources/types.ts'

export interface SearchLinkConfig {
  key: string
  label: string
  /** {query} が作品名（URLエンコード済み）に置換される */
  url_template: string
}

export interface SearchLink {
  key: string
  label: string
  url: string
}

/**
 * 検索に使う文字列を整える。
 *
 * 邦題には区切り記号が含まれることがある（例: ゴースト/ニューヨークの幻）。
 * スラッシュはそのまま渡すと検索がヒットしにくいため空白に開く。
 */
export function searchQuery(work: Work): string {
  return (work.localizedTitle ?? work.title)
    .replace(/[/／]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildSearchLinks(work: Work, configs: SearchLinkConfig[]): SearchLink[] {
  const q = searchQuery(work)
  if (!q) return []

  return configs.map((c) => ({
    key: c.key,
    label: c.label,
    url: c.url_template.replace('{query}', encodeURIComponent(q)),
  }))
}
