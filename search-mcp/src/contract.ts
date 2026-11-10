/**
 * Single owner of the search-mcp contract: tool names, titles, descriptions,
 * input schemas, output schemas and annotations. `server.ts` only registers what
 * is declared here; `registry.ts` owns the behaviour (chains, probing) and the
 * contract test asserts the two agree.
 *
 * Input schemas accept and ignore unknown keys, exactly as the previous server
 * did, so an agent that passes an extra field keeps working.
 */

import { z } from "zod";
import { INTENTS, type Intent } from "./types.js";

// ---------------------------------------------------------------- shared parts

const rootsProperty = z
  .array(z.string())
  .optional()
  .describe("Explicit search roots (absolute or ~); validated server-side. Default: config roots or cwd.");

const limitProperty = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe("Max results (default 50, hard cap 200)");

const maxSnippetProperty = z.number().int().min(1).max(2_000).optional();

const pathGlobProperty = z.string().optional().describe("Glob filter, e.g. '*.ts'");
const caseSensitiveProperty = z.boolean().optional();
const langProperty = z.string().optional().describe("Language for structural search (ts, tsx, py, rust, go…)");

/** Wire shape of one search result. */
export const searchHitSchema = z.object({
  path: z.string(),
  line: z.number().int().optional(),
  snippet: z.string().optional(),
  kind: z.string().optional(),
});

/** Wire shape of every search answer. */
export const searchResponseSchema = z.object({
  results: z.array(searchHitSchema),
  provider: z.string(),
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
  note: z.string().optional(),
  count: z.number().int(),
});

export const providerStatusSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  available: z.boolean(),
  reason: z.string().optional(),
  intents: z.array(z.enum(INTENTS)),
});

/**
 * What the doctor can say about one requirement:
 * - `present`     — the binary is on PATH;
 * - `installable` — missing, but this machine has the package manager to fix it;
 * - `blocked`     — missing and not installable here, so the provider should be
 *                   disabled in config rather than left half-working;
 * - `builtin`     — missing and there is nothing to install (e.g. Spotlight);
 *                   also the answer for a provider the config already disabled.
 */
export const VERDICTS = ["present", "installable", "blocked", "builtin", "disabled"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const requirementReportSchema = z.object({
  provider: z.string(),
  check: z.string(),
  what: z.string(),
  install: z.string().optional(),
  manager: z.string().optional(),
  postSetup: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  auth: z.boolean().optional(),
  verdict: z.enum(VERDICTS),
  detail: z.string().optional(),
});

export type RequirementReport = z.infer<typeof requirementReportSchema>;

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  /** Chain whose availability decides whether this tool can answer. */
  intent?: Intent;
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
  annotations: ToolAnnotations;
}

// -------------------------------------------------------------- tool contracts

const searchAnnotations: ToolAnnotations = {
  title: "Search",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** The four `search_*` tools share one shape; only the intent and extras differ. */
function intentTool(options: {
  name: string;
  title: string;
  description: string;
  intent: Intent;
  extra?: Record<string, z.ZodType>;
  requiredExtra?: Record<string, z.ZodType>;
}): ToolSpec {
  return {
    name: options.name,
    title: options.title,
    description: options.description,
    intent: options.intent,
    inputSchema: z.object({
      query: z.string().describe("Search text / pattern / name"),
      roots: rootsProperty,
      limit: limitProperty,
      ...options.requiredExtra,
      ...options.extra,
    }),
    outputSchema: searchResponseSchema,
    annotations: { ...searchAnnotations, title: options.title },
  };
}

export const TOOLS: ToolSpec[] = [
  {
    name: "providers",
    title: "Provider status",
    description:
      "search-mcp provider table: which providers are enabled/available and which intents they serve. " +
      "action=doctor additionally lists every machine requirement with the exact install command and whether it can be " +
      "installed on this machine (`installable`), cannot (`blocked` — the answer includes the config line that disables " +
      "that provider), or is already off. " +
      "action=reload re-reads all config layers (env > repo .search-mcp.json > ~/.config/search-mcp/providers.json) " +
      "and re-probes availability; the tool list itself never changes, so a reload cannot invalidate a prompt cache. " +
      "Call this before blaming a missing tool — it shows what the router can use right now.",
    inputSchema: z.object({
      action: z.enum(["status", "reload", "doctor"]).optional().describe("Default: status"),
    }),
    outputSchema: z.object({
      providers: z.array(providerStatusSchema).optional(),
      requirements: z.array(requirementReportSchema).optional(),
      configSources: z.array(z.string()).optional(),
    }),
    annotations: { ...searchAnnotations, title: "Provider status" },
  },
  {
    name: "search",
    title: "Routed search",
    description:
      "Meta search router: intent + query -> best available provider, falling through a chain " +
      "(response names who answered and why others were skipped). " +
      "USE for: meaning-based discovery ('where is X handled' -> semantic), structural patterns, " +
      "documents (PDF/Office), machine-wide filenames, multi-root scans. " +
      "SKIP for: one known file (just read it), an exact string in one directory (plain shell rg is cheaper), " +
      "or the knowledge vault (that domain belongs to knowledge-mcp: knowledge_search). " +
      "Two-phase strategy: discovery pass here first (semantic/structure), then exact rg/read on what it found. " +
      "Intents: text, files, structure (needs lang), docs, semantic (auggie→serena→ast-grep→rg), " +
      "machine (Spotlight), crossrepo (zoekt→rg).",
    inputSchema: z.object({
      intent: z.enum(INTENTS).describe("What kind of search this is"),
      query: z.string().describe("Search text / pattern / symbol / name"),
      roots: rootsProperty,
      pathGlob: pathGlobProperty,
      limit: limitProperty,
      lang: langProperty,
      caseSensitive: caseSensitiveProperty,
      maxSnippet: maxSnippetProperty,
    }),
    outputSchema: searchResponseSchema,
    annotations: { ...searchAnnotations, title: "Routed search" },
  },
  intentTool({
    name: "search_text",
    title: "Text search",
    description: "Exact text/regex search (ripgrep, bounded, JSON-parsed). The precision pass after semantic discovery.",
    intent: "text",
    extra: { pathGlob: pathGlobProperty, caseSensitive: caseSensitiveProperty },
  }),
  intentTool({
    name: "search_files",
    title: "Filename search",
    description: "Find files by name pattern (fd → rg --files → mdfind).",
    intent: "files",
  }),
  intentTool({
    name: "search_structure",
    title: "Structural search",
    description:
      "Syntax-aware code search (ast-grep pattern, e.g. '$A && $A.foo($$$B)'); requires lang. Falls back to rg.",
    intent: "structure",
    requiredExtra: { lang: z.string().describe("Language id (ts, tsx, py, rust, go…)") },
  }),
  intentTool({
    name: "search_docs",
    title: "Document search",
    description: "Search inside PDF/Office/ebook/archives (ripgrep-all). Falls back to filename match.",
    intent: "docs",
    extra: { pathGlob: pathGlobProperty, caseSensitive: caseSensitiveProperty },
  }),
  intentTool({
    name: "search_semantic",
    title: "Semantic code search",
    description:
      "Find code by meaning/symbol (auggie → serena → ast-grep → rg). Use FIRST for 'where is X handled' questions, " +
      "then verify hits with search_text.",
    intent: "semantic",
  }),
  intentTool({
    name: "search_machine",
    title: "Machine-wide filename search",
    description: "Spotlight (mdfind) filename search across the whole machine; optional roots to scope it.",
    intent: "machine",
  }),
  intentTool({
    name: "search_crossrepo",
    title: "Cross-repo search",
    description: "Search across many repositories (zoekt index if enabled, else rg over config roots).",
    intent: "crossrepo",
  }),
];

export function toolByName(name: string): ToolSpec | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
