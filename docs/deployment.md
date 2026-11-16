# Deploying TasteCaliber MCP Server

TasteCaliber is designed to run anywhere—from a single-user local stdio process to a globally distributed serverless edge endpoint. Below is a comparison of deployment options and complete setup instructions.

---

## Deployment Comparison

| Platform | Free Tier Limits | Cold Start | Database Backing | Best Use Case |
| --- | --- | --- | --- | --- |
| **Cloudflare Workers** *(Recommended Best Free Option)* | **100,000 requests/day**, global edge | **Near-zero** (~0–5ms V8 isolate) | **Cloudflare D1** (serverless SQLite) or Durable Objects SQLite | Remote team/multi-device TypeScript MCP server |
| **Vercel Functions** *(Ideal Alternative)* | **Free Hobby tier**, auto-scaling, instant rollbacks | Low (Node/Fluid Compute) | **Turso (libSQL)** or Vercel Postgres | Teams already using Next.js and Vercel workflows |
| **Fly.io / Railway / Docker** | Free/starter compute credits | Always-on (0ms when warm) | Local `data/taste.db` on persistent volume | Running full Express UI + `node:sqlite` together |
| **Local Stdio (`mcp-stdio.ts`)** | Unlimited | Instant local spawn | Local `data/taste.db` | Private single-developer desktop agents |

---

## 1. Recommended Best Free Option: Cloudflare Workers

**Cloudflare Workers** is the most robust free option for TypeScript MCP servers, offering **100,000 requests per day** with **near-zero cold starts** and **global edge deployment**.

Because `@modelcontextprotocol/sdk` already includes `WebStandardStreamableHTTPServerTransport`, our `McpServer` runs natively on Web Standard `Request` / `Response` objects inside Cloudflare Workers, paired with **Cloudflare D1** (Cloudflare's native serverless SQLite) for persistent storage.

### Step 1: Create Worker & D1 Database

```bash
npm i -g wrangler
wrangler login
wrangler d1 create tastecaliber-db
```

### Step 2: Configure `wrangler.toml`

```toml
name = "tastecaliber-mcp"
main = "worker.ts"
compatibility_date = "2025-03-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "tastecaliber-db"
database_id = "<YOUR_D1_DATABASE_ID>"
```

### Step 3: Add Server Secrets (Never Commit Keys)

```bash
wrangler secret put NVIDIA_API_KEY
wrangler secret put OPENROUTER_API_KEY
```

### Step 4: Minimal Worker Entrypoint Pattern (`worker.ts`)

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { classifyWithTaste1, deterministicExtractSignal } from './src/engine/taste1';

export interface Env {
  DB: D1Database;
  NVIDIA_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') {
      return new Response(JSON.stringify({ name: 'tastecaliber-mcp', endpoint: '/mcp' }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    const server = new McpServer({ name: 'tastecaliber-mcp', version: '1.0.0' });
    // Register TasteCaliber tools backed by env.DB (Cloudflare D1 SQLite)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
```

### Step 5: Deploy

```bash
wrangler deploy
```

Your global MCP endpoint is live at `https://tastecaliber-mcp.<your-subdomain>.workers.dev/mcp`.

---

## 2. Ideal Alternative: Vercel Functions

**Vercel Functions** is an ideal alternative—particularly for teams already using **Next.js**—providing a **free Hobby tier** with **automatic scaling** and **instant rollbacks**.

### Setup in Next.js App Router (`app/api/mcp/route.ts`)

1. Install Vercel CLI and link your project:
   ```bash
   npm i -g vercel
   vercel link
   ```
2. Add your database URL (e.g. Turso libSQL `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` for remote SQLite) and optional LLM secrets (`NVIDIA_API_KEY`, `OPENROUTER_API_KEY`) in **Vercel Project Settings → Environment Variables**.
3. Create `app/api/mcp/route.ts` using `WebStandardStreamableHTTPServerTransport`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export const runtime = 'nodejs';

async function handleMcp(req: Request): Promise<Response> {
  const server = new McpServer({ name: 'tastecaliber-mcp', version: '1.0.0' });
  // Register tools from server/mcp.ts backed by your serverless SQLite / Turso client
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export const POST = handleMcp;
export const GET = handleMcp;
```

4. Deploy with automatic preview & instant rollback support:
   ```bash
   vercel --prod
   ```

---

## 3. Self-Hosted Container / VPS (Persistent Local SQLite + Full UI)

If you want to run the **full Express server (`server.ts`)**, the **React Workbench UI**, and **`node:sqlite` (`data/taste.db`)** together on one machine:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
```

Mount a persistent volume at `/app/data` so `data/taste.db` survives container restarts:

```bash
docker build -t tastecaliber-mcp .
docker run -d -p 3000:3000 -v tastecaliber_data:/app/data tastecaliber-mcp
```

---

## 4. Local Stdio Mode (Desktop Coding Agents)

For zero-latency local usage without opening any network port, configure Claude Code, Cursor, Windsurf, Cline, or Zed to spawn `mcp-stdio.ts` directly:

```bash
npx tsx mcp-stdio.ts
```

Both `mcp-stdio.ts` and `server.ts` share the exact same `data/taste.db` SQLite database in WAL mode.
