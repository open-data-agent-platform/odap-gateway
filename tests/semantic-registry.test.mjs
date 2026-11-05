import { describe, it, expect } from 'vitest';
import { emptyRegistry, applySemanticAction, bindSemanticQuery } from '../lib/semantic-registry.mjs';

function proposal(registry = emptyRegistry()) {
  return applySemanticAction(registry, { type: 'propose', actor: 'extractor', name: 'paid_order_amount',
    expression: "SUM(amount) FILTER (WHERE status = 'paid')", source: 'demo.orders',
    sourceRevision: 'schema-v1', extractor: 'demo-v1', owner: 'finance' });
}
function release() {
  let { registry, result } = proposal();
  for (const type of ['validate', 'approve', 'release']) {
    ({ registry, result } = applySemanticAction(registry, { type, id: result.id, actor: 'finance', evidence: 'demo-review-1' }));
  }
  return { registry, result };
}
function binding(releaseId) {
  return { releaseId, actor: 'analyst', sql: 'SELECT 1', sourceRevision: 'schema-v1', allowedSources: ['demo.orders'] };
}

describe('experimental semantic registry', () => {
  it('requires ordered review, publishes immutable versions, and records transitions', () => {
    const { registry, result } = release();
    expect(result.version).toBe(1);
    expect(registry.events.map(event => event.action)).toEqual(['propose', 'validate', 'approve', 'release']);
    expect(bindSemanticQuery(registry, binding(result.releaseId)).definitionHash).toBe(result.hash);
    const next = proposal(registry);
    expect(next.registry.candidates[0]).toEqual(result);
    expect(() => applySemanticAction(next.registry, { type: 'approve', id: next.result.id, actor: 'finance' })).toThrow();
  });
  it('rejects unauthorized lifecycle changes and unreleased definitions', () => {
    const { registry, result } = proposal();
    expect(() => applySemanticAction(registry, { type: 'validate', id: result.id, actor: 'stranger', evidence: 'x' })).toThrow();
    expect(() => bindSemanticQuery(registry, binding(result.id))).toThrow();
  });
  it('fails closed on permissions, source drift, definition tampering, and deprecated releases', () => {
    const { registry, result } = release();
    expect(() => bindSemanticQuery(registry, { ...binding(result.releaseId), allowedSources: [] })).toThrow();
    expect(() => bindSemanticQuery(registry, { ...binding(result.releaseId), sourceRevision: 'schema-v2' })).toThrow();
    const retired = applySemanticAction(registry, { type: 'deprecate', actor: 'finance', id: result.id });
    expect(() => bindSemanticQuery(retired.registry, binding(result.releaseId))).toThrow();
    registry.candidates[0].definition.expression = 'SUM(secret)';
    expect(() => bindSemanticQuery(registry, binding(result.releaseId))).toThrow();
  });
  it('requires validation evidence and rejection reasons without mutating inputs', () => {
    const { registry, result } = proposal();
    expect(() => applySemanticAction(registry, { type: 'validate', actor: 'finance', id: result.id })).toThrow();
    expect(() => applySemanticAction(registry, { type: 'reject', actor: 'finance', id: result.id })).toThrow();
    const rejected = applySemanticAction(registry, { type: 'reject', actor: 'finance', id: result.id, reason: 'Ambiguous definition' });
    expect(rejected.result.state).toBe('rejected');
    expect(registry.candidates[0].state).toBe('proposed');
  });
});
