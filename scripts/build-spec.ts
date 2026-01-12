/**
 * Build script to fetch the Cloudflare OpenAPI spec and generate TypeScript types.
 * Run with: npx tsx scripts/build-spec.ts
 */

import { writeFile, mkdir } from "node:fs/promises";
import type { OpenAPIV3 } from "openapi-types";

const OPENAPI_SPEC_URL =
  "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json";
const OUTPUT_DIR = "src/data";
const TYPES_FILE = OUTPUT_DIR + "/types.generated.ts";

interface EndpointInfo {
  method: string;
  path: string;
  summary?: string;
  tags?: string[];
}

/**
 * Extract product from path - the segment after {account_id} or {zone_id}
 * e.g. /accounts/{account_id}/workers/scripts → "workers"
 * e.g. /zones/{zone_id}/dns_records → "dns_records"
 */
function extractProduct(path: string): string | undefined {
  const accountMatch = path.match(/\/accounts\/\{[^}]+\}\/([^/]+)/);
  if (accountMatch) return accountMatch[1];

  const zoneMatch = path.match(/\/zones\/\{[^}]+\}\/([^/]+)/);
  if (zoneMatch) return zoneMatch[1];

  return undefined;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

function generateTypes(endpoints: EndpointInfo[], categories: Record<string, number>, version: string): string {
  // Group endpoints by category
  const byCategory: Record<string, EndpointInfo[]> = {};
  for (const endpoint of endpoints) {
    const parts = endpoint.path.split("/").filter(Boolean);
    const category = parts[0] || "root";
    if (!byCategory[category]) {
      byCategory[category] = [];
    }
    byCategory[category].push(endpoint);
  }

  // Generate type definitions
  const lines: string[] = [
    "/**",
    " * Auto-generated TypeScript types from Cloudflare OpenAPI spec.",
    " * Do not edit manually - run `npm run build:spec` to regenerate.",
    " *",
    " * " + version,
    " * Total endpoints: " + endpoints.length,
    " */",
    "",
    "// Base types for Cloudflare API",
    "export interface CloudflareRequestOptions {",
    '  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";',
    "  path: string;",
    "  query?: Record<string, string | number | boolean | undefined>;",
    "  body?: unknown;",
    "}",
    "",
    "export interface CloudflareResponse<T = unknown> {",
    "  success: boolean;",
    "  result: T;",
    "  errors: Array<{ code: number; message: string }>;",
    "  messages: Array<{ code: number; message: string }>;",
    "  result_info?: {",
    "    page: number;",
    "    per_page: number;",
    "    total_pages: number;",
    "    count: number;",
    "    total_count: number;",
    "  };",
    "}",
    "",
    "export interface CloudflareAPI {",
    "  /**",
    "   * Make a request to the Cloudflare API.",
    "   * @param options - Request options",
    "   * @returns The API response",
    "   */",
    "  request<T = unknown>(options: CloudflareRequestOptions): Promise<CloudflareResponse<T>>;",
    "}",
    "",
    "// Declare the cloudflare object available in code execution context",
    "declare const cloudflare: CloudflareAPI;",
    "",
  ];

  // Build endpoint summary - ALL endpoints
  const summaryLines: string[] = [];
  
  for (const category of Object.keys(byCategory).sort()) {
    const categoryEndpoints = byCategory[category];
    summaryLines.push("## " + category.charAt(0).toUpperCase() + category.slice(1));
    summaryLines.push("");
    
    // Group by path
    const pathMap = new Map<string, EndpointInfo[]>();
    for (const ep of categoryEndpoints) {
      if (!pathMap.has(ep.path)) {
        pathMap.set(ep.path, []);
      }
      pathMap.get(ep.path)!.push(ep);
    }

    // Include ALL paths
    for (const [path, eps] of pathMap) {
      const methods = eps.map(e => e.method).join("|");
      const summary = eps[0].summary ? " - " + eps[0].summary : "";
      summaryLines.push("- " + methods + " " + path + summary);
    }
    summaryLines.push("");
  }

  // Export constants
  lines.push("// API version info");
  lines.push("export const API_VERSION = " + JSON.stringify(version) + ";");
  lines.push("");
  lines.push("// Total endpoint count");
  lines.push("export const ENDPOINT_COUNT = " + endpoints.length + ";");
  lines.push("");
  lines.push("// Endpoint summary for tool description (v1)");
  lines.push("export const ENDPOINT_SUMMARY = " + JSON.stringify(summaryLines.join("\n")) + ";");
  lines.push("");
  lines.push("// Searchable endpoint index (v2)");
  lines.push("export interface EndpointInfo {");
  lines.push("  method: string;");
  lines.push("  path: string;");
  lines.push("  summary?: string;");
  lines.push("  tags?: string[];");
  lines.push("}");
  lines.push("");
  lines.push("export const ENDPOINTS: EndpointInfo[] = " + JSON.stringify(endpoints, null, 2) + ";");

  return lines.join("\n");
}

function resolveRefs(obj: unknown, spec: OpenAPIV3.Document, seen = new Set<string>()): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => resolveRefs(item, spec, seen));

  const record = obj as Record<string, unknown>;

  if ('$ref' in record && typeof record.$ref === 'string') {
    const ref = record.$ref;
    if (seen.has(ref)) return { $circular: ref };
    seen.add(ref);

    const parts = ref.replace('#/', '').split('/');
    let resolved: unknown = spec;
    for (const part of parts) {
      resolved = (resolved as Record<string, unknown>)?.[part];
    }
    return resolveRefs(resolved, spec, seen);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = resolveRefs(value, spec, seen);
  }
  return result;
}

function generateSpecFile(spec: OpenAPIV3.Document): string {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    if (!pathItem) continue;
    paths[path] = {};

    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, OpenAPIV3.OperationObject>)[method];
      if (op) {
        const product = extractProduct(path);
        const tags = op.tags ? [...op.tags] : [];
        if (product && !tags.some(t => t.toLowerCase() === product.toLowerCase())) {
          tags.unshift(product);
        }
        paths[path][method] = {
          summary: op.summary,
          description: op.description,
          tags,
          parameters: resolveRefs(op.parameters, spec),
          requestBody: resolveRefs(op.requestBody, spec),
          responses: resolveRefs(op.responses, spec),
        };
      }
    }
  }

  return JSON.stringify({ paths }, null, 2);
}

async function main() {
  console.log("Fetching OpenAPI spec from:", OPENAPI_SPEC_URL);

  const response = await fetch(OPENAPI_SPEC_URL);
  if (!response.ok) {
    throw new Error("Failed to fetch OpenAPI spec: " + response.status);
  }

  const spec = (await response.json()) as OpenAPIV3.Document;
  const pathKeys = Object.keys(spec.paths).sort();
  const version = spec.openapi + " | " + spec.info.title + " v" + spec.info.version;

  console.log("Found " + pathKeys.length + " paths");

  const endpoints: EndpointInfo[] = [];

  for (const path of pathKeys) {
    const pathItem = spec.paths[path];
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as OpenAPIV3.OperationObject | undefined;
      if (operation) {
        const product = extractProduct(path);
        const tags = operation.tags ? [...operation.tags] : [];
        if (product && !tags.some(t => t.toLowerCase() === product.toLowerCase())) {
          tags.unshift(product); // Add product as first tag
        }
        endpoints.push({
          method: method.toUpperCase(),
          path,
          summary: operation.summary,
          tags,
        });
      }
    }
  }

  console.log("Found " + endpoints.length + " endpoints");

  const categories: Record<string, number> = {};
  for (const path of pathKeys) {
    const parts = path.split("/").filter(Boolean);
    const category = parts[0] || "root";
    categories[category] = (categories[category] || 0) + 1;
  }

  // Ensure output directory exists
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Write types.generated.ts
  const types = generateTypes(endpoints, categories, version);
  await writeFile(TYPES_FILE, types);
  console.log("Wrote types to " + TYPES_FILE);

  // Write spec.json for v2 search
  const specJson = generateSpecFile(spec);
  const specFile = OUTPUT_DIR + "/spec.json";
  await writeFile(specFile, specJson);
  console.log("Wrote spec to " + specFile + " (" + (specJson.length / 1024).toFixed(0) + " KB)");

  // Generate products list (extracted from paths)
  const products = new Map<string, number>();
  for (const path of pathKeys) {
    const product = extractProduct(path);
    if (product) {
      products.set(product, (products.get(product) || 0) + 1);
    }
  }
  const sortedProducts = [...products.entries()].sort((a, b) => b[1] - a[1]);
  const productsFile = OUTPUT_DIR + "/products.ts";
  await writeFile(productsFile, `// Auto-generated list of Cloudflare products\nexport const PRODUCTS = ${JSON.stringify(sortedProducts.map(([p]) => p))} as const;\nexport type Product = typeof PRODUCTS[number];\n`);
  console.log("Wrote products to " + productsFile + " (" + sortedProducts.length + " products)");

  console.log("Categories: " + Object.keys(categories).length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
