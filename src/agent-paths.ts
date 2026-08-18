/**
 * agent-paths.ts — where pgr looks for per-agent files.
 *
 * Two conventions, both overridable by environment variable so an existing
 * deployment with its own layout doesn't have to adopt pgr's:
 *
 *   PGR_AGENT_ROOT         directory holding one subdirectory per agent
 *                          (default: ~/agents)
 *   PGR_AGENT_CONFIG_FILE  per-agent config filename inside that subdirectory
 *                          (default: .pgr-agent.json)
 *
 * Both are read live from process.env on every call, never cached at module
 * load, so a caller (or a test) can change them per invocation.
 */

import { homedir } from "os";
import { join } from "path";

/** Root directory containing one subdirectory per agent. */
export function agentRoot(): string {
  return process.env["PGR_AGENT_ROOT"] || join(homedir(), "agents");
}

/** Filename of the per-agent config file, inside that agent's directory. */
export function agentConfigFileName(): string {
  return process.env["PGR_AGENT_CONFIG_FILE"] || ".pgr-agent.json";
}

/**
 * Full path to a given agent's config file. A missing file is not an error
 * here — the allowlist reader treats it as default-deny.
 */
export function agentConfigPath(agentName: string): string {
  return join(agentRoot(), agentName, agentConfigFileName());
}

/**
 * Render a path for display, replacing a leading home directory with `~`.
 * Cosmetic only — never use the result to open a file.
 */
export function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + "/")
    ? "~" + path.slice(home.length)
    : path;
}
