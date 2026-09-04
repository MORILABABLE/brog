/**
 * 広告主のガイドラインで禁じられている言い回し。
 *
 * ■ なぜ独立したファイルなのか
 * 同じ一覧を2か所が読む。**片方だけ直すと静かに食い違う。**
 *   pipeline/core/verify.ts      … 記事を書いた瞬間に止める（公開前）
 *   pipeline/cli/check-unext.ts  … 組み上がったHTMLを検査する（公開物）
 *
 * ■ 出どころ
 * U-NEXT アフィリエイトガイドライン（2026年9月3日改訂）。
 * 違反すると提携解除に加えて**過去分を含む成果の全件却下**になるので、
 * 「書いてから直す」では間に合わない。書けないようにしておく。
 *
 * ■ 単語ではなく言い回しで持つ
 * 「見放題」「無料トライアル」自体は禁止語ではない。
 * 禁じられているのは**誤認させる組み合わせ**で、単語で止めると
 * サイト名（見放題レーダー）や正しい記述まで巻き込む。
 *
 * ★ ここに足すのは**ガイドラインに書いてあることだけ**。
 *   「なんとなく危なそう」を足すと、正しい記述が書けなくなる。
 */
export interface AdPolicyRule {
  pattern: RegExp
  /** どの条項か。運用者が原文に当たれるように条番号を残す */
  why: string
}

export const AD_POLICY_BANNED: AdPolicyRule[] = [
  { pattern: /無料で見放題/, why: 'U-NEXT【4】「無料で見放題」と訴求すること' },
  {
    pattern: /(すべて|全て|全部|全作品)(が|の作品が)?見放題/,
    why: 'U-NEXT【4】「全ての動画が見放題」と訴求すること（ポイント作品があるため）',
  },
  { pattern: /[0-9０-９]+万本(が)?見放題/, why: 'U-NEXT【4】「◯万本見放題」と訴求すること' },
  {
    pattern: /無料で(視聴|観|見)(られ|れ|る|放題)/,
    why: 'U-NEXT【11】作品に対する「無料で視聴できる」訴求の禁止',
  },
  {
    pattern: /(期間限定|今だけ|いまだけ|今なら|いまなら)/,
    why: 'U-NEXT【4】定常キャンペーンを期間限定と誤認させる訴求の禁止',
  },
  { pattern: /リトライ(キャンペーン)?/, why: 'U-NEXT【8】リトライキャンペーンの訴求禁止' },
  { pattern: /1490/, why: 'U-NEXT【9】月額プラン1490の訴求・掲載の禁止' },
  {
    pattern: /(ムフフ|その他♡)/,
    why: 'U-NEXT【12】アダルト（その他♡ジャンル）を連想させる表現の禁止',
  },
  {
    pattern: /(すべて|全て)の(電子書籍|コミック).{0,6}読み放題/,
    why: 'U-NEXT【4】「全ての電子書籍・コミックが読み放題」と訴求すること',
  },
]

/** 当たった言い回しを返す。**空なら問題なし。** */
export function adPolicyHits(text: string): { found: string; why: string }[] {
  const out: { found: string; why: string }[] = []
  for (const rule of AD_POLICY_BANNED) {
    const m = text.match(rule.pattern)
    if (m) out.push({ found: m[0], why: rule.why })
  }
  return out
}
