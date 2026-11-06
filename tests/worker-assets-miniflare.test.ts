import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionCookie, signAuthPayload } from "../lib/auth";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const root = resolve(__dirname, "..");
const secret = "local-test-secret-never-used-in-production";
let directory: string;
let secured: Miniflare;
let assetFirst: Miniflare;
let mounted: Miniflare;

describe("Worker authentication ahead of the native static asset router", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "odap-worker-assets-"));
    const assets = join(directory, "assets");
    await mkdir(assets);
    const config = JSON.parse(await readFile(join(root, "wrangler.example.jsonc"), "utf8"));
    await writeFile(join(assets, "admin.html"), "private-admin-shell");
    await writeFile(join(assets, "admin.txt"), "private-admin-flight");
    await writeFile(join(assets, "index.html"), "public-home");
    await writeFile(join(assets, "login.html"), "public-login");
    const configPath = join(directory, "wrangler.json");
    await writeFile(configPath, JSON.stringify({
      name: "odap-local-asset-check", main: join(root, "worker/index.ts"),
      compatibility_date: config.compatibility_date
    }));
    const output = join(directory, "bundle");
    await run(process.execPath, [join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js"),
      "deploy", "--dry-run", "--config", configPath, "--outdir", output], {
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(directory, "wrangler.log") },
      windowsHide: true, timeout: 60000
    });
    const files = await readdir(output);
    const bundle = files.filter(file => file.endsWith(".js"));
    expect(bundle).toHaveLength(1);
    const script = await readFile(join(output, bundle[0]), "utf8");
    const instance = (workerFirst: boolean, base = "") => new Miniflare({
      name: "odap-local-asset-check", host: "127.0.0.1", port: 0,
      modules: true, script, compatibilityDate: config.compatibility_date,
      bindings: { AUTH_COOKIE_SECRET: secret, GATEWAY_MODE: "production", GATEWAY_BASE_PATH: base },
      assets: { directory: assets, binding: "ASSETS", routerConfig: {
        has_user_worker: true, invoke_user_worker_ahead_of_assets: workerFirst
      } }
    });
    secured = instance(config.assets.run_worker_first === true);
    assetFirst = instance(false);
    mounted = instance(true, "/gateway");
  }, 90000);
  afterAll(async () => {
    await secured?.dispose();
    await assetFirst?.dispose();
    await mounted?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("reproduces the legacy asset-first authentication bypass", async () => {
    const response = await assetFirst.dispatchFetch("http://localhost/admin", { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("private-admin-shell");
    expect(response.headers.get("x-content-type-options")).toBeNull();
  });

  const paths = ["/admin", "/admin/", "/admin.html", "/admin.txt", "/ad%6din", "/admin%2ehtml"];
  it.each(paths.flatMap(path => ["GET", "HEAD"].map(method => ({ path, method }))))(
    "authenticates before serving the private asset $method $path", async ({ path, method }) => {
      const response = await secured.dispatchFetch(`http://localhost${path}`, { redirect: "manual", method });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/login?returnTo=%2Fadmin");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).not.toContain("private-admin");
    }
  );

  it("cannot use an admin cookie to bypass missing canonical storage", async () => {
    const token = await signAuthPayload({ provider: "google", providerId: "fixture",
      email: "fixture@example.test", name: "Fixture", role: "admin", expiresAt: Date.now() + 60000 }, secret);
    const response = await secured.dispatchFetch("http://localhost/admin", {
      redirect: "manual", headers: { Cookie: createSessionCookie(token, false) }
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "admin_authority_unavailable" });
  });

  it.each(["/", "/login"])("preserves public assets with security headers: %s", async path => {
    const response = await secured.dispatchFetch(`http://localhost${path}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("public-");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each(paths)("protects the mounted private asset %s before decoding", async path => {
    const response = await mounted.dispatchFetch(`http://localhost/gateway${path}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/gateway/login?returnTo=%2Fadmin");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).not.toContain("private-admin");
  });

  it.each(["/gateway", "/gateway/login"])("serves the mounted native asset %s", async path => {
    const response = await mounted.dispatchFetch(`http://localhost${path}`, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("public-");
  });

  it.each(["/", "/login", "/admin", "/_next/app.js", "/api/health", "/gateway-other"])(
    "does not expose assets or APIs outside the mount: %s", async path => {
      const response = await mounted.dispatchFetch(`http://localhost${path}`, { redirect: "manual" });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    });
});
