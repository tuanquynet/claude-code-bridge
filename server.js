#!/usr/bin/env node
/**
 * Claude Code Bridge - MCP Server
 *
 * Exposes local Claude Code CLI to browser Claude.ai via the
 * Model Context Protocol (MCP) over streamable HTTP transport.
 *
 * https://github.com/talpah/claude-code-bridge
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { loadPermissions, checkCommand, checkPath } from "./permissions.js";

// Permission policy (command allowlist + allowed directories). Absent config
// == fully permissive, preserving the original behavior. See permissions.js.
const PERMISSIONS_FILE =
  process.env.BRIDGE_PERMISSIONS_FILE ||
  path.join(import.meta.dirname, "permissions.json");
const PERMISSIONS = loadPermissions(PERMISSIONS_FILE);

/** Wrap a string as a plain text tool result. */
function text(value) {
  return { content: [{ type: "text", text: value }] };
}

/**
 * Hosts allowed in the `Host` header, used for DNS-rebinding protection.
 *
 * Always includes the local bind. A malicious web page that rebinds its own
 * domain to 127.0.0.1 sends its own domain in the Host header, so it is
 * rejected. Legitimate traffic through the Cloudflare tunnel arrives with the
 * public hostname, so the configured tunnel domain must be allowed too.
 *
 * Sources (all optional, merged):
 *   - localhost / 127.0.0.1 on the listen port (always)
 *   - the `.tunnel_domain` file written by setup.sh
 *   - the BRIDGE_ALLOWED_HOSTS env var (comma-separated)
 */
function resolveAllowedHosts(port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  try {
    const domainFile = path.join(import.meta.dirname, ".tunnel_domain");
    const domain = fs.readFileSync(domainFile, "utf-8").trim();
    if (domain) hosts.add(domain);
  } catch {
    // No tunnel domain configured; localhost-only is fine.
  }

  const fromEnv = process.env.BRIDGE_ALLOWED_HOSTS;
  if (fromEnv) {
    for (const h of fromEnv.split(",")) {
      const trimmed = h.trim();
      if (trimmed) hosts.add(trimmed);
    }
  }

  return [...hosts];
}

/** Build and configure a fresh MCP server instance with all tools registered. */
function createServer() {
  const mcp = new McpServer({
    name: "claude-code-bridge",
    version: "0.1.0",
  });

  mcp.registerTool(
    "run_claude_code",
    {
      description: "Execute a task using Claude Code CLI.",
      inputSchema: {
        prompt: z.string().describe("The task to execute"),
        working_dir: z
          .string()
          .optional()
          .describe("Working directory for the task"),
        allowed_tools: z
          .array(z.string())
          .optional()
          .describe("Tools Claude Code can use (Read, Write, Bash, etc.)"),
        session_id: z.string().optional().describe("Resume a specific session"),
      },
    },
    async ({ prompt, working_dir, allowed_tools, session_id }) => {
      if (working_dir) {
        const check = checkPath(PERMISSIONS, working_dir);
        if (!check.allowed)
          return text(`Error: Permission denied: ${check.reason}`);
      }

      const cmd = ["-p", prompt, "--output-format", "json"];

      if (working_dir) cmd.push("--cwd", working_dir);
      if (allowed_tools && allowed_tools.length)
        cmd.push("--allowedTools", allowed_tools.join(","));
      if (session_id) cmd.push("--resume", session_id);

      const result = spawnSync("claude", cmd, {
        encoding: "utf-8",
        timeout: 300_000,
        maxBuffer: 64 * 1024 * 1024,
      });

      if (result.error) {
        if (result.error.code === "ETIMEDOUT") {
          return text("Error: Command timed out after 5 minutes");
        }
        return text(`Error: ${result.error.message}`);
      }

      if (result.status !== 0) {
        return text(`Error: ${result.stderr}`);
      }

      let output;
      try {
        output = JSON.parse(result.stdout);
      } catch (e) {
        return text(`Error: ${e.message}`);
      }

      const response = [];
      response.push(`Session ID: ${output.session_id ?? "N/A"}`);

      if (Array.isArray(output.messages)) {
        response.push("\n--- Messages ---");
        for (const msg of output.messages) {
          if (msg.type === "assistant") {
            response.push(
              `Assistant: ${String(msg.content ?? "").slice(0, 500)}`,
            );
          }
        }
      }

      if (output.result) {
        response.push(`\n--- Result ---\n${output.result}`);
      }

      if (output.cost_usd) {
        response.push(`\nCost: $${Number(output.cost_usd).toFixed(4)}`);
      }

      return text(response.join("\n"));
    },
  );

  mcp.registerTool(
    "list_directory",
    {
      description: "List files and directories at the given path.",
      inputSchema: {
        path: z.string().describe("Directory path to list"),
      },
    },
    async ({ path: dirPath }) => {
      const check = checkPath(PERMISSIONS, dirPath);
      if (!check.allowed)
        return text(`Error: Permission denied: ${check.reason}`);
      try {
        const entries = fs.readdirSync(dirPath).sort();
        const result = [];
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              result.push(`📁 ${entry}/`);
            } else {
              result.push(
                `📄 ${entry} (${stat.size.toLocaleString("en-US")} bytes)`,
              );
            }
          } catch {
            result.push(`📄 ${entry}`);
          }
        }
        return text(result.join("\n") || "(empty directory)");
      } catch (e) {
        if (e.code === "ENOENT")
          return text(`Error: Directory not found: ${dirPath}`);
        if (e.code === "EACCES")
          return text(`Error: Permission denied: ${dirPath}`);
        return text(`Error: ${e.message}`);
      }
    },
  );

  mcp.registerTool(
    "read_file",
    {
      description: "Read contents of a file.",
      inputSchema: {
        path: z.string().describe("File path to read"),
        max_bytes: z
          .number()
          .int()
          .optional()
          .default(100000)
          .describe("Maximum bytes to read (default 100KB)"),
      },
    },
    async ({ path: filePath, max_bytes }) => {
      const check = checkPath(PERMISSIONS, filePath);
      if (!check.allowed)
        return text(`Error: Permission denied: ${check.reason}`);
      const maxBytes = max_bytes ?? 100000;
      try {
        const fd = fs.openSync(filePath, "r");
        try {
          const buffer = Buffer.alloc(maxBytes);
          const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
          let content = buffer.subarray(0, bytesRead).toString("utf-8");
          if (bytesRead === maxBytes) {
            content += `\n\n... (truncated at ${maxBytes.toLocaleString("en-US")} bytes)`;
          }
          return text(content);
        } finally {
          fs.closeSync(fd);
        }
      } catch (e) {
        if (e.code === "ENOENT")
          return text(`Error: File not found: ${filePath}`);
        if (e.code === "EACCES")
          return text(`Error: Permission denied: ${filePath}`);
        return text(`Error: ${e.message}`);
      }
    },
  );

  mcp.registerTool(
    "write_file",
    {
      description: "Write contents to a file.",
      inputSchema: {
        path: z.string().describe("File path to write"),
        content: z.string().describe("Content to write"),
      },
    },
    async ({ path: filePath, content }) => {
      const check = checkPath(PERMISSIONS, filePath);
      if (!check.allowed)
        return text(`Error: Permission denied: ${check.reason}`);
      try {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir || ".", { recursive: true });
        fs.writeFileSync(filePath, content, "utf-8");
        const byteLength = Buffer.byteLength(content, "utf-8");
        return text(
          `✓ Written ${byteLength.toLocaleString("en-US")} bytes to ${filePath}`,
        );
      } catch (e) {
        if (e.code === "EACCES")
          return text(`Error: Permission denied: ${filePath}`);
        return text(`Error: ${e.message}`);
      }
    },
  );

  mcp.registerTool(
    "execute_command",
    {
      description: "Execute a shell command.",
      inputSchema: {
        command: z.string().describe("Command to execute"),
        working_dir: z
          .string()
          .optional()
          .describe("Working directory (optional)"),
      },
    },
    async ({ command, working_dir }) => {
      if (working_dir) {
        const dirCheck = checkPath(PERMISSIONS, working_dir);
        if (!dirCheck.allowed)
          return text(`Error: Permission denied: ${dirCheck.reason}`);
      }
      const cmdCheck = checkCommand(PERMISSIONS, command);
      if (!cmdCheck.allowed)
        return text(`Error: Permission denied: ${cmdCheck.reason}`);

      const result = spawnSync(command, {
        shell: true,
        encoding: "utf-8",
        cwd: working_dir || undefined,
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      });

      if (result.error) {
        if (result.error.code === "ETIMEDOUT") {
          return text("Error: Command timed out after 60 seconds");
        }
        return text(`Error: ${result.error.message}`);
      }

      const parts = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(`STDERR:\n${result.stderr}`);
      if (result.status !== 0 && result.status !== null) {
        parts.push(`Exit code: ${result.status}`);
      }

      return text(parts.join("\n") || "(no output)");
    },
  );

  mcp.registerTool(
    "list_sessions",
    {
      description: "List all Claude Code sessions.",
      inputSchema: {},
    },
    async () => {
      const result = spawnSync(
        "claude",
        ["sessions", "list", "--output-format", "json"],
        { encoding: "utf-8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
      );

      if (result.error) {
        return text(`Error: ${result.error.message}`);
      }
      if (result.status !== 0) {
        return text(`Error: ${result.stderr}`);
      }

      let sessions;
      try {
        sessions = JSON.parse(result.stdout);
      } catch (e) {
        return text(`Error: ${e.message}`);
      }

      if (!sessions || sessions.length === 0) {
        return text("No sessions found");
      }

      const output = [];
      for (const s of sessions) {
        output.push(`📋 Session: ${s.id ?? "N/A"}`);
        output.push(`   Created: ${s.created_at ?? "N/A"}`);
        output.push(`   Directory: ${s.working_dir ?? "N/A"}`);
        output.push("");
      }

      return text(output.join("\n"));
    },
  );

  return mcp;
}

// --- Streamable HTTP transport (port 3000, mounted at /mcp) ---

const PORT = 3000;
// Bind to loopback by default so the raw port is not exposed to the LAN.
// Override with BRIDGE_HOST (e.g. 0.0.0.0) only when that exposure is intended.
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const ALLOWED_HOSTS = resolveAllowedHosts(PORT);

const app = express();
app.use(express.json());

// Map of active sessions: session id -> transport
const transports = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Guard against DNS-rebinding: a malicious web page cannot mint a
      // session unless its Host header is in the allowlist (localhost + the
      // configured tunnel domain). See resolveAllowedHosts().
      enableDnsRebindingProtection: true,
      allowedHosts: ALLOWED_HOSTS,
      onsessioninitialized: (id) => {
        transports[id] = transport;
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };

    const server = createServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// GET and DELETE share a handler for server->client streaming and session teardown.
const handleSessionRequest = async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
};

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

app.listen(PORT, HOST, () => {
  console.log(
    `claude-code-bridge MCP server listening on http://${HOST}:${PORT}/mcp`,
  );
  console.log(`Allowed Host headers: ${ALLOWED_HOSTS.join(", ")}`);
  if (PERMISSIONS) {
    console.log(`Permissions: enforcing ${PERMISSIONS_FILE}`);
    if (PERMISSIONS.commandAllow)
      console.log(
        `  commands: ${PERMISSIONS.commandAllow.length} allow rule(s), ${PERMISSIONS.commandDeny.length} deny rule(s)`,
      );
    if (PERMISSIONS.dirRoots)
      console.log(`  directories: ${PERMISSIONS.dirRoots.join(", ")}`);
  } else {
    console.log(
      `Permissions: none configured (fully permissive) — create ${PERMISSIONS_FILE} to restrict commands/directories`,
    );
  }
});
