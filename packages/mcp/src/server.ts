import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  Server,
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { toolDefinitions, schema } from '../../contracts/src';
import { BridgeService } from '../../core/src/service';

// `version` is the app release; the tool contract is versioned separately by schema_version.
export async function startMcp(
  service: BridgeService,
  token: string,
  port = 43179,
  version = '0.0.0-dev',
) {
  if (token.length < 32) throw Error('MCP token must contain at least 32 characters');
  const handler = createMcpHandler(() => {
    const server = new Server(
      { name: 'web-image-bridge', version },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: toolDefinitions.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: schema(tool.input_ref),
        outputSchema: schema(tool.output_ref),
        annotations: {
          readOnlyHint: tool.read_only,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: !tool.read_only,
        },
      })),
    }));
    server.setRequestHandler('tools/call', async (request) => {
      if (!toolDefinitions.some((tool) => tool.name === request.params.name))
        throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Unknown tool');
      const result = await service.call(request.params.name, request.params.arguments ?? {});
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result,
        isError: !result.ok,
      };
    });
    return server;
  });
  const serve = toNodeHandler(handler);
  const expected = Buffer.from(`Bearer ${token}`);
  const http = createServer((req, res) => {
    const address = http.address();
    const boundPort = address && typeof address !== 'string' ? address.port : port;
    const authorization = Buffer.from(req.headers.authorization ?? '');
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.host !== `127.0.0.1:${boundPort}` || req.headers.origin !== undefined) {
      res.writeHead(403).end();
      return;
    }
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      res.writeHead(401).end();
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    // Bound untrusted framing before allowing the SDK to parse it.
    if (Number(req.headers['content-length'] ?? 0) > 1048576) {
      res.writeHead(413).end();
      return;
    }
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1048576) req.destroy();
    });
    void serve(req, res);
  });
  http.requestTimeout = 40000;
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, '127.0.0.1', () => {
        http.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await handler.close();
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === 'string') throw Error('MCP listener unavailable');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      });
    },
  };
}
