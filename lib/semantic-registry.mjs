import { createHash, randomUUID } from 'node:crypto';

// Local prototype only: actor identities are supplied by a trusted CLI operator.
export function emptyRegistry() {
  return { format: 1, candidates: [], events: [] };
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function required(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

export function applySemanticAction(registry, action) {
  if (registry.format !== 1) throw new Error('Unsupported registry format');
  const next = structuredClone(registry);
  const actor = required(action.actor, 'actor');
  const now = new Date().toISOString();
  let result;
  let candidate;
  if (action.type === 'propose') {
    const definition = {
      name: required(action.name, 'name'),
      expression: required(action.expression, 'expression'),
      source: required(action.source, 'source'),
      sourceRevision: required(action.sourceRevision, 'sourceRevision'),
      extractor: required(action.extractor, 'extractor'),
      owner: required(action.owner, 'owner')
    };
    candidate = { id: randomUUID(), definition, hash: digest(definition), state: 'proposed', createdAt: now };
    next.candidates.push(candidate);
    result = candidate;
  } else {
    candidate = next.candidates.find(item => item.id === action.id);
    if (!candidate) throw new Error('Candidate not found');
    if (digest(candidate.definition) !== candidate.hash) throw new Error('Definition integrity check failed');
    if (actor !== candidate.definition.owner) throw new Error('Only the named owner may change lifecycle state');
    const transitions = {
      validate: ['proposed', 'validated'],
      approve: ['validated', 'approved'],
      release: ['approved', 'released'],
      deprecate: ['released', 'deprecated']
    };
    if (action.type === 'reject') {
      if (!['proposed', 'validated', 'approved'].includes(candidate.state)) throw new Error('Invalid rejection');
      candidate.reason = required(action.reason, 'reason');
      candidate.state = 'rejected';
    } else {
      const transition = transitions[action.type];
      if (!transition || candidate.state !== transition[0]) throw new Error('Invalid lifecycle transition');
      if (action.type === 'validate') {
        // Records external review evidence; this does not validate SQL syntax or business correctness.
        candidate.validationEvidence = required(action.evidence, 'evidence');
      }
      if (action.type === 'approve') {
        candidate.approvedBy = actor;
        candidate.approvedHash = candidate.hash;
      }
      if (action.type === 'release') {
        if (candidate.approvedHash !== candidate.hash) throw new Error('Approval does not match definition');
        candidate.version = 1 + next.candidates.filter(item =>
          item.definition.name === candidate.definition.name && item.version !== undefined
        ).reduce((max, item) => Math.max(max, item.version), 0);
        candidate.releaseId = randomUUID();
      }
      candidate.state = transition[1];
    }
    result = candidate;
  }
  next.events.push({ id: randomUUID(), actor, action: action.type, candidateId: candidate.id,
    hash: candidate.hash, releaseId: candidate.releaseId ?? null, at: now });
  return { registry: next, result: structuredClone(result) };
}

export function bindSemanticQuery(registry, { releaseId, sourceRevision, sql, actor, allowedSources }) {
  required(actor, 'actor');
  required(sql, 'sql');
  const candidate = registry.candidates.find(item => item.releaseId === releaseId && item.state === 'released');
  if (!candidate) throw new Error('Released semantic version required');
  if (!Array.isArray(allowedSources) || !allowedSources.includes(candidate.definition.source)) throw new Error('Source access denied');
  if (candidate.definition.sourceRevision !== sourceRevision) throw new Error('Source revision changed; new review required');
  if (digest(candidate.definition) !== candidate.hash || candidate.approvedHash !== candidate.hash) throw new Error('Definition integrity check failed');
  return { actor, releaseId, version: candidate.version, definitionHash: candidate.hash,
    queryHash: digest(sql), source: candidate.definition.source, sourceRevision };
}
