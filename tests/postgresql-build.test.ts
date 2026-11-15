import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const run = promisify(execFile);
it("builds the Node host with declarations and loads it outside the TypeScript test runtime", async () => {
  const root = resolve(".tmp"); await mkdir(root, { recursive: true });
  const output = await mkdtemp(join(root, "postgresql-build-"));
  try {
    const options = { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 };
    await run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "scripts/tsconfig.postgresql.json", "--outDir", output], options);
    expect(await readFile(join(output, "integrations/postgresql/gateway.d.ts"), "utf8")).toContain("maxConcurrentExecutions");
    const smoke = `
      const assert = require('node:assert/strict'), path = require('node:path');
      const entry = name => require(path.join(process.argv[1], 'integrations/postgresql', name + '.js'));
      assert.equal(typeof entry('index').executePostgresMetric, 'function');
      assert.equal(typeof entry('control').executeGovernedPostgresRead, 'function');
      assert.equal(typeof entry('agent').signPostgresAgentCommand, 'function');
      assert.equal(typeof entry('sqlite-control').openPostgresSqliteControl, 'function');
      assert.equal(typeof entry('server').startPostgresHttpHost, 'function');
      assert.equal(typeof entry('mcp').createPostgresMcpGateway, 'function');
      const handler = entry('gateway').createPostgresGateway({origin:'https://gateway.test',env:{},
        resolve:async()=>{throw new Error('Provider must not be used by smoke test');}});
      (async()=>{
        assert.equal((await handler(new Request('https://gateway.test/postgresql/tenant/inspect'))).status,405);
        assert.equal((await handler(new Request('https://gateway.test/not-a-route'))).status,404);
        process.stdout.write('postgresql-host-loaded');
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `;
    const result = await run(process.execPath, ["-e", smoke, output], options);
    expect(result.stdout).toBe("postgresql-host-loaded");
  } finally { await rm(output, { recursive: true, force: true }); }
}, 90000);
