/**
 * Permission layer for Claude Code Bridge.
 *
 * Mirrors Claude Code's settings.json permission model: a JSON config declares
 * which shell commands may run and which directories may be touched. Deny rules
 * always win over allow rules.
 *
 * Config shape (all sections optional):
 *   {
 *     "commands": {
 *       "allow": ["git status:*", "npm run *", "ls:*"],
 *       "deny":  ["rm:*", "sudo:*"]
 *     },
 *     "directories": {
 *       "allow": ["~/projects", "/tmp/work"]
 *     }
 *   }
 *
 * Rule matching for commands:
 *   - An optional `Bash(...)` wrapper is stripped (Claude Code compatibility).
 *   - `prefix:*`  matches the command `prefix` exactly or `prefix ` + args.
 *   - `*`         is a glob wildcard anywhere in the pattern.
 *   - otherwise   an exact-string match.
 *
 * Semantics:
 *   - If the `commands` section is absent, ALL commands are allowed.
 *   - If the `directories` section is absent, ALL paths are allowed.
 *   - So an empty/absent config == fully permissive (backward compatible).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Expand a leading `~` to the user's home directory. */
function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a path to its canonical (symlink-free) absolute form.
 *
 * The target may not exist yet (e.g. write_file creating a new file), so walk
 * up to the nearest existing ancestor, realpath that, then re-append the
 * not-yet-existing tail. This keeps containment checks correct across symlinks
 * such as macOS's /tmp -> /private/tmp.
 */
function realResolve(p) {
  const abs = path.resolve(expandHome(p));
  const tail = [];
  let cur = abs;
  while (true) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      if (e.code !== "ENOENT") return abs;
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // reached filesystem root
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Load and normalize the permissions config.
 * Returns `null` (fully permissive) when the file does not exist.
 * Throws on unreadable or malformed config.
 */
export function loadPermissions(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(
      `Failed to read permissions config ${configPath}: ${e.message}`,
    );
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Invalid JSON in permissions config ${configPath}: ${e.message}`,
    );
  }

  const dirs = cfg.directories?.allow ?? null;
  const dirRoots = dirs
    ? dirs.map((d) => {
        const abs = path.resolve(expandHome(d));
        // Resolve symlinks on the root so containment checks are accurate.
        try {
          return fs.realpathSync(abs);
        } catch {
          return abs;
        }
      })
    : null;

  return {
    commandAllow: cfg.commands?.allow ?? null,
    commandDeny: cfg.commands?.deny ?? [],
    dirRoots,
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does a single command segment match one rule? */
function matchesRule(command, rule) {
  let pattern = rule.trim();

  const wrapped = pattern.match(/^Bash\((.*)\)$/);
  if (wrapped) pattern = wrapped[1];

  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return command === prefix || command.startsWith(prefix + " ");
  }

  if (pattern.includes("*")) {
    const re = new RegExp(
      "^" + pattern.split("*").map(escapeRegExp).join(".*") + "$",
    );
    return re.test(command);
  }

  return command === pattern;
}

// Shell operators that chain or nest commands.
const SHELL_SPLIT = /&&|\|\||;|\||&|\n/;

/**
 * Check a shell command against the command allow/deny rules.
 * Returns { allowed: boolean, reason?: string }.
 */
export function checkCommand(perms, command) {
  if (!perms || perms.commandAllow === null) return { allowed: true };

  // Command/process substitution can hide nested commands the allowlist can't
  // see, so refuse it outright when an allowlist is active (fail closed).
  if (/\$\(|`|<\(|>\(/.test(command)) {
    return {
      allowed: false,
      reason:
        "command substitution is not permitted when a command allowlist is active",
    };
  }

  // Every chained segment must independently pass allow/deny.
  const segments = command.split(SHELL_SPLIT);
  for (const segment of segments) {
    const seg = segment.trim();
    if (!seg) continue;

    if (perms.commandDeny.some((r) => matchesRule(seg, r))) {
      return { allowed: false, reason: `blocked by deny rule: "${seg}"` };
    }
    if (!perms.commandAllow.some((r) => matchesRule(seg, r))) {
      return { allowed: false, reason: `not in command allowlist: "${seg}"` };
    }
  }

  return { allowed: true };
}

/**
 * Check that a filesystem path is inside one of the allowed directory roots.
 * Returns { allowed: boolean, reason?: string }.
 */
export function checkPath(perms, target) {
  if (!perms || perms.dirRoots === null) return { allowed: true };

  const abs = realResolve(target);
  for (const root of perms.dirRoots) {
    const rel = path.relative(root, abs);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return { allowed: true };
    }
  }
  return {
    allowed: false,
    reason: `path is outside the allowed directories: ${abs}`,
  };
}
