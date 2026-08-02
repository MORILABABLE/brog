/**
 * 環境変数から LLM プロバイダを組み立てる。
 *
 *   LLM_PROVIDER=anthropic       LLM_MODEL=claude-sonnet-5
 *   LLM_PROVIDER=gemini          LLM_MODEL=<モデルID>
 *   LLM_PROVIDER=openai-compat   LLM_MODEL=deepseek-chat  LLM_BASE_URL=https://api.deepseek.com/v1
 *
 * 差し替えはこの3行のどれかを .env で切り替えるだけ。
 * 呼び出し側（write.ts / bench.ts）はどのプロバイダかを一切知らない。
 */
import { AnthropicProvider } from './providers/anthropic.ts'
import { GeminiProvider } from './providers/gemini.ts'
import { OpenAICompatibleProvider } from './providers/openai-compatible.ts'
import type { LLMProvider } from './types.ts'

export type ProviderName = 'anthropic' | 'gemini' | 'openai-compat'

const DEFAULT_MODEL: Record<ProviderName, string> = {
  anthropic: 'claude-sonnet-5',
  gemini: '',
  'openai-compat': '',
}

export interface ProviderOptions {
  provider?: string
  model?: string
}

export function createProvider(opts: ProviderOptions = {}): LLMProvider {
  const name = (opts.provider ?? process.env.LLM_PROVIDER ?? 'anthropic') as ProviderName
  const model = opts.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL[name] ?? ''

  switch (name) {
    case 'anthropic':
      return new AnthropicProvider(model || DEFAULT_MODEL.anthropic, process.env.ANTHROPIC_API_KEY ?? '')

    case 'gemini':
      if (!model) throw new Error('gemini を使うには LLM_MODEL にモデルIDを設定してください。')
      return new GeminiProvider(model, process.env.GEMINI_API_KEY ?? '')

    case 'openai-compat':
      if (!model) throw new Error('openai-compat を使うには LLM_MODEL にモデルIDを設定してください。')
      return new OpenAICompatibleProvider(
        model,
        process.env.OPENAI_API_KEY ?? '',
        process.env.LLM_BASE_URL ?? '',
      )

    default:
      throw new Error(
        `不明な LLM_PROVIDER: ${name}（有効: anthropic / gemini / openai-compat）`,
      )
  }
}

export type { LLMProvider, GenerateRequest, GenerateResult, Effort } from './types.ts'
