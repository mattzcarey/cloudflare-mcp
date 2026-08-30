import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createCodeExecutor, createSearchExecutor } from "./executor";
import { truncateResponse } from "./truncate";
import { PRODUCTS } from "./data/products";


async function resolveAccountId(
  apiBase: string,
  apiToken: string
): Promise<string> {
  const response = await fetch(`${apiBase}/accounts`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  });

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new Error(`Cloudflare API error: ${response.status} ${text}`);
  }

  const data = await response.json<{
    success: boolean;
    result: AccountResult[];
    errors: Array<{ code: number; message: string }>;
  }>();

  if (!data.success) {
    const errors = data.errors.map((e) => `${e.code}: ${e.message}`).join(", ");
    throw new Error(`Cloudflare API error: ${errors}`);
  }

  if (!Array.isArray(data.result) || data.result.length === 0) {
    throw new Error("No Cloudflare accounts found for this token.");
  }

  if (data.result.length === 1 && data.result[0]?.id) {
    return data.result[0].id;
  }

  const accountSummary = data.result
    .slice(0, 5)
    .map((account) => `${account.id ?? "unknown"} (${account.name ?? ""})`)
    .join(", ");
  throw new Error(
    `Multiple Cloudflare accounts found. Provide account_id to select one. ` +
      `Found: ${accountSummary}`
  );
}

const CLOUDFLARE_TYPES = `
interface CloudflareRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;  // Custom Content-Type header (defaults to application/json if body is present)
  rawBody?: boolean;     // If true, sends body as-is without JSON.stringify
}

interface CloudflareResponse<T = unknown> {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
}

declare const cloudflare: {
  request<T = unknown>(options: CloudflareRequestOptions): Promise<CloudflareResponse<T>>;
};

declare const accountId: string;
`;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


const SPEC_TYPES = `
interface OperationInfo {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown; description?: string }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
}

interface PathItem {
  get?: OperationInfo;
  post?: OperationInfo;
  put?: OperationInfo;
  patch?: OperationInfo;
  delete?: OperationInfo;
}

declare const spec: {
  paths: Record<string, PathItem>;
};
`;

export function createServer(env: Env, apiToken: string, accountId?: string): McpServer {
  const server = new McpServer({
    name: "cloudflare-api",
    version: "0.1.0",
  });

  const executeCode = createCodeExecutor(env);
  const executeSearch = createSearchExecutor(env);
  const apiBase = env.CLOUDFLARE_API_BASE;

  server.registerTool(
    "search",
    {
      description: `Search the Cloudflare OpenAPI spec. All $refs are pre-resolved inline.

Products: ${PRODUCTS.slice(0, 30).join(", ")}... (${PRODUCTS.length} total)

Types:
${SPEC_TYPES}

Examples:

// Find endpoints by product
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.tags?.some(t => t.toLowerCase() === 'workers')) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary });
      }
    }
  }
  return results;
}

// Get endpoint with requestBody schema (refs are resolved)
async () => {
  const op = spec.paths['/accounts/{account_id}/d1/database']?.post;
  return { summary: op?.summary, requestBody: op?.requestBody };
}

// Get endpoint parameters
async () => {
  const op = spec.paths['/accounts/{account_id}/workers/scripts']?.get;
  return op?.parameters;
}`,
      inputSchema: {
        code: z
          .string()
          .describe(
            "JavaScript async arrow function to search the OpenAPI spec"
          ),
      },
    },
    async ({ code }) => {
      try {
        const result = await executeSearch(code);
        return { content: [{ type: "text", text: truncateResponse(result) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    }
  );

  const executeDescription = `Execute JavaScript code against the Cloudflare API. First use the 'search' tool to find the right endpoints, then write code using the cloudflare.request() function.

Available in your code:
${CLOUDFLARE_TYPES}

Your code must be an async arrow function that returns the result.

Example: Worker with bindings (requires multipart/form-data):
async () => {
  const code = `addEventListener('fetch', e => e.respondWith(MY_KV.get('key').then(v => new Response(v || 'none'))));`;
  const metadata = { body_part: "script", bindings: [{ type: "kv_namespace", name: "MY_KV", namespace_id: "your-kv-id" }] };
  const b = `--F${Date.now()}`;
  const body = [`--${b}`, 'Content-Disposition: form-data; name="metadata"', 'Content-Type: application/json', '', JSON.stringify(metadata), `--${b}`, 'Content-Disposition: form-data; name="script"', 'Content-Type: application/javascript', '', code, `--${b}--`].join("\r\n");
  return cloudflare.request({ method: "PUT", path: `/accounts/${accountId}/workers/scripts/my-worker`, body, contentType: `multipart/form-data; boundary=${b}`, rawBody: true });
}`;

  if (accountId) {
    // Account token mode: account_id is fixed, not a parameter
    server.registerTool(
      "execute",
      {
        description: executeDescription,
        inputSchema: {
          code: z.string().describe("JavaScript async arrow function to execute"),
        },
      },
      async ({ code }) => {
        try {
          const result = await executeCode(code, accountId, apiToken);
          return { content: [{ type: "text", text: truncateResponse(result) }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error: ${formatError(error)}` }],
            isError: true,
          };
        }
      }
    );
  } else {
    // User token mode: account_id can be auto-resolved
    server.registerTool(
      "execute",
      {
        description: executeDescription,
        inputSchema: {
          code: z.string().describe("JavaScript async arrow function to execute"),
          account_id: z
            .string()
            .optional()
            .describe(
              "Optional Cloudflare account ID (if omitted, auto-resolves when only one account is available)"
            ),
        },
      },
      async ({ code, account_id }) => {
        try {
          const resolvedAccountId =
            account_id ??
            (apiBase ? await resolveAccountId(apiBase, apiToken) : undefined);
          if (!resolvedAccountId) {
            throw new Error(
              "Cloudflare API base is missing; provide account_id explicitly."
            );
          }
          const result = await executeCode(code, resolvedAccountId, apiToken);
          return { content: [{ type: "text", text: truncateResponse(result) }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error: ${formatError(error)}` }],
            isError: true,
          };
        }
      }
    );
  }

  return server;
}
