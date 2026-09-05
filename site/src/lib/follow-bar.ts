/**
 * 画面下の追従枠（`components/FollowBar.astro`）を**どのページに出すか**の判断。
 *
 * ■ なぜこの枠があるのか
 * 右の追従枠（`FollowRail.astro`）は 75rem(1200px) 以上でしか出ない。
 * つまり**スマホには追従枠が1つも無かった。** 2026-09-05 のビルド実測で、
 * トップページのアフィリエイトリンクは2本しかなく、その内訳は
 *
 *   `cta`  … 記事カード19枚の**下**（`AmazonCta`）。ほぼ到達されない
 *   `rail` … 右の追従枠。**1200px 未満では描画されるが見えない**
 *
 * だった。流入の半数超がスマホなので、そこだけ導線が空いていたことになる。
 * これを埋めるための枠。
 *
 * ■ 追従枠は画面に常にちょうど1つ
 *   75rem 以上 … 右の `FollowRail`
 *   75rem 未満 … 下の `FollowBar`
 * 排他は CSS のメディアクエリで行う（`FollowBar.astro` の `@media`）。
 * **両方が同時に出る幅を作らないこと。** 同じ Amazon の導線が2つ見える。
 */

/**
 * この枠を出すか。**AdSense の審査を出す前に false にする1か所。**
 *
 * ★ AdSense の自動広告のアンカー広告も画面下に fixed で出る。
 *   **両方出すと重なる**（アンカー広告のオン・オフは AdSense の管理画面側にあり、
 *   コードからは見えないので、こちらを手で止めるしかない）。
 *
 * ★ **この場所は AdSense を優先すると決めてある**（2026-09-05・運営者の判断）。
 *   つまりこの枠は AdSense の審査までの暫定。**審査の準備に入ったら false にする。**
 *   人手の作業で、忘れても何の警告も出ない（docs/AFFILIATE.md 10-5）。
 *
 * ★ 「主題が決まっているページは Amazon のまま、決まらないページは AdSense」で
 *   分けたくなったら（docs/AFFILIATE.md 10-5）、この定数を消して
 *   下の `followBarOn()` の中に条件として書くこと。判断を2か所に散らさない。
 */
export const FOLLOW_BAR_ENABLED = true

/**
 * 枠を出すページ。**いま冒頭の広告表記（`AffiliateNotice`）を出している
 * 6種類と完全に一致させてある。**
 *
 * ■ なぜ一致させるのか
 * 景品表示法（ステマ規制）の広告表記は**冒頭に置く**と決めてある
 * （docs/AFFILIATE.md 5-5）。この枠は画面の下に出るので、
 * 冒頭表記の無いページに置くと「ページの下だけに PR がある」状態になる。
 * 枠自体も PR を持っているが、**原則のほうを崩さない。**
 *
 * ★ **ページを足すときは、そのページに `<AffiliateNotice />` も一緒に足すこと。**
 *   ここだけ足すとその原則が静かに崩れる。
 *
 * ■ 出さないもの
 *   `/about` `/contact` `/privacy` `/404` … ポリシー・問い合わせ系。
 *      アフィリエイト広告を乗せない（AdSense の審査でも見られる面）
 *   ハブ（`/category/…` `/archive/…` `/service/…` `/genre/…` `/guide`
 *      `/series` `/stats` `/sitemap` `/person`）… 冒頭表記がまだ無い
 *
 * 2026-09-05 の実測で、全721ページのうち687ページがこの条件に当たる。
 */
const PREFIXES = ['/posts/', '/works/', '/person/', '/leaving/', '/arrivals/']

/**
 * 公開URLの形にそろえる。
 *
 * ★ `npm run dev` と `astro build` で `Astro.url.pathname` の形が違う。
 *   build は `build.format: 'file'` により `.html` が付き、トップは `/index.html`。
 *   dev は拡張子が無い。**両方を同じ文字列に落とす。**
 *   （`layouts/BaseLayout.astro` の `toPublicPath()` と同じ役目だが、
 *   あちらは canonical 用でこちらは判定用。用途が違うので共有していない。）
 */
function publicPathOf(pathname: string): string {
  const p = pathname.replace(/index\.html$/, '').replace(/\.html$/, '')
  return p.length > 1 ? p.replace(/\/$/, '') : '/'
}

/** そのページに下の追従枠を出すか。 */
export function followBarOn(pathname: string): boolean {
  if (!FOLLOW_BAR_ENABLED) return false
  const path = publicPathOf(pathname)
  if (path === '/') return true
  return PREFIXES.some((prefix) => path.startsWith(prefix))
}
