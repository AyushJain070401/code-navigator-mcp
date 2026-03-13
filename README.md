# 🧭 Code Navigator MCP Server

**Stop hallucinating. Start navigating.**

An MCP server that indexes your codebase and gives Claude (or any MCP client) the ability to **find the exact files** where issues live and **apply precise fixes** — using only real file content, never guesses.

---

## The Problem

When you ask Claude to fix a bug in your codebase, it often:
- ❌ Guesses file names and paths
- ❌ Invents code that doesn't match your actual files
- ❌ Makes changes based on assumptions, not reality
- ❌ Wastes time scanning every file manually

## The Solution

This MCP server gives Claude **11 surgical tools** to:

| Tool | What it does |
|------|-------------|
| `index_codebase` | Scans your project — builds a map of every file, function, class, interface |
| `list_structure` | Shows the directory tree so Claude understands project layout |
| `search_code` | Searches ALL files for keywords, error messages, variable names (with regex) |
| `search_files` | Finds files by name pattern (e.g. "auth", "config", "test") |
| `find_symbols` | Locates functions, classes, interfaces, types across the codebase |
| `read_file` | Reads the FULL content of a file with line numbers |
| `read_file_lines` | Reads a specific range of lines (for focused inspection) |
| `get_diagnostics` | Finds all TODO, FIXME, HACK, BUG comments developers left behind |
| `apply_fix` | Applies a precise find-and-replace edit (must match exactly — no hallucination) |
| `create_new_file` | Creates a new file when the fix requires one |
| `delete_lines` | Removes specific lines from a file |

### How `apply_fix` prevents hallucination:
- It requires the `old_code` to **exactly match** what's in the file
- If the match fails, it shows you **what's actually there** so you can correct
- If there are multiple matches, it rejects the edit and asks for a more specific block
- Claude MUST read the file first before attempting any fix

---

## Quick Start

### 1. Install

```bash
# Clone or copy this project
cd code-navigator-mcp

# Install dependencies
npm install

# Build
npm run build
```

### 2. Configure Claude Desktop

Open your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Add this MCP server:

```json
{
  "mcpServers": {
    "code-navigator": {
      "command": "node",
      "args": ["/FULL/PATH/TO/code-navigator-mcp/build/index.js"]
    }
  }
}
```

> ⚠️ Replace `/FULL/PATH/TO/` with the actual absolute path on your system.

### 3. Restart Claude Desktop

Close and reopen Claude Desktop. You should see the 🔌 tools icon showing the code-navigator tools.

---

## Usage Examples

### "Fix the bug in my authentication"

Just tell Claude:

```
I have a bug in my login flow — users get a 401 even with valid credentials.
My project is at /Users/me/projects/my-app

Find the issue and fix it.
```

Claude will automatically:
1. **Index** your codebase (`index_codebase`)
2. **Search** for auth-related files (`search_files` for "auth", "login")
3. **Search** for error handling (`search_code` for "401", "unauthorized")
4. **Read** the relevant files (`read_file`)
5. **Apply** a precise fix (`apply_fix`)

### "Find all the TODOs in my project"

```
Index my project at /Users/me/projects/my-app and show me all TODO and FIXME comments.
```

### "What functions does the UserService class have?"

```
Index /Users/me/projects/my-app and find all symbols in the UserService.
```

---

## Supported Languages

Symbol extraction (functions, classes, interfaces) works for:

- **TypeScript / JavaScript** (.ts, .tsx, .js, .jsx, .mjs, .cjs)
- **Python** (.py)
- **Go** (.go)
- **Rust** (.rs)
- **Java / Kotlin / C#** (.java, .kt, .cs)
- **Ruby** (.rb)
- **PHP** (.php)

Code search and file operations work for **any text file** (50+ extensions supported).

---

## Configuration

### Ignored Directories (automatic)

These are skipped by default: `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `vendor`, `target`, `__pycache__`, `venv`, and more.

You can add custom ignores:

```
Index my project at /path/to/project, but also ignore the "tmp" and "logs" directories.
```

### File Size Limit

Files larger than 1MB are automatically skipped to keep indexing fast.

---

## How It Works (Architecture)

```
┌─────────────────────────────┐
│     Claude Desktop / App    │
│   (or any MCP Client)       │
└─────────┬───────────────────┘
          │  MCP Protocol (stdio)
          │
┌─────────▼───────────────────┐
│   Code Navigator MCP Server │
│                             │
│  ┌───────────────────────┐  │
│  │   Indexer Engine       │  │
│  │  - File walker         │  │
│  │  - Symbol extractor    │  │
│  │  - Diagnostics scanner │  │
│  └───────────────────────┘  │
│                             │
│  ┌───────────────────────┐  │
│  │   Search Engine        │  │
│  │  - Content search      │  │
│  │  - File name search    │  │
│  │  - Symbol search       │  │
│  │  - Regex support       │  │
│  └───────────────────────┘  │
│                             │
│  ┌───────────────────────┐  │
│  │   Fix Engine           │  │
│  │  - Exact match verify  │  │
│  │  - Find & replace      │  │
│  │  - Create / delete     │  │
│  │  - Near-match helper   │  │
│  └───────────────────────┘  │
│                             │
└─────────┬───────────────────┘
          │  File System Access
          │
┌─────────▼───────────────────┐
│     Your Codebase           │
│  /Users/you/projects/app    │
└─────────────────────────────┘
```

---

## Using with Claude Code (CLI)

If you use Claude Code (the CLI tool), add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "code-navigator": {
      "command": "node",
      "args": ["/FULL/PATH/TO/code-navigator-mcp/build/index.js"]
    }
  }
}
```

---

## Tips for Best Results

1. **Always start with `index_codebase`** — Claude needs the map before it can navigate
2. **Describe issues with error messages** — "I get `TypeError: Cannot read property 'id' of undefined`" helps Claude search precisely
3. **Mention file names if you know them** — "The bug is somewhere in the auth module" narrows the search
4. **Let Claude read before fixing** — Claude will read the file content before applying any edit, ensuring accuracy

---

## License

MIT — use it, modify it, ship it.
