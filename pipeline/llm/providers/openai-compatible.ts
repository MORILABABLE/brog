/**
 * OpenAI互換 Chat Completions アダプタ。
 *
 * このアダプタ1枚で以下をすべてカバーする:
 *   OpenAI / DeepSeek / Groq / OpenRouter / Together / Ollama（ローカル）
 * 違いは LLM_BASE_URL とモデルIDだけ。
 *
 * 構造化出力（response_format）は使わない。プロバイダによって対応状況が
 * バラバラで、差し替え可能性を壊すため。
 */
import { calcCost, type GenerateRequest, type GenerateResult, type LLMProvider } from '../types.ts'
import { resolvePrice } from '../pricing.ts'

interface ChatResponse {
  choices?: {
    message?: { content?: string }
    finish_reason?: string
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = 'openai-compat'

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {
    if (!baseUrl) {
      throw new Error('LLM_BASE_URL が未設定です（例: https://api.openai.com/v1）。')
    }
    // Ollama など認証不要のローカルサーバもあるため、キー未設定は許容する
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${this.baseUrl} ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
    }

    const json = (await res.json()) as ChatResponse
    const choice = json.choices?.[0]

    const usage = {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    }
    const { price, unknown } = resolvePrice(this.model)

    return {
      text: choice?.message?.content ?? '',
      usage,
      costUsd: calcCost(usage, price),
      costUnknown: unknown,
      // length は本文が切れているサイン
      stopReason: choice?.finish_reason === 'length' ? 'max_tokens' : choice?.finish_reason,
    }
  }
}
