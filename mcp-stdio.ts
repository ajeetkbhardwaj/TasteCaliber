import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb } from './server/db.ts';
import { createTasteMcpServer } from './server/mcp.ts';

async function main(): Promise<void> {
  const db = getDb();
  const mcpServer = createTasteMcpServer(db, 'stdio');
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((err) => {
  console.error('TasteCaliber MCP stdio error:', err);
  process.exit(1);
});
