/**
 * モデル別の料金表（100万トークンあたりUSD）。
 *
 * Anthropic の料金は公式の値を持っているが、他社は変動が速く手元に
 * 信頼できる表が無い。推測値を入れて誤った比較をするより、
 * 環境変数で明示させ、未設定なら「不明」と正直に報告する方針にしている。
 *
 *   LLM_PRICE_INPUT=0.30   （100万入力トークンあたりUSD）
 *   LLM_PRICE_OUTPUT=2.50
 */
import type { Price } from './types.ts'

/** Anthropic の公式料金（2026-08-01 時点） */
const ANTHROPIC_PRICING: Record<string, Price> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

/**
 * Claude Sonnet 5 の導入価格。2026-08-31 まで $2/$10。
 * bench の比較を正しく出すため期間判定して適用する。
 */
const SONNET5_INTRO = {
  until: Date.parse('2026-09-01T00:00:00Z'),
  price: { input: 2, output: 10 } satisfies Price,
}

/** 環境変数で明示された単価。無ければ undefined。 */
function priceFromEnv(): Price | undefined {
  const input = Number(process.env.LLM_PRICE_INPUT)
  const output = Number(process.env.LLM_PRICE_OUTPUT)
  if (Number.isFinite(input) && Number.isFinite(output)) return { input, output }
  return undefined
}

export interface ResolvedPrice {
  price: Price
  /** 料金が確定できず 0 を返している場合 true */
  unknown: boolean
}

export function resolvePrice(model: string, now = Date.now()): ResolvedPrice {
  const env = priceFromEnv()
  if (env) return { price: env, unknown: false }

  if (model === 'claude-sonnet-5' && now < SONNET5_INTRO.until) {
    return { price: SONNET5_INTRO.price, unknown: false }
  }

  const known = ANTHROPIC_PRICING[model]
  if (known) return { price: known, unknown: false }

  return { price: { input: 0, output: 0 }, unknown: true }
}
