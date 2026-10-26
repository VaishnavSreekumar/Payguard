import { createAIAnalysis } from './models.js';

/**
 * AIAnalysisProvider Interface
 */
export class AIAnalysisProvider {
  async analyze(paymentRequest, context = {}) {
    throw new Error('Method not implemented');
  }
}

/**
 * HeuristicAIAnalysisProvider
 * Intelligent pattern-matching analysis provider that scans for prompt injections,
 * merchant risk factors, intent anomalies, and policy-relevant facts.
 */
export class HeuristicAIAnalysisProvider extends AIAnalysisProvider {
  async analyze(paymentRequest, context = {}) {
    const purposeText = `${paymentRequest.purpose} ${paymentRequest.context?.notes || ''}`.toLowerCase();
    const merchantName = (paymentRequest.merchant?.name || '').toLowerCase();
    const merchantDomain = (paymentRequest.merchant?.domain || '').toLowerCase();

    // 1. Comprehensive Prompt Injection & Hijack Detection Patterns
    const injectionPatterns = [
      /ignore/i,
      /override/i,
      /bypass/i,
      /skip/i,
      /forget/i,
      /system\s+administrator/i,
      /system\s+admin/i,
      /injectiondetected/i,
      /return\s+allow/i,
      /alternate\s+vendor/i,
      /disregard/i
    ];

    const injectionIndicators = [];
    for (const pattern of injectionPatterns) {
      const match = purposeText.match(pattern);
      if (match) {
        injectionIndicators.push(`Detected prompt injection pattern: "${match[0]}"`);
      }
    }
    const injectionDetected = injectionIndicators.length > 0;

    // 2. Merchant Risk & Domain Inference
    let merchantRisk = 'low';
    if (paymentRequest.merchant.isSuspicious || merchantName.includes('scam') || merchantName.includes('evil') || merchantDomain.endsWith('.ru') || merchantDomain.includes('crypto')) {
      merchantRisk = 'suspicious';
    } else if (!paymentRequest.merchant.isKnown || paymentRequest.context?.isNewMerchant) {
      merchantRisk = 'medium';
    }

    // 3. Anomaly Level Determination
    let anomalyLevel = 'none';
    if (injectionDetected) {
      anomalyLevel = 'high';
    } else if (merchantRisk === 'suspicious') {
      anomalyLevel = 'high';
    } else if (merchantRisk === 'medium') {
      anomalyLevel = 'low';
    }

    // 4. Policy-Relevant Facts Extraction
    const policyRelevantFacts = [
      `Requested amount: $${paymentRequest.amount.value} ${paymentRequest.amount.currency}`,
      `Merchant domain: ${paymentRequest.merchant.domain} (Category: ${paymentRequest.merchant.category})`,
      `Merchant status: ${paymentRequest.merchant.isKnown ? 'Known/Verified' : 'New/Unverified'}`,
      `Prompt Injection Scan: ${injectionDetected ? 'INJECTION_SUSPECTED' : 'CLEAN'}`
    ];

    const reasoningSummary = injectionDetected
      ? `High-risk anomaly: Adversarial prompt injection pattern detected in payment purpose.`
      : `Intent analysis: Routine purchase request for "${paymentRequest.merchant.name}". Category: ${paymentRequest.merchant.category}.`;

    return createAIAnalysis({
      intent: paymentRequest.purpose || 'Unspecified transaction',
      category: paymentRequest.merchant.category || 'general',
      merchantRisk,
      anomalyLevel,
      injectionDetected,
      injectionIndicators,
      policyRelevantFacts,
      reasoningSummary
    });
  }
}

/**
 * GeminiAIAnalysisProvider
 * Real LLM Provider using Google Gemini REST API
 */
export class GeminiAIAnalysisProvider extends AIAnalysisProvider {
  constructor(apiKey = process.env.AI_PROVIDER_API_KEY || process.env.GEMINI_API_KEY) {
    super();
    this.apiKey = apiKey;
    this.fallback = new HeuristicAIAnalysisProvider();
  }

  async analyze(paymentRequest, context = {}) {
    if (!this.apiKey) {
      return this.fallback.analyze(paymentRequest, context);
    }

    try {
      const prompt = `Analyze this AI agent payment request for security risk and policy context.
Payment Request:
- Agent ID: ${paymentRequest.agentId}
- Merchant: ${paymentRequest.merchant.name} (${paymentRequest.merchant.domain}, category: ${paymentRequest.merchant.category})
- Known Merchant: ${paymentRequest.merchant.isKnown}
- Amount: $${paymentRequest.amount.value} ${paymentRequest.amount.currency}
- Purpose: "${paymentRequest.purpose}"

Evaluate and respond ONLY with a valid JSON object matching this exact schema:
{
  "intent": "string",
  "category": "string",
  "merchantRisk": "low | medium | high | suspicious",
  "anomalyLevel": "none | low | medium | high",
  "injectionDetected": boolean,
  "injectionIndicators": ["string"],
  "policyRelevantFacts": ["string"],
  "reasoningSummary": "string"
}`;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      if (!res.ok) {
        return this.fallback.analyze(paymentRequest, context);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return this.fallback.analyze(paymentRequest, context);

      const parsed = JSON.parse(text);
      return createAIAnalysis(parsed);
    } catch {
      return this.fallback.analyze(paymentRequest, context);
    }
  }
}

/**
 * AI Analysis Service Factory
 */
export function getAIAnalysisProvider() {
  const apiKey = process.env.AI_PROVIDER_API_KEY || process.env.GEMINI_API_KEY;
  if (apiKey) {
    return new GeminiAIAnalysisProvider(apiKey);
  }
  return new HeuristicAIAnalysisProvider();
}
