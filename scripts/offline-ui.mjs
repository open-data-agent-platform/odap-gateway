import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)(process.env.ODAP_PLAYWRIGHT || "playwright");
const root = fileURLToPath(new URL("../out",import.meta.url));
export const origin = "https://gateway.test";
const mime = { ".html":"text/html", ".js":"application/javascript", ".css":"text/css", ".svg":"image/svg+xml", ".txt":"text/plain" };

export async function withOfflinePage(run) {
  const browser = await chromium.launch({ executablePath:process.env.ODAP_BROWSER || undefined,
    args:["--disable-background-networking","--host-resolver-rules=MAP * ~NOTFOUND"] });
  try {
    const page = await browser.newPage({viewport:{width:1280,height:900},serviceWorkers:"block"});
    await page.route("**/*",async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/api/auth/session") return route.fulfill({json:{authenticated:true,
        user:{name:"Demo owner",provider:"github",role:"member",email:"owner@example.test"}}});
      if (url.pathname.startsWith("/api/")) return route.fulfill({json:{ok:false}});
      const path = resolve(root,"." + decodeURIComponent(url.pathname) +
        (extname(url.pathname) ? "" : url.searchParams.has("_rsc") ? ".txt" : ".html"));
      if (!path.startsWith(root+sep)) return route.abort();
      try { return await route.fulfill({body:await readFile(path),contentType:mime[extname(path)] || "application/octet-stream"}); }
      catch { return route.abort(); }
    });
    await run(page);
  } finally { await browser.close(); }
}
