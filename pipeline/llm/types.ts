/**
 * LLM プロバイダの抽象。
 *
 * ■ 差し替えを本当に効かせるための制約
 * プロバイダ固有機能を一切使わない。具体的には:
 *   - tool use / function calling を使わない
 *   - 各社の構造化出力機能（response_format 等）を使わない
 *   - サンプリングパラメータ（temperature 等）を渡さない
 *     ※ Claude Opus 5 / Sonnet 5 では temperature を送ると 400 になる。
 *       他社に合わせて渡す設計にすると Anthropic で壊れる。
 *
 * 出力の構造化は「区切り記号つきプレーンテキスト」で行い、パイプライン側で
 * パースする（core/article.ts）。JSONではなく区切り形式にしているのは、
 * 長いMarkdown本文をJSON文字列に入れるとエスケープ事故が起きやすいため。
 */

/** 思考の深さ。各プロバイダの近い概念にマップする。 */
export type Effort = 'low' | 'medium' | 'high'

export interface GenerateRequest {
  system: string
  prompt: string
  maxTokens: number
  effort?: Effort
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface GenerateResult {
  text: string
  usage: Usage
  /** 概算コスト（USD）。プロバイダ比較のために必ず返す。 */
  costUsd: number
  /**
   * 正常終了かどうかの判断材料。
   * 'max_tokens' なら本文が途中で切れているので、記事にしてはいけない。
   */
  stopReason?: string
  /** 料金表に無いモデルで costUsd が信用できない場合 true */
  costUnknown?: boolean
}

export interface LLMProvider {
  readonly name: string
  readonly model: string
  generate(req: GenerateRequest): Promise<GenerateResult>
}

/** 100万トークンあたりの単価（USD） */
export interface Price {
  input: number
  output: number
}

export function calcCost(usage: Usage, price: Price): number {
  return (usage.inputTokens / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output
}
