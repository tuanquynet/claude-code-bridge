#!/bin/bash
#
# Claude Code Bridge - Setup Script
# Installs dependencies and configures the MCP server with Cloudflare tunnel
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/.cloudflare-tunnel"

# Helper functions
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

ask_yes_no() {
    local prompt="$1"
    local default="${2:-y}"
    local answer

    if [[ "$default" == "y" ]]; then
        read -rp "$prompt [Y/n]: " answer
        answer="${answer:-y}"
    else
        read -rp "$prompt [y/N]: " answer
        answer="${answer:-n}"
    fi

    [[ "${answer,,}" == "y" || "${answer,,}" == "yes" ]]
}

check_command() {
    command -v "$1" &>/dev/null
}

# Header
echo ""
echo "========================================"
echo "  Claude Code Bridge - Setup"
echo "========================================"
echo ""

# Check if running on Linux
if [[ "$(uname)" != "Linux" ]]; then
    error "This setup script is designed for Linux systems only."
    exit 1
fi

# ============================================
# Section 1: Check/Install uv
# ============================================
echo ""
info "Checking for uv package manager..."

if check_command uv; then
    success "uv is installed ($(uv --version 2>/dev/null | head -1))"
else
    warn "uv is not installed"
    if ask_yes_no "Install uv?"; then
        info "Installing uv..."
        curl -LsSf https://astral.sh/uv/install.sh | sh

        # Add to PATH for this session
        export PATH="$HOME/.local/bin:$PATH"

        if check_command uv; then
            success "uv installed successfully"
        else
            error "Failed to install uv. Please install manually: https://docs.astral.sh/uv/"
            exit 1
        fi
    else
        error "uv is required. Please install it manually."
        exit 1
    fi
fi

# ============================================
# Section 2: Check/Install Claude Code CLI
# ============================================
echo ""
info "Checking for Claude Code CLI..."

if check_command claude; then
    success "Claude Code CLI is installed ($(claude --version 2>/dev/null | head -1))"
else
    warn "Claude Code CLI is not installed"
    if ask_yes_no "Install Claude Code CLI?"; then
        info "Installing Claude Code CLI..."
        curl -fsSL https://claude.ai/install.sh | bash

        # Add to PATH for this session
        export PATH="$HOME/.claude/bin:$PATH"

        if check_command claude; then
            success "Claude Code CLI installed successfully"
        else
            error "Failed to install Claude Code CLI"
            exit 1
        fi
    else
        error "Claude Code CLI is required."
        exit 1
    fi
fi

# ============================================
# Section 3: Check/Install cloudflared
# ============================================
echo ""
info "Checking for cloudflared..."

if check_command cloudflared; then
    success "cloudflared is installed ($(cloudflared --version 2>/dev/null | head -1))"
else
    warn "cloudflared is not installed"
    if ask_yes_no "Install cloudflared?"; then
        info "Installing cloudflared..."

        # Detect architecture
        ARCH=$(dpkg --print-architecture 2>/dev/null || echo "amd64")

        # Download and install
        TEMP_DEB=$(mktemp)
        curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb" -o "$TEMP_DEB"
        sudo dpkg -i "$TEMP_DEB"
        rm -f "$TEMP_DEB"

        if check_command cloudflared; then
            success "cloudflared installed successfully"
        else
            error "Failed to install cloudflared"
            exit 1
        fi
    else
        error "cloudflared is required."
        exit 1
    fi
fi

# ============================================
# Section 4: Check Claude Code authentication
# ============================================
echo ""
info "Checking Claude Code authentication..."

# Try to check if claude is authenticated
if claude auth status &>/dev/null; then
    success "Claude Code is authenticated"
else
    warn "Claude Code is not authenticated"
    echo ""
    echo "You need to authenticate with Claude Code."
    echo "This will open a browser window for authentication."
    echo ""
    if ask_yes_no "Run 'claude auth login' now?"; then
        claude auth login
        if claude auth status &>/dev/null; then
            success "Authentication successful"
        else
            warn "Authentication may have failed. You can retry later with: claude auth login"
        fi
    else
        warn "Remember to run 'claude auth login' before using the bridge."
    fi
fi

# ============================================
# Section 5: Cloudflare Tunnel Setup
# ============================================
echo ""
info "Checking Cloudflare tunnel configuration..."

TUNNEL_CONFIGURED=false

if [[ -f "$CONFIG_DIR/config.yml" ]]; then
    success "Tunnel config found at $CONFIG_DIR/config.yml"
    TUNNEL_CONFIGURED=true

    if ask_yes_no "Reconfigure Cloudflare tunnel?" "n"; then
        TUNNEL_CONFIGURED=false
    fi
fi

if [[ "$TUNNEL_CONFIGURED" == "false" ]]; then
    echo ""
    echo "Cloudflare Tunnel Setup"
    echo "-----------------------"
    echo "You need a Cloudflare account and a domain managed by Cloudflare."
    echo ""
    echo "Choose authentication method:"
    echo "  1) Browser login (recommended - opens browser for OAuth)"
    echo "  2) API token (for headless/automated setup)"
    echo ""
    read -rp "Select option [1/2]: " CF_AUTH_METHOD

    case "$CF_AUTH_METHOD" in
        2)
            # API Token method
            echo ""
            echo "You'll need a Cloudflare API token with these permissions:"
            echo "  - Account: Cloudflare Tunnel: Edit"
            echo "  - Zone: DNS: Edit (for your domain)"
            echo ""
            read -rp "Enter your Cloudflare API token: " CF_API_TOKEN
            read -rp "Enter your Cloudflare Account ID: " CF_ACCOUNT_ID

            export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"
            export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
            ;;
        *)
            # Browser login (default)
            info "Opening browser for Cloudflare authentication..."
            cloudflared tunnel login
            ;;
    esac

    # Get domain from user
    echo ""
    read -rp "Enter the domain for your MCP server (e.g., mcp.example.com): " USER_DOMAIN

    if [[ -z "$USER_DOMAIN" ]]; then
        error "Domain cannot be empty"
        exit 1
    fi

    # Create tunnel
    TUNNEL_NAME="claude-code-bridge"
    info "Creating tunnel '$TUNNEL_NAME'..."

    # Check if tunnel already exists
    if cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
        warn "Tunnel '$TUNNEL_NAME' already exists"
        TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}')
    else
        cloudflared tunnel create "$TUNNEL_NAME"
        TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}')
    fi

    if [[ -z "$TUNNEL_ID" ]]; then
        error "Failed to get tunnel ID"
        exit 1
    fi

    success "Tunnel ID: $TUNNEL_ID"

    # Route DNS
    info "Configuring DNS for $USER_DOMAIN..."
    cloudflared tunnel route dns "$TUNNEL_NAME" "$USER_DOMAIN" || warn "DNS route may already exist"

    # Create config directory
    mkdir -p "$CONFIG_DIR"

    # Find credentials file
    CREDS_FILE="$HOME/.cloudflared/${TUNNEL_ID}.json"
    if [[ ! -f "$CREDS_FILE" ]]; then
        error "Credentials file not found at $CREDS_FILE"
        exit 1
    fi

    # Generate config
    info "Generating tunnel configuration..."
    cat > "$CONFIG_DIR/config.yml" << EOF
tunnel: $TUNNEL_ID
credentials-file: $CREDS_FILE

ingress:
  - hostname: $USER_DOMAIN
    service: http://localhost:3000
  - service: http_status:404
EOF

    success "Tunnel configuration saved to $CONFIG_DIR/config.yml"

    # Save domain for reference
    echo "$USER_DOMAIN" > "$SCRIPT_DIR/.tunnel_domain"

    TUNNEL_CONFIGURED=true
fi

# ============================================
# Section 6: Install Python dependencies
# ============================================
echo ""
info "Installing Python dependencies..."

cd "$SCRIPT_DIR"
uv sync

success "Python dependencies installed"

# ============================================
# Section 7: Systemd Service (Optional)
# ============================================
echo ""
if ask_yes_no "Enable auto-start on boot (systemd service)?"; then
    info "Setting up systemd service..."

    SERVICE_FILE="/etc/systemd/system/claude-code-bridge.service"

    # Create service file
    sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=Claude Code Bridge MCP Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$SCRIPT_DIR/start.sh
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

    # Reload systemd and enable service
    sudo systemctl daemon-reload
    sudo systemctl enable claude-code-bridge

    success "Systemd service created and enabled"

    if ask_yes_no "Start the service now?"; then
        sudo systemctl start claude-code-bridge
        sleep 2

        if sudo systemctl is-active --quiet claude-code-bridge; then
            success "Service started successfully"
        else
            warn "Service may have failed to start. Check: sudo systemctl status claude-code-bridge"
        fi
    fi
else
    info "Skipping systemd setup. Start manually with: ./start.sh"
fi

# ============================================
# Section 8: Verification
# ============================================
echo ""
info "Running verification checks..."

# Check if server can start (quick test)
if [[ -f "$CONFIG_DIR/config.yml" ]]; then
    success "Tunnel config: OK"
else
    warn "Tunnel config: Missing"
fi

if check_command claude && claude auth status &>/dev/null; then
    success "Claude auth: OK"
else
    warn "Claude auth: Not configured"
fi

# ============================================
# Section 9: Summary
# ============================================
echo ""
echo "========================================"
echo "  Setup Complete!"
echo "========================================"
echo ""

if [[ -f "$SCRIPT_DIR/.tunnel_domain" ]]; then
    DOMAIN=$(cat "$SCRIPT_DIR/.tunnel_domain")
    echo "Your MCP server will be available at:"
    echo "  https://$DOMAIN/mcp"
    echo ""
fi

echo "Next steps:"
echo ""
echo "1. Start the server:"
if sudo systemctl is-enabled --quiet claude-code-bridge 2>/dev/null; then
    echo "   sudo systemctl start claude-code-bridge"
    echo "   (or it will start automatically on boot)"
else
    echo "   ./start_home_claude.sh"
fi
echo ""
echo "2. Connect from Claude.ai:"
echo "   - Go to claude.ai"
echo "   - Settings → Developer → Model Context Protocol"
if [[ -n "$DOMAIN" ]]; then
    echo "   - Add server: https://$DOMAIN/mcp"
else
    echo "   - Add server: https://your-domain.com/mcp"
fi
echo ""
echo "3. Test the connection:"
if [[ -n "$DOMAIN" ]]; then
    echo "   curl -X POST \"https://$DOMAIN/mcp\" \\"
else
    echo "   curl -X POST \"https://your-domain.com/mcp\" \\"
fi
echo "     -H \"Content-Type: application/json\" \\"
echo "     -H \"Accept: application/json, text/event-stream\" \\"
echo "     -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1.0\"}}}'"
echo ""
success "Setup complete!"
