/**
 * 配信カレンダーのバナー広告を、**どの社の面に何を出すか**だけを決める1か所。
 *
 * ■ 置き場所
 * 升目（EventCalendar）と日付めくり（DayPager）のあいだ。1ページに1枚だけ
 * （2026-09-19・運用者の指定）。描くのは `components/CalendarBanner.astro`。
 *
 * ■ 割り当て（2026-09-19・運用者の指定）
 *
 *   Amazon Prime Video  → Amazon（Prime Video のストアフロント）
 *   Disney+             → Amazon（**提携が通ったら差し替える**。いまは埋め合わせ）
 *   Netflix             → Hulu（afb）
 *
 * ★ **Netflix に Hulu を出すのは、面のサービスと広告主が一致しない唯一の枠。**
 *   Netflix にアフィリエイト提携先が無く（docs/AFFILIATE.md）、
 *   読者がその面で求めているのは「終わる作品を他でどう観るか」なので、
 *   **別サービスの入口であること自体は読者の用から外れていない。**
 *   運用者が承知のうえで決めた割り当て（「ここだけサービスと一致しませんが仕方なし」）。
 *
 * ★ **Disney+ に Hulu を出さないこと。** Hulu の掲載ガイドライン１）が
 *   ディズニー作品・Disney+ を掲載NGにしている（`hulu-ad.ts` の BLOCKED_SERVICES）。
 *   ここで Hulu を返しても `huluAd()` が null を返して消えるだけだが、
 *   **割り当ての段階で書かない**（読んだ人が「出るはず」と誤解しないため）。
 *
 * ■ この枠は `AmazonCta` / `PrimeCta` を**置き換えた**（足したのではない）
 * それまでカレンダーの末尾に出していた「PR／Amazonプライム／このページには…」の
 * テキスト枠は 2026-09-19 に廃止。**1ページの広告枠は1つのまま。**
 * ★ 枠を戻したくなったら、増やすのではなくどちらかにすること
 *   （docs/AFFILIATE.md 5節・選択肢を増やすと読者は選べなくなる）。
 *
 * ■ PR表記はページ冒頭の `AffiliateNotice` が担う
 * ステマ規制が求めるのは「事業者の表示であることが明瞭」で、位置はむしろ冒頭が要件
 * （docs/AFFILIATE.md 5-5）。**枠の中には置かない**（HuluCta と同じ扱い）。
 * 🔴 **カレンダーページから `AffiliateNotice` を消すと、この枠が無表示の広告になる。**
 */
/** どちらの広告主を出すか。**当てはまらない社には何も出さない**（null） */
export type CalendarBannerKind = 'amazon' | 'hulu'

/** Amazon のバナーを出す社。**Disney+ は提携が通るまでの埋め合わせ**（上の★） */
const AMAZON_SERVICES = ['prime-video', 'disney-plus']

/** Hulu（afb）のバナーを出す社。 */
const HULU_SERVICES = ['netflix']

/**
 * その社のカレンダーに出すバナーの広告主。
 *
 * ★ 社が増えたときに**黙ってどれかが出る形にしないこと。** 割り当ては上の2つの表だけ。
 *   新しい社は、提携の有無を確かめてからどちらかに足す。
 * ★ 原稿（画像・リンク）はここが持たない。
 *   Amazon は `components/AmazonBanner.astro`、Hulu は `lib/hulu-ad.ts`。
 */
export function calendarBanner(service: string): CalendarBannerKind | null {
  const key = service.trim().toLowerCase()
  if (AMAZON_SERVICES.includes(key)) return 'amazon'
  if (HULU_SERVICES.includes(key)) return 'hulu'
  return null
}
