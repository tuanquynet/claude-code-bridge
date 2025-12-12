#!/usr/bin/env python3
"""
Claude Code Bridge - MCP Server

Exposes local Claude Code CLI to browser Claude.ai via the
Model Context Protocol (MCP) over streamable HTTP transport.

https://github.com/talpah/claude-code-bridge
"""

import os
import json
import subprocess
from typing import Optional
from fastmcp import FastMCP

# Create MCP server
mcp = FastMCP("claude-code-bridge")


@mcp.tool()
def run_claude_code(
    prompt: str,
    working_dir: Optional[str] = None,
    allowed_tools: Optional[list[str]] = None,
    session_id: Optional[str] = None
) -> str:
    """
    Execute a task using Claude Code CLI.

    Args:
        prompt: The task to execute
        working_dir: Working directory for the task
        allowed_tools: Tools Claude Code can use (Read, Write, Bash, etc.)
        session_id: Resume a specific session
    """
    cmd = ["claude", "-p", prompt, "--output-format", "json"]

    if working_dir:
        cmd.extend(["--cwd", working_dir])

    if allowed_tools:
        cmd.extend(["--allowedTools", ",".join(allowed_tools)])

    if session_id:
        cmd.extend(["--resume", session_id])

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300
        )

        if result.returncode != 0:
            return f"Error: {result.stderr}"

        output = json.loads(result.stdout)

        # Format response
        response = []
        response.append(f"Session ID: {output.get('session_id', 'N/A')}")

        if output.get('messages'):
            response.append("\n--- Messages ---")
            for msg in output['messages']:
                if msg.get('type') == 'assistant':
                    response.append(f"Assistant: {msg.get('content', '')[:500]}")

        if output.get('result'):
            response.append(f"\n--- Result ---\n{output['result']}")

        if output.get('cost_usd'):
            response.append(f"\nCost: ${output['cost_usd']:.4f}")

        return "\n".join(response)

    except subprocess.TimeoutExpired:
        return "Error: Command timed out after 5 minutes"
    except Exception as e:
        return f"Error: {str(e)}"


@mcp.tool()
def list_directory(path: str) -> str:
    """
    List files and directories at the given path.

    Args:
        path: Directory path to list
    """
    try:
        entries = os.listdir(path)
        result = []
        for entry in sorted(entries):
            full_path = os.path.join(path, entry)
            if os.path.isdir(full_path):
                result.append(f"📁 {entry}/")
            else:
                try:
                    size = os.path.getsize(full_path)
                    result.append(f"📄 {entry} ({size:,} bytes)")
                except:
                    result.append(f"📄 {entry}")
        return "\n".join(result) or "(empty directory)"
    except FileNotFoundError:
        return f"Error: Directory not found: {path}"
    except PermissionError:
        return f"Error: Permission denied: {path}"
    except Exception as e:
        return f"Error: {str(e)}"


@mcp.tool()
def read_file(path: str, max_bytes: int = 100000) -> str:
    """
    Read contents of a file.

    Args:
        path: File path to read
        max_bytes: Maximum bytes to read (default 100KB)
    """
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read(max_bytes)
            if len(content) == max_bytes:
                content += f"\n\n... (truncated at {max_bytes:,} bytes)"
            return content
    except FileNotFoundError:
        return f"Error: File not found: {path}"
    except PermissionError:
        return f"Error: Permission denied: {path}"
    except Exception as e:
        return f"Error: {str(e)}"


@mcp.tool()
def write_file(path: str, content: str) -> str:
    """
    Write contents to a file.

    Args:
        path: File path to write
        content: Content to write
    """
    try:
        # Create parent directories if needed
        os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)

        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)

        return f"✓ Written {len(content):,} bytes to {path}"
    except PermissionError:
        return f"Error: Permission denied: {path}"
    except Exception as e:
        return f"Error: {str(e)}"


@mcp.tool()
def execute_command(command: str, working_dir: Optional[str] = None) -> str:
    """
    Execute a shell command.

    Args:
        command: Command to execute
        working_dir: Working directory (optional)
    """
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            cwd=working_dir,
            timeout=60
        )

        output_parts = []

        if result.stdout:
            output_parts.append(result.stdout)

        if result.stderr:
            output_parts.append(f"STDERR:\n{result.stderr}")

        if result.returncode != 0:
            output_parts.append(f"Exit code: {result.returncode}")

        return "\n".join(output_parts) or "(no output)"

    except subprocess.TimeoutExpired:
        return "Error: Command timed out after 60 seconds"
    except Exception as e:
        return f"Error: {str(e)}"


@mcp.tool()
def list_sessions() -> str:
    """List all Claude Code sessions."""
    try:
        result = subprocess.run(
            ["claude", "sessions", "list", "--output-format", "json"],
            capture_output=True,
            text=True,
            timeout=30
        )

        if result.returncode != 0:
            return f"Error: {result.stderr}"

        sessions = json.loads(result.stdout)

        if not sessions:
            return "No sessions found"

        output = []
        for s in sessions:
            output.append(f"📋 Session: {s.get('id', 'N/A')}")
            output.append(f"   Created: {s.get('created_at', 'N/A')}")
            output.append(f"   Directory: {s.get('working_dir', 'N/A')}")
            output.append("")

        return "\n".join(output)

    except Exception as e:
        return f"Error: {str(e)}"


if __name__ == "__main__":
    # Run with streamable-http transport on port 3000 (to use existing Cloudflare tunnel)
    # This is the recommended transport for production
    mcp.run(transport="streamable-http", host="0.0.0.0", port=3000)
