import Schema from '@deepseek-ai/schemastery'

export interface Config {
  autoEnableNewSessions: boolean
  reviewerProvider?: string
  reviewerModel?: string
  reviewTimeoutMs: number
  maxAttempts: number
  maxReviewRounds: number
  maxInputBytes: number
  maxReadBytes: number
  maxDirectoryEntries: number
  maxConcurrentReviews: number
  maxConsecutiveDenials: number
  denialWindowSize: number
  maxRecentDenials: number
}

const integer = (value: number) => Schema.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).default(value)

export const Config: Schema<Config> = Schema.object({
  autoEnableNewSessions: Schema.boolean().default(true),
  reviewerProvider: Schema.string().min(1),
  reviewerModel: Schema.string().min(1),
  reviewTimeoutMs: Schema.number().min(1).max(2_147_483_647).step(1).default(90_000),
  maxAttempts: integer(3),
  maxReviewRounds: integer(8),
  maxInputBytes: integer(131_072),
  maxReadBytes: integer(32_768),
  maxDirectoryEntries: integer(256),
  maxConcurrentReviews: integer(4),
  maxConsecutiveDenials: integer(3),
  denialWindowSize: integer(50),
  maxRecentDenials: integer(10),
})

export function validateConfig(config: Config): void {
  if (config.reviewerProvider !== undefined && !config.reviewerProvider.trim()
    || config.reviewerModel !== undefined && !config.reviewerModel.trim()) {
    throw new Error('Reviewer route must contain non-whitespace provider and model names')
  }
  if (Boolean(config.reviewerProvider?.trim()) !== Boolean(config.reviewerModel?.trim())) {
    throw new Error('reviewerProvider and reviewerModel must be configured together')
  }
  if (config.maxRecentDenials > config.denialWindowSize) {
    throw new Error('maxRecentDenials must not exceed denialWindowSize')
  }
}
