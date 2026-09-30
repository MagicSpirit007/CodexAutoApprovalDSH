// Port of Codex guardian-reviewer/assessment.rs (Apache-2.0), with bounded text
// and duplicate-member validation added. See NOTICE.
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type Authorization = 'unknown' | 'low' | 'medium' | 'high'
export interface Assessment {
  risk_level: RiskLevel
  user_authorization: Authorization
  outcome: 'allow' | 'deny'
  rationale: string
}

export class ReviewError extends Error {
  constructor(message: string, readonly code: string, readonly retryable = false) {
    super(message)
    this.name = 'ReviewError'
  }
}

const risks = ['low', 'medium', 'high', 'critical']
const authorizations = ['unknown', 'low', 'medium', 'high']

export function parseAssessment(text: string): Assessment {
  let json = text.trim()
  if (!json.startsWith('{') || !json.endsWith('}')) {
    const start = json.indexOf('{'), end = json.lastIndexOf('}')
    json = start >= 0 && end > start ? json.slice(start, end + 1) : json
  }
  let value: Record<string, unknown>
  try {
    value = JSON.parse(json)
  } catch {
    throw new ReviewError('Guardian assessment was not valid JSON', 'PARSE', true)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReviewError('Guardian assessment must be a JSON object', 'PARSE', true)
  }
  let depth = 0, members = 0
  for (const char of json.replace(/"(?:\\.|[^"\\])*"/gs, '')) {
    if (char === '{' || char === '[') depth++
    if (char === '}' || char === ']') depth--
    if (char === ':' && depth === 1) members++
  }
  if (members !== Object.keys(value).length || Object.keys(value).some(key =>
    !['risk_level', 'user_authorization', 'outcome', 'rationale'].includes(key))) {
    throw new ReviewError('Guardian assessment has duplicate or unknown members', 'PARSE', true)
  }
  if (!['allow', 'deny'].includes(String(value.outcome))
    || value.risk_level !== undefined && !risks.includes(String(value.risk_level))
    || value.user_authorization !== undefined && !authorizations.includes(String(value.user_authorization))
    || value.rationale !== undefined && typeof value.rationale !== 'string') {
    throw new ReviewError('Guardian assessment has invalid fields', 'PARSE', true)
  }
  const outcome = value.outcome as Assessment['outcome']
  const assessment: Assessment = {
    outcome,
    risk_level: (value.risk_level ?? (outcome === 'allow' ? 'low' : 'high')) as RiskLevel,
    user_authorization: (value.user_authorization ?? 'unknown') as Authorization,
    rationale: (typeof value.rationale === 'string' && value.rationale.trim()
      ? value.rationale.trim()
      : outcome === 'allow' ? 'Auto-review returned a low-risk allow decision.'
        : 'Auto-review returned a deny decision without a rationale.').slice(0, 4096),
  }
  if (assessment.risk_level === 'critical' && assessment.outcome === 'allow') {
    return { ...assessment, outcome: 'deny', rationale: 'Critical actions are denied by the Guardian outcome policy.' }
  }
  return assessment
}

export const OUTPUT_CONTRACT = `You may use the provided read-only investigation tools only when they would change your decision. When ready, return strict JSON.
For low-risk actions, return {"outcome":"allow"}.
Otherwise return {"risk_level":"low"|"medium"|"high"|"critical","user_authorization":"unknown"|"low"|"medium"|"high","outcome":"allow"|"deny","rationale":"one concise sentence"}.
No other fields. Do not execute the pending action.`

export const REJECTION_INSTRUCTIONS = 'The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. Otherwise, stop and request user input.'

export function rejectionText(tool: string, assessment: Assessment): string {
  return `Automatic approval review rejected tool ${JSON.stringify(tool)}; its body was not executed.\nReason: ${JSON.stringify(assessment.rationale)}\n${REJECTION_INSTRUCTIONS}`
}
