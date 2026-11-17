import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const artifactSha = 'c7feeda495fe2a4553b2f7a5874bc39722eb642fbfda3c0799ad8a08ca5513ea';
const output = path.resolve(process.env.ODAP_RECEIVER_OUTPUT || path.join(root, '.tmp/datahub-receiver-results'));
const javaHome = process.env.JAVA_HOME;
const jar = process.env.DATAHUB_CONVERTER_JAR;
const slf4j = process.env.SLF4J_API_JAR;
const strict = process.env.ODAP_REQUIRE_FACET_RETENTION === '1';
let result;
let manifest;

function run(command, args, label) {
  const child = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(path.join(output, `${label}.stdout.log`), child.stdout || '');
  writeFileSync(path.join(output, `${label}.stderr.log`), child.stderr || '');
  writeFileSync(path.join(output, `${label}.exit.json`), JSON.stringify({ status: child.status, signal: child.signal, error: child.error?.message }));
  assert.equal(child.error, undefined, `${label} process error`);
  assert.equal(child.signal, null, `${label} was interrupted`);
  assert.equal(child.status, 0, `${label} failed; inspect retained logs`);
}

before(async () => {
  assert(javaHome && jar && slf4j, 'Set JAVA_HOME, DATAHUB_CONVERTER_JAR and SLF4J_API_JAR');
  assert(!existsSync(output), 'Use a new output directory; previous evidence is preserved');
  mkdirSync(output, { recursive: true });
  for (const name of ['ReceiverProbe.java', 'verify-receiver.mjs']) {
    writeFileSync(path.join(output, name), readFileSync(path.join(here, name)));
  }
  assert.equal(createHash('sha256').update(readFileSync(jar)).digest('hex'), artifactSha, 'Unpinned DataHub jar');
  assert.equal(createHash('sha256').update(readFileSync(slf4j)).digest('hex'), '7b751d952061954d5abfed7181c1f645d336091b679891591d63329c622eb832', 'Unpinned SLF4J API jar');
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'scripts/tsconfig.evidence.json'], 'exporter-build');
  const { exportOpenLineage } = await import(pathToFileURL(path.join(root, 'dist/evidence/lib/openlineage-export.js')).href);
  const { canonicalControlJson, sha256Text } = await import(pathToFileURL(path.join(root, 'dist/evidence/lib/control-objects.js')).href);
  const fixture = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/settled-job.json'), 'utf8'));
  const cases = [];
  const cycles = {};
  for (const outcome of ['succeeded', 'failed', 'cancelled']) {
    const bundle = structuredClone(fixture);
    bundle.final.outcome = bundle.observation.outcome = outcome;
    const wire = canonicalControlJson(bundle);
    // This pin is for a synthetic test variant, not independent custody evidence.
    cycles[outcome] = await exportOpenLineage(wire, { tenantId: 't', intentId: 'i' }, await sha256Text(wire), 'https://gateway.example/gateway');
    cases.push({ name: outcome, configured: true, events: cycles[outcome] });
  }
  cases.push({ name: 'no-orchestrator', configured: false, events: cycles.succeeded });
  cases.push({ name: 'duplicate', configured: true, events: [...cycles.succeeded, ...cycles.succeeded] });
  cases.push({ name: 'reversed', configured: true, events: [...cycles.succeeded].reverse() });
  cases.push({ name: 'terminal-only', configured: true, events: [cycles.cancelled[1]] });
  const revised = structuredClone(fixture);
  revised.bill.actualMicroUsd = revised.settlement.actualMicroUsd = 4;
  const revisedWire = canonicalControlJson(revised);
  cases.push({ name: 'revision', configured: true, events: await exportOpenLineage(revisedWire, { tenantId: 't', intentId: 'i' }, await sha256Text(revisedWire), 'https://gateway.example/gateway') });
  manifest = { cases };
  writeFileSync(path.join(output, 'inputs.json'), JSON.stringify(manifest, null, 2));
  const classes = path.join(output, 'classes');
  mkdirSync(classes);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const classpath = [jar, slf4j].join(path.delimiter);
  run(path.join(javaHome, 'bin', `javac${suffix}`), ['--release', '21', '-cp', classpath, '-d', classes, path.join(here, 'ReceiverProbe.java')], 'compile');
  run(path.join(javaHome, 'bin', `java${suffix}`), ['-Djava.security.manager=allow', '-cp', [classes, classpath].join(path.delimiter), 'ReceiverProbe', path.join(output, 'inputs.json'), path.join(output, 'projections.json')], 'converter');
  result = JSON.parse(readFileSync(path.join(output, 'projections.json'), 'utf8'));
  writeFileSync(path.join(output, 'environment.json'), JSON.stringify({ node: process.version, java: result.javaVersion, artifact: 'io.acryl:acryl-spark-lineage_2.12:1.7.0.20', sha256: artifactSha, slf4jSha256: createHash('sha256').update(readFileSync(slf4j)).digest('hex'), strictFacetRetention: strict, httpReceiverTested: false, persistenceTested: false }, null, 2));
});

function rows(name) { return result.cases.find(c => c.name === name).rows; }
function events(name) { return manifest.cases.find(c => c.name === name).events; }
function success(row) { assert.equal(row.error, undefined, JSON.stringify(row)); return row; }

test('converter execution is network-blocked and the tripwire was exercised', () => {
  assert.equal(result.guardVerified, true);
  assert.equal(result.networkAttempts, 0);
});

for (const [outcome, native, coarse] of [['succeeded', 'COMPLETE', 'SUCCESS'], ['failed', 'FAIL', 'FAILURE'], ['cancelled', 'ABORT', 'FAILURE']]) {
  test(`${outcome}: real converter creates STARTED and terminal process proposals`, () => {
    const [start, terminal] = rows(outcome).map(success);
    assert.equal(start.runEvent.status, 'STARTED');
    assert.equal(terminal.runEvent.status, 'COMPLETE');
    assert.equal(terminal.runEvent.result.type, coarse);
    assert.equal(terminal.runEvent.result.nativeResultType, native);
    assert.equal(start.instanceUrn, terminal.instanceUrn);
    assert.equal(start.instanceUrn, 'urn:li:dataProcessInstance:' + events(outcome)[0].run.runId);
    for (const row of [start, terminal]) {
      assert(row.mcps.some(m => m.aspectName === 'dataProcessInstanceRunEvent'));
      assert(row.mcps.some(m => m.aspectName === 'dataProcessInstanceProperties'));
    }
  });
  test(`${outcome}: claim and observation timestamps stay exact`, () => {
    const [start, terminal] = rows(outcome).map(success);
    assert.equal(start.runEvent.timestampMillis, 1767225601000);
    assert.equal(terminal.runEvent.timestampMillis, 1767225602000);
  });
  test(`${outcome}: no physical dataset entity or lineage edge is invented`, () => {
    for (const row of rows(outcome).map(success)) {
      assert(!row.mcps.some(m => m.entityType === 'dataset'));
      assert(!JSON.stringify(row.mcps).includes('urn:li:dataset:'));
    }
  });
  test(`${outcome}: evidence facet survives parsing; check proposal retention`, () => {
    const terminal = success(rows(outcome)[1]);
    const facet = terminal.decoded.run.facets.odap_evidence;
    assert.equal(facet.evidenceDigest, events(outcome)[1].run.facets.odap_evidence.evidenceDigest);
    assert.equal(facet.issuerAuthenticated, false);
    assert.equal(facet.retrospective, true);
    const wire = JSON.stringify(terminal.mcps);
    if (strict) {
      assert(wire.includes(facet.evidenceDigest), 'Required evidence digest was discarded by the converter');
    } else {
      assert(!wire.includes(facet.evidenceDigest));
      assert(!wire.includes('issuerAuthenticated'));
      assert(!wire.includes('odap_evidence'));
    }
  });
}

test('unrecognized producer without explicit orchestrator is rejected', () => {
  for (const row of rows('no-orchestrator')) {
    assert.match(row.error, /Unable to determine orchestrator/);
    assert.equal(row.mcps, undefined);
  }
});
test('omitted datasets become empty instance aspects, not verified zero inputs or outputs', () => {
  for (const outcome of ['succeeded', 'failed', 'cancelled']) {
    for (const event of events(outcome)) {
      assert.equal(Object.hasOwn(event, 'inputs'), false);
      assert.equal(Object.hasOwn(event, 'outputs'), false);
    }
    for (const row of rows(outcome).map(success)) {
      assert.deepEqual(row.mcps.find(m => m.aspectName === 'dataProcessInstanceInput').aspect, { inputs: [] });
      assert.deepEqual(row.mcps.find(m => m.aspectName === 'dataProcessInstanceOutput').aspect, { outputs: [] });
    }
  }
});
test('replay is stable but converter re-emits proposals, not deduplicated writes', () => {
  const replay = rows('duplicate').map(success);
  assert.deepEqual(replay[0].mcps, replay[2].mcps);
  assert.deepEqual(replay[1].mcps, replay[3].mcps);
  assert(replay.every(row => row.mcps.length > 0));
  assert(replay.every(row => row.runEvent.messageId === undefined));
});
test('out-of-order input is converted in arrival order without a lifecycle gate', () => {
  const [terminal, start] = rows('reversed').map(success);
  assert.deepEqual(terminal.mcps, rows('succeeded')[1].mcps);
  assert.deepEqual(start.mcps, rows('succeeded')[0].mcps);
});
test('terminal-only input still generates proposals without proving a prior START', () => {
  assert.deepEqual(success(rows('terminal-only')[0]).mcps, rows('cancelled')[1].mcps);
});
test('billing revision has same run identity but distinct digest lost in native conversion', () => {
  const original = success(rows('cancelled')[1]);
  const revision = success(rows('revision')[1]);
  assert.equal(original.instanceUrn, revision.instanceUrn);
  assert.notEqual(events('cancelled')[1].run.facets.odap_evidence.evidenceDigest, events('revision')[1].run.facets.odap_evidence.evidenceDigest);
  assert.deepEqual(original.mcps, revision.mcps);
});
