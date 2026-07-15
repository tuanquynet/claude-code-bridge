# Claude Code Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js 18+](https://img.shields.io/badge/node-18+-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-2025--03--26-green.svg)](https://modelcontextprotocol.io/)

Bridge [Claude.ai](https://claude.ai) to your local [Claude Code](https://claude.ai/code) CLI. Control your laptop from your phone or any browser.

## How It Works

```
┌─────────────────┐
│   Claude.ai     │  "Create a Python script..."
│   (Browser)     │
└────────┬────────┘
         │ HTTPS
         ▼
┌─────────────────┐
│   Cloudflare    │  mcp.your-domain.com
│     Tunnel      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   This Server   │  Node MCP → Claude Code CLI
│   (Your PC)     │  Executes tasks locally
└─────────────────┘
```

## Features

- **Remote Control** - Run Claude Code from anywhere via browser
- **Secure** - HTTPS via Cloudflare tunnel, no exposed ports
- **Full Access** - All Claude Code capabilities available
- **Session Management** - Continue multi-turn conversations
- **Auto-start** - Optional systemd service for boot startup

## Quick Start

```bash
git clone https://github.com/talpah/claude-code-bridge.git
cd claude-code-bridge
./setup.sh
```

The setup script will:

1. Install dependencies (uv, claude, cloudflared)
2. Configure Cloudflare tunnel
3. Optionally set up auto-start

## Available Tools

| Tool              | Description                         |
| ----------------- | ----------------------------------- |
| `run_claude_code` | Execute tasks using Claude Code CLI |
| `list_directory`  | List files and directories          |
| `read_file`       | Read file contents                  |
| `write_file`      | Write content to files              |
| `execute_command` | Run shell commands                  |
| `list_sessions`   | List Claude Code sessions           |

## Requirements

- Linux (Ubuntu/Debian)
- Node.js 18+
- Cloudflare account with a domain

## Manual Setup

If you prefer manual setup over the wizard:

### 1. Install Dependencies

```bash
# Node.js 18+ (via nvm, or your distro's package manager)
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install --lts

# Claude Code CLI
curl -fsSL https://claude.ai/install.sh | bash

# cloudflared (Debian/Ubuntu)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb
```

### 2. Configure Cloudflare Tunnel

```bash
# Login to Cloudflare
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create claude-code-bridge
cloudflared tunnel route dns claude-code-bridge mcp.your-domain.com
```

Create `~/.cloudflare-tunnel/config.yml`:

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: ~/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: mcp.your-domain.com
    service: http://localhost:3000
  - service: http_status:404
```

### 3. Install Node.js Dependencies

```bash
npm install
```

### 4. Start the Server

```bash
./start.sh
```

## Connect from Claude.ai

1. Go to [claude.ai](https://claude.ai)
2. Settings → Developer → Model Context Protocol
3. Add server: `https://mcp.your-domain.com/mcp`
4. Click Connect

## Usage

Once connected, ask Claude.ai things like:

```
"List files in ~/Projects"
"Read the README in my project"
"Use Claude Code to refactor this function"
"Run git status in ~/Projects/myapp"
```

## Project Structure

```
claude-code-bridge/
├── server.js      # MCP server (@modelcontextprotocol/sdk + Express)
├── start.sh       # Start server + tunnel
├── setup.sh       # Setup wizard
├── package.json   # Project config
└── LICENSE        # MIT license
```

## Logs

- Server: `/tmp/claude-code-bridge.log`
- Tunnel: `/tmp/tunnel.log`

## Stopping

```bash
# If running in foreground
Ctrl+C

# If running as service
sudo systemctl stop claude-code-bridge

# Manual stop
pkill -f "node server.js"
pkill cloudflared
```

## Permissions

By default the bridge exposes unrestricted shell and filesystem access. To
restrict it — Claude-Code style — create a `permissions.json` next to
`server.js` (copy `permissions.example.json` to start):

```json
{
  "commands": {
    "allow": ["git status:*", "npm run:*", "ls:*"],
    "deny": ["rm:*", "sudo:*"]
  },
  "directories": {
    "allow": ["~/projects", "/tmp/cc-bridge"]
  }
}
```

- **`commands`** — governs `execute_command`. Each chained segment (`&&`, `;`,
  `|`, …) must match an `allow` rule and no `deny` rule; deny always wins.
  Rule syntax matches Claude Code: `prefix:*` (prefix match), `*` (glob), or an
  exact string. Command substitution (`$(...)`, backticks) is rejected while an
  allowlist is active.
- **`directories`** — every path passed to `read_file` / `write_file` /
  `list_directory`, and any `working_dir`, must resolve inside one of these
  roots (symlinks and `..` traversal are resolved before checking). `~` expands
  to your home directory.
- **Omitting a section leaves it unrestricted.** No `permissions.json` at all
  == fully permissive (original behavior).

Point at a different file with `BRIDGE_PERMISSIONS_FILE=/path/to/perms.json`.
The server prints the active policy on startup.

## Security

- Binds to `127.0.0.1:3000` by default (override with `BRIDGE_HOST`)
- DNS-rebinding protection: only the local host and the configured tunnel
  domain are accepted in the `Host` header (extend via `BRIDGE_ALLOWED_HOSTS`)
- External access through Cloudflare tunnel (HTTPS)
- Claude Code runs with your user permissions — scope it with `permissions.json`
- No authentication by default (tunnel URL is the secret)

## License

[MIT](LICENSE)
