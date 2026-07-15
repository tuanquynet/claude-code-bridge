#!/bin/bash
# Start Claude Code Bridge Server

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/.cloudflare-tunnel"
CONFIG_FILE="$CONFIG_DIR/config.yml"
DOMAIN_FILE="$SCRIPT_DIR/.tunnel_domain"

# Check if tunnel is configured
if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ Tunnel not configured yet!"
    echo ""
    echo "Run this first:"
    echo "  ./setup.sh"
    exit 1
fi

# Get domain
if [ -f "$DOMAIN_FILE" ]; then
    DOMAIN=$(cat "$DOMAIN_FILE")
else
    DOMAIN="your-domain.com"
fi

echo "========================================"
echo "  Claude Code Bridge"
echo "========================================"
echo ""

# Kill any existing processes first
echo "Checking for existing processes..."

# Kill any process using port 3000
if lsof -ti:3000 >/dev/null 2>&1; then
    echo "  Killing existing server on port 3000..."
    lsof -ti:3000 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# Kill any existing Node MCP servers
if pgrep -f "node server.js" >/dev/null 2>&1; then
    echo "  Killing existing MCP server processes..."
    pkill -9 -f "node server.js" || true
    sleep 1
fi

# Kill any existing cloudflared tunnels
if pgrep cloudflared >/dev/null 2>&1; then
    echo "  Killing existing Cloudflare tunnels..."
    pkill -9 cloudflared || true
    sleep 1
fi

echo "✓ Cleanup complete"
echo ""

# Create a cleanup function
cleanup() {
    echo ""
    echo "Stopping services..."
    kill $SERVER_PID $TUNNEL_PID 2>/dev/null || true
    wait $SERVER_PID $TUNNEL_PID 2>/dev/null || true
    echo "✓ Services stopped"
    exit 0
}

trap cleanup SIGINT SIGTERM

# Start MCP server
echo "Starting MCP server..."
cd "$SCRIPT_DIR"

node server.js > /tmp/claude-code-bridge.log 2>&1 &
SERVER_PID=$!
echo "✓ MCP server started (PID: $SERVER_PID)"
echo "  Logs: /tmp/claude-code-bridge.log"

# Give the server time to start
sleep 3

# Start Cloudflare tunnel
echo "Starting Cloudflare tunnel..."
cloudflared tunnel --config "$CONFIG_FILE" run > /tmp/tunnel.log 2>&1 &
TUNNEL_PID=$!
echo "✓ Cloudflare tunnel started (PID: $TUNNEL_PID)"
echo "  Logs: /tmp/tunnel.log"

echo ""
echo "========================================"
echo "  Server is running!"
echo "========================================"
echo ""
echo "Public URL: https://$DOMAIN/sse"
echo ""
echo "Test with:"
echo "  curl -X POST https://$DOMAIN/sse \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1.0\"}}}'"
echo ""
echo "Press Ctrl+C to stop"
echo ""

# Wait for both processes
wait $SERVER_PID $TUNNEL_PID
