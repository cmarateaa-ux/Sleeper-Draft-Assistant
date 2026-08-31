import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const SLEEPER_API = "https://api.sleeper.app/v1";

async function proxySleeper(pathname, res) {
  const upstream = await fetch(SLEEPER_API + pathname, { headers: { accept: "application/json" }, cache: "no-store" });
  const body = await upstream.text();
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
    "x-sleeper-status": String(upstream.status),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(path.join(root, "../public/index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, build: "live-proxy-2026-08-31-2" }));
      return;
    }
    if (url.pathname.startsWith("/api/sleeper/")) {
      await proxySleeper(url.pathname.slice("/api/sleeper".length), res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});
server.listen(port, "0.0.0.0", () => console.log(`Sleeper Draft Assistant: http://localhost:${port}`));
