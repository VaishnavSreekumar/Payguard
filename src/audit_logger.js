import { createAuditEvent } from './models.js';

export const AUDIT_EVENT_TYPES = {
  REQUEST_RECEIVED: 'REQUEST_RECEIVED',
  AI_ANALYZED: 'AI_ANALYZED',
  POLICY_EVALUATED: 'POLICY_EVALUATED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_GRANTED: 'APPROVAL_GRANTED',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  PAYPAL_REQUESTED: 'PAYPAL_REQUESTED',
  PAYPAL_RESPONSE_RECEIVED: 'PAYPAL_RESPONSE_RECEIVED',
  BLOCKED: 'BLOCKED',
  DUPLICATE_REJECTED: 'DUPLICATE_REJECTED'
};

export class AuditLogger {
  constructor() {
    this.events = [];
  }

  logEvent({
    eventType,
    requestId,
    agentId,
    decision = 'N/A',
    reasonCodes = [],
    explanation = '',
    paypalCalled = false,
    details = {}
  }) {
    const event = createAuditEvent({
      requestId,
      agentId,
      decision,
      reasonCodes,
      explanation: `[${eventType}] ${explanation}`,
      paypalCalled,
      details: {
        eventType,
        ...details
      }
    });

    this.events.push(event);
    return event;
  }

  getEventsForRequest(requestId) {
    return this.events.filter(e => e.requestId === String(requestId));
  }

  getAllEvents() {
    return [...this.events];
  }

  clear() {
    this.events = [];
  }
}
