/**
 * 常設ページの一覧。**左の枠とカテゴリページの両方がここを読む。**
 *
 * ページを増やす・減らす・並べ替えるときはこのファイルだけを直せばよい。
 * 表示の形は使う側（LeftRail / EvergreenCard）が決める。
 *
 * ★ `/stats`（見放題の増減）はここに入れていない。
 *   読者にとって用途が伝わりにくく、記事の並びに混ぜると浮くため
 *   （2026-08-23 の判断）。ページ自体は残してあり、
 *   常設ページ下部の関連リンクから辿れる（＝孤立ページにはしない）。
 */
import { ARRIVALS_SERVICES, LEAVING_SERVICES } from './events-data'
import type { CategorySlug } from '../config'

export interface EvergreenPage {
  href: string
  /** 一覧に出す見出し。記事タイトルと並ぶので体裁を揃える。 */
  title: string
  /** カテゴリバッジ。styles/global.css の .badge[data-category] と対応する。 */
  category: CategorySlug
  /** サムネイルのキー。src/assets/services/<キー>.png を探す。 */
  thumbKey: string
  /** サービス表示名 */
  label: string
  /**
   * 幅の狭い場所で使う短い名前。
   *
   * ★ 左の枠は1200px時点で文字に使える幅が約158pxしか無く、
   *   「Amazon Prime Video」は2行に折り返してカードの高さが不揃いになる。
   *   1行に収まる名前をここに持たせて並びを保つ。
   */
  shortLabel: string
}

/** 表示名 → 左の枠で使う短い名前 */
const SHORT_LABELS: Record<string, string> = {
  'Amazon Prime Video': 'Prime Video',
}

function shortOf(label: string): string {
  return SHORT_LABELS[label] ?? label
}

export const EVERGREEN_PAGES: EvergreenPage[] = [
  ...LEAVING_SERVICES.map((s) => ({
    href: `/leaving/${s.key}`,
    title: `${s.label}で配信終了予定の作品一覧`,
    category: 'leaving' as CategorySlug,
    thumbKey: s.key,
    label: s.label,
    shortLabel: shortOf(s.label),
  })),
  ...ARRIVALS_SERVICES.map((s) => ({
    href: `/arrivals/${s.key}`,
    title: `${s.label}で最近見放題になった作品一覧`,
    category: 'arrivals' as CategorySlug,
    thumbKey: s.key,
    label: s.label,
    shortLabel: shortOf(s.label),
  })),
]

/** 指定カテゴリの常設ページだけを返す */
export function evergreenFor(category: CategorySlug): EvergreenPage[] {
  return EVERGREEN_PAGES.filter((p) => p.category === category)
}
