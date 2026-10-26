import { createHumanPolicy } from './models.js';

/**
 * PolicyCompiler Interface
 * Translates natural language policy rules or structured configs into a deterministic HumanPolicy object.
 * Phase 1: Deterministic pattern-based compiler / mock fixture (LLM integration reserved for Phase 2).
 */
export class PolicyCompiler {
  /**
   * Compiles natural language input into a structured HumanPolicy JSON.
   */
  static compileFromNaturalLanguage(naturalLanguageText, basePolicyId = 'policy_nl_01') {
    const text = String(naturalLanguageText || '').toLowerCase();
    
    // Extract transaction limit if present (e.g. "$200 per transaction" or "up to $500")
    let maxTransactionAmount = 200;
    const amountMatch = text.match(/\$(\d+[\d,]*(\.\d+)?)/);
    if (amountMatch) {
      maxTransactionAmount = parseFloat(amountMatch[1].replace(/,/g, ''));
    }

    // Category extraction
    const allowedCategories = [];
    if (text.includes('cloud') || text.includes('infrastructure')) allowedCategories.push('cloud_infrastructure');
    if (text.includes('developer') || text.includes('tool')) allowedCategories.push('developer_tools');
    if (text.includes('saas') || text.includes('software')) allowedCategories.push('software_saas');
    if (allowedCategories.length === 0) allowedCategories.push('general', 'cloud_infrastructure', 'developer_tools');

    // Rule flags
    const newMerchantRequiresApproval = text.includes('new merchant') || text.includes('unverified merchant');
    const suspiciousMerchantAction = text.includes('suspicious merchant') && text.includes('block') ? 'BLOCK' : 'BLOCK';

    return createHumanPolicy({
      policyId: basePolicyId,
      name: `Compiled Policy (${basePolicyId})`,
      maxTransactionAmount,
      dailyBudget: 1000,
      allowedCategories,
      newMerchantRequiresApproval,
      suspiciousMerchantAction,
      highRiskAction: 'REQUIRE_APPROVAL',
    });
  }

  /**
   * Returns a pre-configured policy fixture for testing
   */
  static getTestPolicyFixture(overrides = {}) {
    return createHumanPolicy({
      policyId: 'policy_devops_01',
      name: 'DevOps Agent Spending Policy',
      maxTransactionAmount: 200,
      dailyBudget: 1000,
      allowedCategories: ['cloud_infrastructure', 'developer_tools'],
      newMerchantRequiresApproval: true,
      suspiciousMerchantAction: 'BLOCK',
      highRiskAction: 'REQUIRE_APPROVAL',
      ...overrides
    });
  }
}
