/**
 * Anthropic (Claude) アダプタ。
 *
 * 公式SDKを使う。抽象化はこのアダプタの境界で保たれているので、
 * ここで公式SDKを使っても差し替え可能性は損なわれない。
 * 逆にSDKのリトライ・型付きエラーが使えるぶん堅くなる。
 *
 * ■ 注意（Claude Opus 5 / Sonnet 5 固有）
 * - temperature / top_p / top_k を送ると 400 になる。共通インターフェースに
 *   これらを含めていないのはこのため。
 * - thinking は既定でON（adaptive）。深さは output_config.effort で制御する。
 * - budget_tokens は廃止済み。
 */
import Anthropic from '@anthropic-ai/sdk'
import { calcCost, type GenerateRequest, type GenerateResult, type LLMProvider } from '../types.ts'
import { resolvePrice } from '../pricing.ts'

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  #client: Anthropic

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY が未設定です。.env を確認してください。')
    this.#client = new Anthropic({ apiKey })
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const res = await this.#client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
      output_config: { effort: req.effort ?? 'medium' },
    })

    // content は thinking / text などの混在配列。text だけを拾う。
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')

    const usage = {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    }
    const { price, unknown } = resolvePrice(this.model)

    return {
      text,
      usage,
      costUsd: calcCost(usage, price),
      costUnknown: unknown,
      stopReason: res.stop_reason ?? undefined,
    }
  }
}
