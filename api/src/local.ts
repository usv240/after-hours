/** Local dev server: `npm run dev -w api`, then the web dev server proxies /api to it. */
import { createServer } from "node:http";
import { handler } from "./handler.ts";

const port = Number(process.env.PORT ?? 8787);
createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const out = await handler({
    httpMethod: req.method ?? "GET",
    path: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: chunks.length ? Buffer.concat(chunks).toString("utf8") : null,
  });
  res.writeHead(out.statusCode, out.headers);
  res.end(out.body);
}).listen(port, () => console.log(`After Hours API on http://localhost:${port}`));
