# Native D1 verification

Run `npm run test:native` before treating native storage checks as a release gate.
It discovers all `tests/*-miniflare.test.ts` files and runs them together in one
Vitest invocation with one fork worker. Filters, retries and runner overrides
are not accepted by this entry point. Databases are temporary and loopback-only.

On Windows the tested profile is Node 24.22.1 or newer in the 24.x line. Select an
already installed executable with `ODAP_TEST_NODE`, or launch the script using
that Node. The script does not install a runtime or change the machine's PATH.
The Linux CI profile is pinned to Node 24.22.1. It runs all non-native suites
with at most two fork workers, then this complete native gate with one worker.
Neither stage retries failures or treats an incomplete process as a pass.
The package minimum is Node 22 because installed Wrangler and Miniflare require
it; that minimum is not a claim that every runtime version was verified.

```powershell
$env:ODAP_TEST_NODE = 'C:/path/to/node-24.22.1/node.exe'
npm run test:native
```

The script resolves installed Vitest through Node's normal module resolution,
so local and ancestor dependency installations both work. It creates a fresh
`.tmp/verification/native-d1-gate-*/` directory for every admitted run:

- `vitest.json`: the original runner report, including incomplete failures.
- `gate.json`: selected runtime version, complete suite inventory, process exit
  code/signal and the verification outcome. It contains no environment dump.

A successful gate requires exit zero without a termination signal, a successful
report, every discovered file exactly once, nonempty suites, every assertion
passed without failure messages, no skipped/todo tests, and reconciled totals.
It cannot reuse a previous report or count a filtered subset as the full suite.
An unhandled runner error still fails through the process status even if the
JSON reporter writes `success:true`. Inspect both artifacts after a failure;
never turn a failing process into a pass by reading that flag alone.

## Runtime investigation

On 2026-11-06, the unchanged schema-import suite aborted under system Node
24.15.0. A child-exit probe captured code `3221226505` (`0xC0000409`) and no signal.
The installed Vitest 2.1.9 actually defaults to forks, despite its stale CLI help
describing threads; changing to forks alone is not this repair. The diagnostic
report named `native-pool-threads-before.json` used that default, not an explicit
thread-pool override.

Using the already installed Node 24.22.1, the complete 26-case import suite passed,
then all 117 native cases across 12 files passed twice, including through this
gate. No test or assertion was removed, split, retried automatically or relaxed.
The 39 gate unit tests reject incomplete, substituted and inconsistent reports,
crash/termination results, and an unverified Windows runtime profile.

The [Node Windows issue](https://github.com/nodejs/node/issues/56645) reports the
same numeric exit code in a different reproduction. That is diagnostic context,
not proof that this run hit the identical native bug: no native crash stack was
captured. This is a validated local runtime selection and a fail-closed test
gate, not a claim to have repaired Node, Miniflare or every future runtime.
The original failed reports remain in `.tmp/verification/`. Native tests are
local engineering evidence, not deployed D1 acceptance, a pilot or a score.
