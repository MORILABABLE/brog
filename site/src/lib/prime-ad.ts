/**
 * Amazonプライムのメンバー紹介（無料体験 500円/件）を**どのページに出すか**の判断と文言。
 *
 * **出す・出さないの判断も、文言も、ここ1か所にある。**
 * コンポーネント（`components/PrimeCta.astro`）は、ここが返したものを描くだけ。
 * U-NEXT 側（`lib/unext-ad.ts`）と同じ形にそろえてある。
 *
 * ■ なぜこの枠が要るのか
 * **商品の購入とは成果の取り方が違う。**
 *
 *   商品の購入            どのタグ付きリンクでもよい。クリックから24時間のクッキーが拾う
 *   プライム無料体験 500円  **専用リンクを踏ませないと0円。** クッキーでは取れない
 *
 * Amazon 公式（アソシエイト・プログラム紹介料率表 別紙）が
 * 「`https://www.amazon.co.jp/amazonprime?tag=…` のリンクを経由した場合のみ」と
 * 明記している。つまり**1本のリンクで両取りはできない**ので、枠を分ける。
 * 経緯は docs/AFFILIATE.md 3-0、設計は docs/FUNNEL.md 7-6。
 *
 * ■ 出してよい面が限られる（**ここが一番大事**）
 * 無料体験の訴求が成り立つのは、そのページに
 * **「いま Prime Video の見放題で観られる作品」が並んでいるとき**だけ。
 *
 * 見放題が終わった作品のページで「プライム会員になろう」と書くと、
 * 読者は「会員になればこれが観られる」と読む。**それは事実ではない。**
 * 性質としては U-NEXT ガイドライン【4】の誤認訴求と同じで、
 * `works.ts` 冒頭の「絶対に守ること」と同じ線引きをここでも引く。
 *
 * ★ **2026-09-06 の実測で、作品ページはこの条件を1枚も満たさない。**
 *
 *     Amazon Prime Video × 終了済み            211枚
 *     Amazon Prime Video × 終了予定日を経過      21枚
 *     Amazon Prime Video × 終了予定（まだ観られる）**0枚**
 *
 *   「まだ観られる」28枚は全部 Netflix で、Netflix には提携先が無い。
 *   **だから作品ページにはこの枠を出さない。** 面が増えるのを待つのではなく、
 *   条件を満たしたときに自動で出る形にしてある（下の `primeAd()`）。
 *
 * ■ 枠を増やさない
 * すでに Amazon の導線は6種類ある。**この枠は `AmazonCta` を置き換える**もので、
 * 並べて足すものではない。Amazonアソシエイトは
 * 「サイトの主目的がアフィリエイトリンク」だと審査で落ちる（docs/AFFILIATE.md）。
 */
import { amazonTagFor, type CategorySlug } from '../config'
import { primeTrialUrl } from './affiliate'

/** Prime Video のサービスキー（`config.ts` の SERVICES と揃える） */
const PRIME_KEY = 'prime-video'

/** Prime Video の表示名。記事は frontmatter の `tags` にこの文字列を持つ。 */
const PRIME_LABEL = 'Amazon Prime Video'

/**
 * この枠を出してよいカテゴリ。
 *
 *   arrivals … 見放題に入ったばかり。**いま観られる**
 *   leaving  … 終了予定。**まだ観られる**（締切があるぶん訴求としてはむしろ強い）
 *   ended    … **出さない。** もう観られない
 *
 * ★ `ended` を足したくなったら、この注意書きごと読み直すこと。
 *   「終了した作品も他にたくさんあります」は言えるが、
 *   **そのページの主題は終わった作品**なので、読者の期待とずれる。
 */
const OK_CATEGORIES: readonly CategorySlug[] = ['arrivals', 'leaving']

export interface PrimeAd {
  url: string
  lead: string
  action: string
  note: string
}

/**
 * 文言。**ここにある言い回し以外を出さない。**
 *
 * ★ **「今なら」「期間限定」を書かない。** 無料体験は常設で、
 *   条件も期間も Amazon 側の都合で変わる。煽ると、変わった日に嘘になる。
 *   U-NEXT 側（`unext-ad.ts` の COPY）と同じ規律。
 *
 * ★ **「◯日間無料」と日数を書かない。** 同じ理由。日数は Amazon が決める。
 *
 * ★ **作品名を書かない。** 「この作品が観られます」と読ませないため。
 *   訴求しているのは会員特典であって、個別の作品の在庫ではない。
 */
type Stance = 'upcoming' | 'arrivals' | 'leaving' | 'calendar'

const COPY: Record<Stance, { lead: string }> = {
  /*
   * 配信カレンダー（`/calendar/prime-video`）。**終了予定と新着が同じ面に並ぶ。**
   *
   * ★ `leaving` や `arrivals` の文言を流用してはいけない。
   *   どちらも「このページの作品は〜です」と**面の全部**について名乗る書き方で、
   *   2種類が混ざったページで使うと、片方について嘘になる。
   *   ここは「並んでいます」と書いて、2種類あることを先に言う。
   */
  calendar: {
    lead: 'このページには、Amazon Prime Video で見放題配信の終了予定日が公表されている作品と、見放題配信が始まった作品が並んでいます。見放題の作品は、Amazonプライム会員なら追加料金なしで観られます。',
  },
  upcoming: {
    lead: 'このページの作品は、Amazon Prime Video で見放題配信が始まる予定のものです。見放題の作品は、Amazonプライム会員なら追加料金なしで観られます。',
  },
  arrivals: {
    lead: 'このページの作品は、Amazon Prime Video で見放題配信が始まったものです。見放題の作品は、Amazonプライム会員なら追加料金なしで観られます。',
  },
  leaving: {
    lead: 'このページの作品は、Amazon Prime Video で見放題配信の終了予定日が公表されているものです。見放題の作品は、Amazonプライム会員なら追加料金なしで観られます。',
  },
}

/**
 * ★ **1文目は「当サイトが観測したこと」だけを言う。**
 *
 * 「このページの作品は Prime Video の見放題です」と書きたくなるが、
 * **それは在庫の断定になる**（`works.ts` 冒頭「絶対に守ること」）。
 * 当サイトが持っているのは変化の観測で、いま観られるかは知らない。
 * 8月の新着記事を11月に読んだ読者に「見放題です」と言うと、それは嘘になる。
 *
 * だから 1文目は「始まった」「始まる予定」「終了予定日が公表されている」で止め、
 * **2文目で「見放題の作品は会員なら追加料金なし」という一般の事実**を言う。
 * 訴求しているのは会員特典であって、個別の作品の在庫ではない。
 *
 * ★ この書き分けを崩さないこと。崩すと U-NEXT ガイドライン【4】の
 *   誤認訴求と同じ構造になる（`unext-ad.ts` の COPY と同じ規律）。
 */

/** 配信開始「予定」の記事に付くタグ（theme-packs の `tags()` が書く） */
const UPCOMING_TAG = '配信開始予定'

const ACTION = 'Amazonプライムの無料体験を見る'

/**
 * ★ **リンク先が案内ページであることを必ず書く。**
 *   料金・特典・無料体験の条件は Amazon 側で変わる。
 *   こちらで数字を書かず、確認先を示すのが唯一の正しい書き方
 *   （`AmazonCta.astro` の `.note` と同じ線引き）。
 */
const NOTE =
  'リンク先はAmazonプライムの案内ページです。特典・料金・無料体験の条件はAmazon側でご確認ください。'

export interface PrimeAdInput {
  /** 常設ページのサービスキー（`/leaving/<service>` の `<service>`） */
  service?: string
  /** 記事の frontmatter の `tags`。サービス名の文字列が入っている */
  tags?: readonly string[]
  /** ページのカテゴリ */
  category?: CategorySlug
  /**
   * 配信カレンダー（`/calendar/<サービス>`）から呼ぶときだけ `true`。
   *
   * ★ カレンダーは**終了予定と新着が同居する面**で、カテゴリを1つに決められない。
   *   `category` を渡すと、渡さなかったほうの作品について文言が嘘になる。
   *   専用の文言（`COPY.calendar`）に切り替えるための印。
   *
   * ★ **`ended` は混ざらない。** カレンダーが読むのは
   *   `loadLeaving()`（これから終了する＝まだ観られる）と
   *   `loadArrivals()`（見放題に入った）の2つだけ（lib/events-data.ts）。
   *   終了済みを足したくなったら、この枠を出す条件から見直すこと。
   */
  calendar?: boolean
}

/**
 * この面にプライムの枠を出すか。**出すなら文言ごと返す。**
 * 出さないときは `null`（呼び出し側は `AmazonCta` に落とす）。
 *
 * ★ **トラッキングIDが未設定なら必ず `null`。**
 *   IDの無いリンクを置いても1円にもならず、
 *   広告表記（PR）だけが出てしまう（`AFFILIATE_ENABLED` と同じ考え方）。
 */
export function primeAd(input: PrimeAdInput): PrimeAd | null {
  const tag = amazonTagFor('prime')
  if (!tag) return null

  const category = input.category
  // カレンダーはカテゴリを持たない面。中身は leaving と arrivals だけなので条件を満たす
  if (!input.calendar && (!category || !OK_CATEGORIES.includes(category))) return null

  // 主題が Prime Video であること。常設ページはキー、記事はタグで判定する。
  const isPrime = input.service === PRIME_KEY || (input.tags ?? []).includes(PRIME_LABEL)
  if (!isPrime) return null

  // ★ ジャンル軸の記事は複数サービスを横断する。**そこには出さない。**
  //   文言が「このページの作品は Amazon Prime Video で…」と名乗るので、
  //   他社の作品が混ざっている記事では嘘になる。
  //   サービス軸の記事はタグにサービスが1つしか入らない（templates/naming.md）。
  const services = (input.tags ?? []).filter((t) => SERVICE_TAGS.has(t))
  if (services.length > 1) return null

  // ★ 配信開始「予定」は arrivals の中に混じっている（記事タイプが同じカテゴリを使う）。
  //   「始まった」と書くと予定日前の作品を観られると読ませるので、タグで分ける。
  const stance: Stance = input.calendar
    ? 'calendar'
    : category === 'leaving'
      ? 'leaving'
      : (input.tags ?? []).includes(UPCOMING_TAG)
        ? 'upcoming'
        : 'arrivals'

  return { url: primeTrialUrl(tag), lead: COPY[stance].lead, action: ACTION, note: NOTE }
}

/**
 * 記事のタグに現れるサービス名。**横断記事を弾くためだけに使う。**
 * `config.ts` の SERVICES と揃えること（増えたらここも足す）。
 */
const SERVICE_TAGS = new Set([
  'Amazon Prime Video',
  'Netflix',
  'U-NEXT',
  'Disney+',
  'Apple TV+',
  'Hulu',
])
