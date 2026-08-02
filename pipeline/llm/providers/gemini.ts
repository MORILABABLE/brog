/**
 * Google Gemini アダプタ。
 *
 * generateContent エンドポイントを直接叩く。構造化出力機能は使わない
 * （プロバイダ非依存を保つため）。
 *
 * モデルIDは環境変数で指定する。手元に2026年時点の確実なモデル一覧が無いため、
 * コード側で候補を推測して埋め込むことはしない。料金も同様に
 * LLM_PRICE_INPUT / LLM_PRICE_OUTPUT で明示する（未設定ならコストは「不明」）。
 */
import { calcCost, type GenerateRequest, type GenerateResult, type LLMProvider } from '../types.ts'
import { resolvePrice } from '../pricing.ts'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] }
    finishReason?: string
  }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
  }
}

/** effort を thinkingBudget に大まかに対応させる */
const THINKING_BUDGET: Record<string, number> = {
  low: 0,
  medium: 4096,
  high: 16384,
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini'

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {
    if (!apiKey) throw new Error('GEMINI_API_KEY が未設定です。.env を確認してください。')
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const url = `${BASE}/models/${this.model}:generateContent`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig: {
          maxOutputTokens: req.maxTokens,
          thinkingConfig: { thinkingBudget: THINKING_BUDGET[req.effort ?? 'medium'] ?? 4096 },
        },
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Gemini ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
    }

    const json = (await res.json()) as GeminiResponse
    const candidate = json.candidates?.[0]
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('')

    const usage = {
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    }
    const { price, unknown } = resolvePrice(this.model)

    return {
      text,
      usage,
      costUsd: calcCost(usage, price),
      costUnknown: unknown,
      // MAX_TOKENS は本文が切れているサイン。呼び出し側で弾く。
      stopReason: candidate?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : candidate?.finishReason,
    }
  }
}
