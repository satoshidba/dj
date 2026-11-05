// MCP server at /mcp (Streamable HTTP, stateless). Any MCP client — Claude,
// Hermes, Cursor, … — connects with `Authorization: Bearer <dj token>` and gets
// the actions from actions.js as tools. A read-only token only sees read tools.
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { actions, runAction } from './actions.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const INSTRUCTIONS = `dj manages one person's Spotify: it "deals" playlists (a proper shuffle written back to Spotify so they're played in order with shuffle off), keeps a complete play log, builds playlists from briefs or from the person's own history, and runs a Kids mode for children.
Start with list_playlists or listening_stats to orient yourself. Playlists can be referred to by name. To make a playlist with your own song choices use create_playlist; brief_playlist uses dj's built-in curator instead. Writing to Spotify only works on playlists the person owns or collaborates on.`;

function buildServer(ctx) {
  const server = new McpServer({ name: 'dj', title: 'dj for Spotify', version: pkg.version }, { instructions: INSTRUCTIONS });
  for (const a of actions) {
    if (ctx.readOnly && !a.readOnly) continue;
    server.registerTool(
      a.name,
      {
        title: a.title,
        description: a.description,
        inputSchema: a.input,
        annotations: { title: a.title, readOnlyHint: a.readOnly, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          const result = await runAction(ctx, a.name, args);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: err.message || 'Something went wrong' }] };
        }
      },
    );
  }
  return server;
}

export async function handleMcp(req, res, ctx) {
  const server = buildServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
