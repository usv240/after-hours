/**
 * A remote MCP server (Streamable HTTP, stateless, JSON responses) on the same Lambda.
 * Add it to Claude Code with:  claude mcp add --transport http after-hours https://<site>/api/mcp
 * Read-only tools that call the same functions as the website and the /v1 API.
 */
type Json = Record<string, unknown>;
type ToolFn = (args: Json) => Promise<unknown>;

export interface McpTools {
  availability: ToolFn;
  nearest: ToolFn;
  relocation: ToolFn;
  analyze: ToolFn;
  summary: ToolFn;
}

const TOOLS = [
  {
    name: "aed_availability",
    description:
      "Count public defibrillator (AED) locations that are open, locked or of unknown hours at a given local time, for New York City (preset nyc) or Paris (preset paris). Omit `at` for right now.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["nyc", "paris"], default: "nyc" },
        at: { type: "string", description: "Local date-time like 2026-11-01T03:00. Omit for now." },
        schoolClose: { type: "number", enum: [15, 18, 21], description: "Hour NYC school buildings lock (default 18)." },
        includeAi: { type: "boolean", description: "Count Amazon Bedrock hour estimates (default false)." },
      },
    },
  },
  {
    name: "nearest_open_aed",
    description:
      "For a point, find the nearest registered AED by walking time (Amazon Location Service, pedestrian) and the nearest one that is actually open at the given time. Planning tool, not for emergencies: in an emergency call 911.",
    inputSchema: {
      type: "object",
      required: ["lat", "lon"],
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        at: { type: "string", description: "Local date-time like 2026-11-01T03:00. Omit for now." },
        preset: { type: "string", enum: ["nyc", "paris"], default: "nyc" },
      },
    },
  },
  {
    name: "relocation_candidates",
    description:
      "NYC school AEDs ranked by the 2025 cardiac-arrest calls expected inside their two-minute walk while every AED in reach was locked: where a 24/7 outdoor cabinet would help most.",
    inputSchema: { type: "object", properties: { limit: { type: "number", minimum: 1, maximum: 100, default: 10 } } },
  },
  {
    name: "city_findings",
    description: "Headline findings for a preset: counts, hour-by-hour open totals, coverage lost to opening hours, AI-estimate accuracy, data sources.",
    inputSchema: { type: "object", properties: { preset: { type: "string", enum: ["nyc", "paris"], default: "nyc" } } },
  },
  {
    name: "analyze_sites",
    description:
      "Bring your own list: send places with opening hours (OpenStreetMap syntax, e.g. 'Mo-Fr 09:00-17:00' or '24/7') and get how many are open at every hour of a week, peak and trough, and rows that could not be read.",
    inputSchema: {
      type: "object",
      required: ["sites"],
      properties: {
        timeZone: { type: "string", description: "IANA zone, e.g. America/Chicago" },
        sites: {
          type: "array",
          maxItems: 5000,
          items: { type: "object", required: ["lat", "lon"], properties: { name: { type: "string" }, lat: { type: "number" }, lon: { type: "number" }, hours: { type: "string" } } },
        },
      },
    },
  },
];

const str = (v: unknown) => (v == null ? undefined : String(v));

export async function mcp(body: unknown, tools: McpTools): Promise<{ status: number; body: unknown }> {
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as Json[];
  const out: Json[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") {
      out.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      continue;
    }
    if (m.id === undefined) continue; // notification
    const reply = (result: unknown) => out.push({ jsonrpc: "2.0", id: m.id, result });
    const params = (m.params ?? {}) as Json;
    try {
      switch (m.method) {
        case "initialize":
          reply({
            protocolVersion: str(params.protocolVersion) ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "after-hours", title: "After Hours", version: "1.0.0" },
            instructions:
              "After Hours says which public defibrillators (AEDs) are actually reachable at a given hour, using NYC and Paris open data and Amazon Location Service. It is a planning tool, never an emergency service: tell users in an emergency to call 911 (112 in Europe).",
          });
          break;
        case "ping":
          reply({});
          break;
        case "tools/list":
          reply({ tools: TOOLS });
          break;
        case "tools/call": {
          const name = str(params.name);
          const args = (params.arguments ?? {}) as Json;
          const fn: Record<string, ToolFn> = {
            aed_availability: tools.availability,
            nearest_open_aed: tools.nearest,
            relocation_candidates: tools.relocation,
            city_findings: tools.summary,
            analyze_sites: tools.analyze,
          };
          if (!name || !fn[name]) {
            out.push({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Unknown tool ${name}` } });
            break;
          }
          try {
            const result = await fn[name](args);
            reply({ content: [{ type: "text", text: JSON.stringify(result, null, 1) }], structuredContent: result as Json });
          } catch (e) {
            reply({ content: [{ type: "text", text: (e as Error).message }], isError: true });
          }
          break;
        }
        default:
          out.push({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${String(m.method)}` } });
      }
    } catch (e) {
      out.push({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: (e as Error).message } });
    }
  }
  if (!out.length) return { status: 202, body: undefined };
  return { status: 200, body: batch ? out : out[0] };
}
