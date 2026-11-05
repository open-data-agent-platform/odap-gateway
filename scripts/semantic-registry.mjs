import { readFile, writeFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { emptyRegistry, applySemanticAction, bindSemanticQuery } from '../lib/semantic-registry.mjs';

const [stateArg, actionArg] = process.argv.slice(2);
if (!stateArg || !actionArg) {
  console.error('Usage: node scripts/semantic-registry.mjs STATE.json ACTION.json');
  process.exitCode = 1;
} else {
  const statePath = resolve(stateArg);
  const lockPath = `${statePath}.lock`;
  let lock;
  try {
    await mkdir(dirname(statePath), { recursive: true });
    lock = await open(lockPath, 'wx', 0o600);
    let registry;
    try { registry = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; registry = emptyRegistry(); }
    const action = JSON.parse(await readFile(actionArg, 'utf8'));
    let result;
    if (action.type === 'bind') {
      result = bindSemanticQuery(registry, action);
      registry.events.push({ action: 'bind', ...result, at: new Date().toISOString() });
    } else {
      ({ registry, result } = applySemanticAction(registry, action));
    }
    const temporaryPath = `${statePath}.pending`;
    await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, statePath);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}
