import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const html = await readFile(path.join(root, "../public/index.html"));
const port = Number(process.env.PORT ?? 4173);

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Sleeper Draft Assistant: http://localhost:${port}`);
});
