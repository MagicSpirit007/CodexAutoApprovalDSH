import assert from 'node:assert/strict'
import { parseAssessment } from '../lib/assessment.js'
import { REVIEW_POLICY } from '../lib/policy.js'
assert.equal(parseAssessment('{"outcome":"allow"}').outcome, 'allow')
assert.equal(parseAssessment('{"outcome":"allow","risk_level":"critical"}').outcome, 'deny')
assert.ok(REVIEW_POLICY.includes('DeepSeek Harness Auto preset'))
assert.ok(!REVIEW_POLICY.includes('{{ tenant_policy_config }}'))
console.log(JSON.stringify({ node: process.version, platform: process.platform,
  assessment: 'passed', policyAssets: 'passed', entrySyntax: 'checked separately',
  desktopUI: 'not tested', provider: 'not called' }))
