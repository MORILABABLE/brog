/**
 * afb のリンクコードに共通する決まりごと。
 *
 * **広告主が2社になったので切り出した**（2026-09-14・U-NEXT / Hulu）。
 * 枠名と `id1` の付け方がずれると、成果データの「キーワード」列で
 * 2社を並べて読めなくなる。**そこが揃っていることがこのファイルの目的。**
 *
 * ■ リンクコードは勝手に改変できない（docs/AFFILIATE.md 11-3）
 * afb が明示的に認めている改変は3つだけ。
 *   - `target="_blank"` を外す
 *   - `rel="noopener"` を足す
 *   - `rel="nofollow"` を `rel="sponsored"` に替える
 * ＋ **パラメータの追加**（`id1`〜`id5`）。`a=` `p=` には触れない。
 */

/**
 * 枠。**Amazon 側の AMAZON_SLOTS と同じ名前を使う**（affiliate.ts）。
 * 揃えておくと「同じ枠で Amazon と afb のどちらが効いたか」を並べて読める。
 *
 * afb ではリンクコードの末尾に `&id1=<枠>` として付ける。成果データの
 * `keyword` 欄に返ってくる（docs/AFFILIATE.md 11-4）。
 */
export const AFB_SLOTS = ['cta', 'rail', 'work', 'table', 'poster', 'body'] as const
export type AfbSlot = (typeof AFB_SLOTS)[number]

/**
 * 表示計測の 1x1 画像を HTML に出してよいビルドか。**Cloudflare Pages の本番（`main`）だけ。**
 *
 * ■ なぜ要るか（2026-09-17）
 * 1x1 はただの `<img>` なので、**そのHTMLをブラウザで開いた人が誰でも表示を1回送る。**
 * `site/.env` にも同じ値が入っているため、`astro dev` / `astro preview` で手元のページを
 * 開くたびに afb の表示回数が増えていた。同日、表示崩れの確認で作品ページを
 * 自動ブラウザで一通り開き、**Hulu の枠がある549枚ぶんを送ってしまった**
 * （運用者が管理画面で「今日すごく増えた」と気づいた）。表示回数とクリック率が読めなくなる。
 *
 * ■ どこで出るか
 *   Cloudflare Pages・`main` のビルド … 出す（本番のHTMLは以前と同じ）
 *   Pages のプレビュー（`*.pages.dev`）… 出さない（本番ドメインではない。LinkSwitch と同じ扱い＝docs/AFFILIATE.md 5-6）
 *   手元・GitHub Actions のビルド      … 出さない（Actions のビルドは検査だけで、配信していない）
 *
 * ★ **原稿から要素を落とす改変ではない**（docs/AFFILIATE.md 11-3）。本番の読者には原稿どおり出ている。
 * ★ 判定を環境変数のもう1つに逃がさないこと。手元で `CF_PAGES` を立てると本番扱いになり、
 *   同じことがまた起きる。
 * ★ **バナーのリンク自体は手元にも出る。** 手元で押すと自己クリックになるので押さない。
 */
export const AFB_IMPRESSION_BUILD = Boolean(process.env.CF_PAGES) && process.env.CF_PAGES_BRANCH === 'main'

/**
 * id1 に使える文字（afb の仕様）。半角英数字と `.` `-` `_` `*` だけ。
 * 日本語や `=` `&` `/` は使えない。**枠名を増やすときはここを通ること。**
 */
export const SLOT_OK = /^[A-Za-z0-9._*-]+$/

/**
 * リンクコードに枠（`id1`）を足す。
 *
 * ★ **`id1` を .env のリンクに自分で書かないこと。** ここが付けるので二重になる。
 */
export function withSlot(href: string, slot: AfbSlot): string {
  if (!href || !SLOT_OK.test(slot)) return href
  try {
    const u = new URL(href)
    u.searchParams.set('id1', slot)
    return u.toString()
  } catch {
    // リンクコードが URL として読めない形（貼り間違い）。
    // 勝手に文字列連結して壊すより、そのまま返して検査に見つけさせる。
    return href
  }
}
