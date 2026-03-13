#!/usr/bin/env node

/**
 * Code Navigator MCP Server
 * 
 * An MCP server that indexes your codebase, finds files related to issues,
 * and enables precise code fixes — no hallucination, only real file content.
 * 
 * Tools provided:
 *   - index_codebase     : Scan & index a project directory
 *   - list_structure     : Show the directory tree
 *   - search_code        : Search code by content/keyword/regex
 *   - search_files       : Search files by name pattern
 *   - find_symbols       : Find functions, classes, exports, interfaces
 *   - read_file          : Read full file content (with line numbers)
 *   - read_file_lines    : Read a specific range of lines
 *   - get_diagnostics    : Find TODOs, FIXMEs, HACKs, syntax markers
 *   - apply_fix          : Apply a precise find-and-replace fix
 *   - create_file        : Create a new file
 *   - delete_lines       : Delete specific lines from a file
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileIndex {
  relativePath: string;
  absolutePath: string;
  extension: string;
  sizeBytes: number;
  lastModified: string;
  lineCount: number;
}

interface SymbolEntry {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "export" | "variable" | "method" | "import" | "enum";
  file: string;
  line: number;
  signature: string;
}

interface DiagnosticEntry {
  file: string;
  line: number;
  kind: string;
  message: string;
}

interface CodebaseIndex {
  rootPath: string;
  files: FileIndex[];
  symbols: SymbolEntry[];
  indexedAt: string;
}

// ─── Configurable Ignore Patterns ─────────────────────────────────────────────

const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".tox", ".eggs", "dist", "build", ".next", ".nuxt",
  ".output", "coverage", ".nyc_output", ".cache", ".parcel-cache",
  "vendor", "target", "out", ".idea", ".vscode", ".DS_Store",
  "env", "venv", ".env", ".venv", "bower_components",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyw",
  ".java", ".kt", ".kts", ".scala",
  ".go",
  ".rs",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx",
  ".cs",
  ".rb", ".erb",
  ".php",
  ".swift",
  ".dart",
  ".lua",
  ".r", ".R",
  ".sql",
  ".sh", ".bash", ".zsh",
  ".yaml", ".yml", ".toml", ".json", ".xml",
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".md", ".mdx", ".txt", ".rst",
  ".vue", ".svelte",
  ".prisma", ".graphql", ".gql",
  ".dockerfile", ".tf", ".hcl",
  ".env.example", ".gitignore", ".eslintrc", ".prettierrc",
]);

const MAX_FILE_SIZE = 1024 * 1024; // 1MB — skip huge files

// ─── Global State ─────────────────────────────────────────────────────────────

let currentIndex: CodebaseIndex | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shouldIgnoreDir(name: string): boolean {
  return DEFAULT_IGNORE_DIRS.has(name) || name.startsWith(".");
}

function isCodeFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  // Also include dotfiles like .gitignore, Dockerfile, Makefile
  if (["dockerfile", "makefile", "rakefile", "gemfile", "procfile"].includes(base)) return true;
  return CODE_EXTENSIONS.has(ext);
}

function walkDirectory(dir: string, rootDir: string): FileIndex[] {
  const results: FileIndex[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!shouldIgnoreDir(entry.name)) {
        results.push(...walkDirectory(fullPath, rootDir));
      }
    } else if (entry.isFile() && isCodeFile(entry.name)) {
      try {
        const stats = fs.statSync(fullPath);
        if (stats.size > MAX_FILE_SIZE) continue;

        const content = fs.readFileSync(fullPath, "utf-8");
        const lineCount = content.split("\n").length;

        results.push({
          relativePath: path.relative(rootDir, fullPath),
          absolutePath: fullPath,
          extension: path.extname(entry.name).toLowerCase(),
          sizeBytes: stats.size,
          lastModified: stats.mtime.toISOString(),
          lineCount,
        });
      } catch {
        // Skip files we can't read
      }
    }
  }

  return results;
}

// ─── Symbol Extraction ────────────────────────────────────────────────────────

function extractSymbols(filePath: string, relativePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return symbols;
  }

  const lines = content.split("\n");
  const ext = path.extname(filePath).toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // ── TypeScript / JavaScript ────────────────────────────────────────
    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      // Functions (named, arrow assigned, methods)
      let match = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))/);
      if (match) {
        symbols.push({ name: match[1], kind: "function", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }

      // Arrow functions assigned to const/let/var
      match = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|(\w+))\s*=>/);
      if (match) {
        symbols.push({ name: match[1], kind: "function", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }

      // Classes
      match = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "class", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }

      // Interfaces
      match = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "interface", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }

      // Type aliases
      match = trimmed.match(/^(?:export\s+)?type\s+(\w+)\s*=/);
      if (match) {
        symbols.push({ name: match[1], kind: "type", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }

      // Enums
      match = trimmed.match(/^(?:export\s+)?enum\s+(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "enum", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
    }

    // ── Python ─────────────────────────────────────────────────────────
    if ([".py", ".pyw"].includes(ext)) {
      let match = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
      if (match) {
        symbols.push({ name: match[1], kind: "function", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
      match = trimmed.match(/^class\s+(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "class", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
    }

    // ── Go ─────────────────────────────────────────────────────────────
    if (ext === ".go") {
      let match = trimmed.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/);
      if (match) {
        symbols.push({ name: match[1], kind: "function", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
      match = trimmed.match(/^type\s+(\w+)\s+struct/);
      if (match) {
        symbols.push({ name: match[1], kind: "class", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
      match = trimmed.match(/^type\s+(\w+)\s+interface/);
      if (match) {
        symbols.push({ name: match[1], kind: "interface", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
    }

    // ── Rust ───────────────────────────────────────────────────────────
    if (ext === ".rs") {
      let match = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "function", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
      match = trimmed.match(/^(?:pub\s+)?struct\s+(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "class", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
      match = trimmed.match(/^(?:pub\s+)?trait\s+(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "interface", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
      match = trimmed.match(/^(?:pub\s+)?enum\s+(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "enum", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
    }

    // ── Java / Kotlin / C# ─────────────────────────────────────────────
    if ([".java", ".kt", ".kts", ".cs"].includes(ext)) {
      let match = trimmed.match(/(?:public|private|protected|internal|static|abstract|override|suspend|open|final|\s)*class\s+(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "class", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
      match = trimmed.match(/(?:public|private|protected|internal|static|abstract|override|suspend|open|final|\s)*interface\s+(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "interface", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
      match = trimmed.match(/(?:public|private|protected|internal|static|abstract|override|suspend|open|final|\s)*(?:fun|void|int|string|boolean|Task|async)\s+(\w+)\s*\(/);
      if (match) {
        symbols.push({ name: match[1], kind: "function", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
    }

    // ── Ruby ───────────────────────────────────────────────────────────
    if ([".rb", ".erb"].includes(ext)) {
      let match = trimmed.match(/^def\s+(?:self\.)?(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "function", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
      match = trimmed.match(/^class\s+(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "class", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
      match = trimmed.match(/^module\s+(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "interface", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
    }

    // ── PHP ────────────────────────────────────────────────────────────
    if (ext === ".php") {
      let match = trimmed.match(/(?:public|private|protected|static|\s)*function\s+(\w+)\s*\(/);
      if (match) {
        symbols.push({ name: match[1], kind: "function", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
      match = trimmed.match(/(?:abstract\s+)?class\s+(\w+)/);
      if (match) {
        symbols.push({ name: match[1], kind: "class", file: relativePath, line: lineNum, signature: trimmed.slice(0, 120) });
        continue;
      }
    }
  }

  return symbols;
}

// ─── Diagnostics Extraction ───────────────────────────────────────────────────

function extractDiagnostics(filePath: string, relativePath: string): DiagnosticEntry[] {
  const diagnostics: DiagnosticEntry[] = [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return diagnostics;
  }

  const lines = content.split("\n");
  const patterns = [
    { regex: /\/\/\s*TODO[:\s](.*)$/i, kind: "TODO" },
    { regex: /#\s*TODO[:\s](.*)$/i, kind: "TODO" },
    { regex: /\/\/\s*FIXME[:\s](.*)$/i, kind: "FIXME" },
    { regex: /#\s*FIXME[:\s](.*)$/i, kind: "FIXME" },
    { regex: /\/\/\s*HACK[:\s](.*)$/i, kind: "HACK" },
    { regex: /#\s*HACK[:\s](.*)$/i, kind: "HACK" },
    { regex: /\/\/\s*BUG[:\s](.*)$/i, kind: "BUG" },
    { regex: /#\s*BUG[:\s](.*)$/i, kind: "BUG" },
    { regex: /\/\/\s*WARN(?:ING)?[:\s](.*)$/i, kind: "WARNING" },
    { regex: /\/\/\s*DEPRECATED[:\s](.*)$/i, kind: "DEPRECATED" },
    { regex: /\/\/\s*NOTE[:\s](.*)$/i, kind: "NOTE" },
    { regex: /\/\/\s*XXX[:\s](.*)$/i, kind: "XXX" },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { regex, kind } of patterns) {
      const match = line.match(regex);
      if (match) {
        diagnostics.push({
          file: relativePath,
          line: i + 1,
          kind,
          message: match[1]?.trim() || "",
        });
      }
    }
  }

  return diagnostics;
}

// ─── Server Setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "code-navigator",
  version: "1.0.0",
});

// ── Tool: index_codebase ──────────────────────────────────────────────────────

server.tool(
  "index_codebase",
  "Scan and index a project directory. This MUST be called first before using other tools. " +
  "It builds a map of all files, functions, classes, and interfaces in your codebase.",
  {
    project_path: z.string().describe("Absolute path to the project root directory to index"),
    extra_ignore_dirs: z.array(z.string()).optional().describe("Additional directories to ignore (e.g. ['tmp', 'logs'])"),
  },
  async ({ project_path, extra_ignore_dirs }) => {
    const rootPath = path.resolve(project_path);

    if (!fs.existsSync(rootPath)) {
      return { content: [{ type: "text", text: `ERROR: Path does not exist: ${rootPath}` }] };
    }
    if (!fs.statSync(rootPath).isDirectory()) {
      return { content: [{ type: "text", text: `ERROR: Path is not a directory: ${rootPath}` }] };
    }

    // Add extra ignores
    if (extra_ignore_dirs) {
      for (const dir of extra_ignore_dirs) {
        DEFAULT_IGNORE_DIRS.add(dir);
      }
    }

    // Walk and index
    const files = walkDirectory(rootPath, rootPath);
    const symbols: SymbolEntry[] = [];

    for (const file of files) {
      symbols.push(...extractSymbols(file.absolutePath, file.relativePath));
    }

    currentIndex = {
      rootPath,
      files,
      symbols,
      indexedAt: new Date().toISOString(),
    };

    // Build summary
    const extCounts: Record<string, number> = {};
    for (const f of files) {
      extCounts[f.extension] = (extCounts[f.extension] || 0) + 1;
    }

    const symbolKindCounts: Record<string, number> = {};
    for (const s of symbols) {
      symbolKindCounts[s.kind] = (symbolKindCounts[s.kind] || 0) + 1;
    }

    const summary = [
      `✅ Indexed: ${rootPath}`,
      `📁 Files: ${files.length}`,
      `🔣 Symbols: ${symbols.length}`,
      ``,
      `File types:`,
      ...Object.entries(extCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([ext, count]) => `  ${ext}: ${count}`),
      ``,
      `Symbol types:`,
      ...Object.entries(symbolKindCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => `  ${kind}: ${count}`),
    ];

    return { content: [{ type: "text", text: summary.join("\n") }] };
  }
);

// ── Tool: list_structure ──────────────────────────────────────────────────────

server.tool(
  "list_structure",
  "Show the directory tree of the indexed codebase. Useful to understand project layout before diving into files.",
  {
    max_depth: z.number().optional().default(3).describe("Maximum depth to show (default: 3)"),
    dir_filter: z.string().optional().describe("Only show subtree under this directory path"),
  },
  async ({ max_depth, dir_filter }) => {
    if (!currentIndex) {
      return { content: [{ type: "text", text: "ERROR: No codebase indexed. Call index_codebase first." }] };
    }

    // Build tree structure
    const tree: Record<string, string[]> = {};
    for (const file of currentIndex.files) {
      const relPath = dir_filter
        ? (file.relativePath.startsWith(dir_filter) ? file.relativePath : null)
        : file.relativePath;

      if (!relPath) continue;

      const dir = path.dirname(relPath);
      if (!tree[dir]) tree[dir] = [];
      tree[dir].push(path.basename(relPath));
    }

    // Format as tree
    const lines: string[] = [`📂 ${currentIndex.rootPath}${dir_filter ? "/" + dir_filter : ""}`];

    const sortedDirs = Object.keys(tree).sort();
    for (const dir of sortedDirs) {
      const depth = dir === "." ? 0 : dir.split(path.sep).length;
      if (depth > max_depth) continue;

      const indent = "  ".repeat(depth);
      if (dir !== ".") {
        lines.push(`${indent}📁 ${dir}/`);
      }
      for (const file of tree[dir].sort()) {
        lines.push(`${indent}  📄 ${file}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Tool: search_code ─────────────────────────────────────────────────────────

server.tool(
  "search_code",
  "Search through all indexed files for a keyword, phrase, or regex pattern. " +
  "Returns matching lines with file path and line numbers. " +
  "Use this to find WHERE an issue occurs — e.g. search for error messages, variable names, function calls.",
  {
    query: z.string().describe("Search term or regex pattern to find in code"),
    is_regex: z.boolean().optional().default(false).describe("Treat query as regex pattern"),
    case_sensitive: z.boolean().optional().default(false).describe("Case-sensitive search"),
    file_pattern: z.string().optional().describe("Only search files matching this glob (e.g. '*.ts' or 'src/**')"),
    max_results: z.number().optional().default(50).describe("Maximum results to return"),
    context_lines: z.number().optional().default(2).describe("Number of lines of context around each match"),
  },
  async ({ query, is_regex, case_sensitive, file_pattern, max_results, context_lines }) => {
    if (!currentIndex) {
      return { content: [{ type: "text", text: "ERROR: No codebase indexed. Call index_codebase first." }] };
    }

    let regex: RegExp;
    try {
      const flags = case_sensitive ? "g" : "gi";
      regex = is_regex ? new RegExp(query, flags) : new RegExp(escapeRegex(query), flags);
    } catch (e: any) {
      return { content: [{ type: "text", text: `ERROR: Invalid regex: ${e.message}` }] };
    }

    const results: string[] = [];
    let matchCount = 0;

    for (const file of currentIndex.files) {
      if (matchCount >= max_results) break;

      // Apply file pattern filter
      if (file_pattern) {
        const pattern = file_pattern.replace(/\*/g, ".*");
        if (!new RegExp(pattern).test(file.relativePath)) continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(file.absolutePath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matchCount >= max_results) break;
        if (regex.test(lines[i])) {
          regex.lastIndex = 0; // Reset regex state

          const start = Math.max(0, i - context_lines);
          const end = Math.min(lines.length - 1, i + context_lines);

          const contextBlock = lines
            .slice(start, end + 1)
            .map((l, idx) => {
              const lineNum = start + idx + 1;
              const marker = (start + idx === i) ? ">>>" : "   ";
              return `${marker} ${String(lineNum).padStart(5)} │ ${l}`;
            })
            .join("\n");

          results.push(`\n📄 ${file.relativePath}:${i + 1}\n${contextBlock}`);
          matchCount++;
        }
      }
    }

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No matches found for: "${query}"` }] };
    }

    return {
      content: [{
        type: "text",
        text: `Found ${matchCount} match(es) for "${query}":\n${results.join("\n" + "─".repeat(60))}`
      }]
    };
  }
);

// ── Tool: search_files ────────────────────────────────────────────────────────

server.tool(
  "search_files",
  "Search for files by name pattern. Use to quickly find files like 'auth', 'config', 'routes', etc.",
  {
    pattern: z.string().describe("Filename pattern to search for (e.g. 'auth', 'config.ts', 'test')"),
    extension: z.string().optional().describe("Filter by extension (e.g. '.ts', '.py')"),
  },
  async ({ pattern, extension }) => {
    if (!currentIndex) {
      return { content: [{ type: "text", text: "ERROR: No codebase indexed. Call index_codebase first." }] };
    }

    const regex = new RegExp(escapeRegex(pattern), "i");
    const matches = currentIndex.files.filter((f) => {
      const nameMatch = regex.test(f.relativePath);
      const extMatch = extension ? f.extension === extension : true;
      return nameMatch && extMatch;
    });

    if (matches.length === 0) {
      return { content: [{ type: "text", text: `No files found matching: "${pattern}"` }] };
    }

    const list = matches
      .map((f) => `  📄 ${f.relativePath} (${f.lineCount} lines, ${formatBytes(f.sizeBytes)})`)
      .join("\n");

    return {
      content: [{ type: "text", text: `Found ${matches.length} file(s) matching "${pattern}":\n\n${list}` }]
    };
  }
);

// ── Tool: find_symbols ────────────────────────────────────────────────────────

server.tool(
  "find_symbols",
  "Find functions, classes, interfaces, types, enums in the codebase. " +
  "Use to understand code structure and find where things are defined.",
  {
    query: z.string().optional().describe("Name or partial name to search for"),
    kind: z.enum(["function", "class", "interface", "type", "export", "variable", "method", "import", "enum", "all"])
      .optional().default("all").describe("Filter by symbol kind"),
    file_path: z.string().optional().describe("Only show symbols in this file"),
  },
  async ({ query, kind, file_path }) => {
    if (!currentIndex) {
      return { content: [{ type: "text", text: "ERROR: No codebase indexed. Call index_codebase first." }] };
    }

    let filtered = currentIndex.symbols;

    if (query) {
      const regex = new RegExp(escapeRegex(query), "i");
      filtered = filtered.filter((s) => regex.test(s.name));
    }
    if (kind && kind !== "all") {
      filtered = filtered.filter((s) => s.kind === kind);
    }
    if (file_path) {
      filtered = filtered.filter((s) => s.file.includes(file_path));
    }

    if (filtered.length === 0) {
      return { content: [{ type: "text", text: "No symbols found matching your criteria." }] };
    }

    const lines = filtered.slice(0, 100).map((s) =>
      `  [${s.kind.toUpperCase().padEnd(10)}] ${s.name.padEnd(30)} → ${s.file}:${s.line}\n               ${s.signature}`
    );

    return {
      content: [{
        type: "text",
        text: `Found ${filtered.length} symbol(s)${filtered.length > 100 ? " (showing first 100)" : ""}:\n\n${lines.join("\n\n")}`
      }]
    };
  }
);

// ── Tool: read_file ───────────────────────────────────────────────────────────

server.tool(
  "read_file",
  "Read the FULL content of a file with line numbers. " +
  "This gives you the ACTUAL file content — use this before making any fixes to see exactly what's there.",
  {
    file_path: z.string().describe("Relative path from project root (e.g. 'src/auth/login.ts')"),
  },
  async ({ file_path }) => {
    if (!currentIndex) {
      return { content: [{ type: "text", text: "ERROR: No codebase indexed. Call index_codebase first." }] };
    }

    const absPath = path.join(currentIndex.rootPath, file_path);

    if (!fs.existsSync(absPath)) {
      // Try fuzzy match
      const matches = currentIndex.files.filter((f) => f.relativePath.endsWith(file_path) || f.relativePath.includes(file_path));
      if (matches.length > 0) {
        const suggestions = matches.slice(0, 5).map((f) => `  - ${f.relativePath}`).join("\n");
        return {
          content: [{ type: "text", text: `File not found: "${file_path}"\n\nDid you mean:\n${suggestions}` }]
        };
      }
      return { content: [{ type: "text", text: `File not found: "${file_path}"` }] };
    }

    const content = fs.readFileSync(absPath, "utf-8");
    const lines = content.split("\n");
    const numbered = lines.map((line, i) => `${String(i + 1).padStart(5)} │ ${line}`).join("\n");

    return {
      content: [{
        type: "text",
        text: `📄 ${file_path} (${lines.length} lines)\n${"─".repeat(60)}\n${numbered}`
      }]
    };
  }
);

// ── Tool: read_file_lines ─────────────────────────────────────────────────────

server.tool(
  "read_file_lines",
  "Read specific lines from a file. Use when you already know the area of interest " +
  "(e.g. from search results or symbol locations) and want to see the surrounding code.",
  {
    file_path: z.string().describe("Relative path from project root"),
    start_line: z.number().describe("First line to read (1-indexed)"),
    end_line: z.number().describe("Last line to read (1-indexed, inclusive)"),
  },
  async ({ file_path, start_line, end_line }) => {
    if (!currentIndex) {
      return { content: [{ type: "text", text: "ERROR: No codebase indexed. Call index_codebase first." }] };
    }

    const absPath = path.join(currentIndex.rootPath, file_path);

    if (!fs.existsSync(absPath)) {
      return { content: [{ type: "text", text: `File not found: "${file_path}"` }] };
    }

    const content = fs.readFileSync(absPath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(1, start_line) - 1;
    const end = Math.min(lines.length, end_line);

    const numbered = lines
      .slice(start, end)
      .map((line, i) => `${String(start + i + 1).padStart(5)} │ ${line}`)
      .join("\n");

    return {
      content: [{
        type: "text",
        text: `📄 ${file_path} (lines ${start + 1}-${end} of ${lines.length})\n${"─".repeat(60)}\n${numbered}`
      }]
    };
  }
);

// ── Tool: get_diagnostics ─────────────────────────────────────────────────────

server.tool(
  "get_diagnostics",
  "Find all TODO, FIXME, HACK, BUG, WARNING, and DEPRECATED comments in the codebase. " +
  "Useful to find known issues the developer has already flagged.",
  {
    kind: z.string().optional().describe("Filter by kind: TODO, FIXME, HACK, BUG, WARNING, DEPRECATED, NOTE, or 'all'"),
    file_path: z.string().optional().describe("Only show diagnostics in this file/directory"),
  },
  async ({ kind, file_path }) => {
    if (!currentIndex) {
      return { content: [{ type: "text", text: "ERROR: No codebase indexed. Call index_codebase first." }] };
    }

    let allDiags: DiagnosticEntry[] = [];
    for (const file of currentIndex.files) {
      if (file_path && !file.relativePath.includes(file_path)) continue;
      allDiags.push(...extractDiagnostics(file.absolutePath, file.relativePath));
    }

    if (kind && kind.toLowerCase() !== "all") {
      allDiags = allDiags.filter((d) => d.kind.toLowerCase() === kind.toLowerCase());
    }

    if (allDiags.length === 0) {
      return { content: [{ type: "text", text: "No diagnostic comments found." }] };
    }

    const lines = allDiags.map((d) =>
      `  [${d.kind.padEnd(10)}] ${d.file}:${d.line} → ${d.message}`
    );

    return {
      content: [{
        type: "text",
        text: `Found ${allDiags.length} diagnostic comment(s):\n\n${lines.join("\n")}`
      }]
    };
  }
);

// ── Tool: apply_fix ───────────────────────────────────────────────────────────

server.tool(
  "apply_fix",
  "Apply a precise fix to a file using find-and-replace. " +
  "The old_code must EXACTLY match what's in the file (read the file first!). " +
  "This ensures no hallucinated changes — only real, targeted edits.",
  {
    file_path: z.string().describe("Relative path from project root"),
    old_code: z.string().describe("EXACT code to find and replace (must match file content exactly, including whitespace)"),
    new_code: z.string().describe("New code to replace it with"),
    description: z.string().optional().describe("Brief description of what this fix does"),
  },
  async ({ file_path, old_code, new_code, description }) => {
    if (!currentIndex) {
      return { content: [{ type: "text", text: "ERROR: No codebase indexed. Call index_codebase first." }] };
    }

    const absPath = path.join(currentIndex.rootPath, file_path);

    if (!fs.existsSync(absPath)) {
      return { content: [{ type: "text", text: `File not found: "${file_path}"` }] };
    }

    const content = fs.readFileSync(absPath, "utf-8");

    // Verify old_code exists exactly
    const index = content.indexOf(old_code);
    if (index === -1) {
      // Help debug: find closest match
      const oldLines = old_code.trim().split("\n");
      const firstLine = oldLines[0].trim();
      const contentLines = content.split("\n");
      const nearMatches: string[] = [];

      for (let i = 0; i < contentLines.length; i++) {
        if (contentLines[i].includes(firstLine.slice(0, 30))) {
          const snippet = contentLines.slice(i, i + oldLines.length).join("\n");
          nearMatches.push(`Near line ${i + 1}:\n${snippet}`);
        }
      }

      let msg = `ERROR: old_code not found in "${file_path}". The exact text does not exist.\n\n`;
      msg += `IMPORTANT: Read the file first with read_file to see the actual content.\n`;
      if (nearMatches.length > 0) {
        msg += `\nPossible near-matches:\n${nearMatches.slice(0, 3).join("\n\n")}`;
      }

      return { content: [{ type: "text", text: msg }] };
    }

    // Check for multiple matches
    const secondIndex = content.indexOf(old_code, index + 1);
    if (secondIndex !== -1) {
      return {
        content: [{
          type: "text",
          text: `ERROR: old_code appears multiple times in "${file_path}". ` +
                `Please provide a more unique/larger code block to match exactly one location.`
        }]
      };
    }

    // Apply the fix
    const newContent = content.slice(0, index) + new_code + content.slice(index + old_code.length);
    fs.writeFileSync(absPath, newContent, "utf-8");

    // Show diff context
    const oldLines = old_code.split("\n");
    const newLines = new_code.split("\n");

    const diff = [
      `✅ Fix applied to ${file_path}`,
      description ? `📝 ${description}` : "",
      "",
      `--- REMOVED (${oldLines.length} lines) ---`,
      ...oldLines.map((l) => `- ${l}`),
      "",
      `+++ ADDED (${newLines.length} lines) +++`,
      ...newLines.map((l) => `+ ${l}`),
    ].filter(Boolean);

    // Update index line count
    const fileEntry = currentIndex.files.find((f) => f.relativePath === file_path);
    if (fileEntry) {
      fileEntry.lineCount = newContent.split("\n").length;
    }

    return { content: [{ type: "text", text: diff.join("\n") }] };
  }
);

// ── Tool: create_new_file ─────────────────────────────────────────────────────

server.tool(
  "create_new_file",
  "Create a new file in the project. Use when a fix requires adding a new file.",
  {
    file_path: z.string().describe("Relative path from project root for the new file"),
    content: z.string().describe("Content of the new file"),
    description: z.string().optional().describe("Brief description of what this file is for"),
  },
  async ({ file_path, content, description }) => {
    if (!currentIndex) {
      return { content: [{ type: "text", text: "ERROR: No codebase indexed. Call index_codebase first." }] };
    }

    const absPath = path.join(currentIndex.rootPath, file_path);

    if (fs.existsSync(absPath)) {
      return { content: [{ type: "text", text: `ERROR: File already exists: "${file_path}". Use apply_fix to modify it.` }] };
    }

    // Create directories if needed
    const dir = path.dirname(absPath);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(absPath, content, "utf-8");

    // Add to index
    const stats = fs.statSync(absPath);
    const fileEntry: FileIndex = {
      relativePath: file_path,
      absolutePath: absPath,
      extension: path.extname(file_path).toLowerCase(),
      sizeBytes: stats.size,
      lastModified: stats.mtime.toISOString(),
      lineCount: content.split("\n").length,
    };
    currentIndex.files.push(fileEntry);

    // Extract symbols from new file
    const newSymbols = extractSymbols(absPath, file_path);
    currentIndex.symbols.push(...newSymbols);

    return {
      content: [{
        type: "text",
        text: `✅ Created: ${file_path} (${fileEntry.lineCount} lines)${description ? `\n📝 ${description}` : ""}`
      }]
    };
  }
);

// ── Tool: delete_lines ────────────────────────────────────────────────────────

server.tool(
  "delete_lines",
  "Delete specific lines from a file. Use when you need to remove code blocks.",
  {
    file_path: z.string().describe("Relative path from project root"),
    start_line: z.number().describe("First line to delete (1-indexed)"),
    end_line: z.number().describe("Last line to delete (1-indexed, inclusive)"),
  },
  async ({ file_path, start_line, end_line }) => {
    if (!currentIndex) {
      return { content: [{ type: "text", text: "ERROR: No codebase indexed. Call index_codebase first." }] };
    }

    const absPath = path.join(currentIndex.rootPath, file_path);

    if (!fs.existsSync(absPath)) {
      return { content: [{ type: "text", text: `File not found: "${file_path}"` }] };
    }

    const content = fs.readFileSync(absPath, "utf-8");
    const lines = content.split("\n");

    if (start_line < 1 || end_line > lines.length || start_line > end_line) {
      return {
        content: [{
          type: "text",
          text: `ERROR: Invalid line range ${start_line}-${end_line}. File has ${lines.length} lines.`
        }]
      };
    }

    const deleted = lines.splice(start_line - 1, end_line - start_line + 1);
    fs.writeFileSync(absPath, lines.join("\n"), "utf-8");

    return {
      content: [{
        type: "text",
        text: `✅ Deleted lines ${start_line}-${end_line} from ${file_path}:\n\n${deleted.map((l, i) => `- ${String(start_line + i).padStart(5)} │ ${l}`).join("\n")}`
      }]
    };
  }
);

// ─── Utility ──────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 Code Navigator MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
