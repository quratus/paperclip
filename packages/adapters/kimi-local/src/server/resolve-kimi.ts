import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Directories where the Kimi Code CLI binary is commonly installed when the
 * user's interactive shell PATH is not inherited (e.g. launchd, systemd, cron).
 */
export function kimiFallbackBinDirs(): string[] {
  return [
    path.join(os.homedir(), ".kimi-code", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
  ];
}

/**
 * Build a PATH string that prepends the Kimi fallback directories to the
 * given PATH (or process.env.PATH). This makes the `kimi` binary discoverable
 * even when Paperclip is started from a non-interactive context.
 */
export function kimiPathWithFallbacks(existingPath?: string): string {
  const base = existingPath ?? process.env.PATH ?? "";
  return [kimiFallbackBinDirs().join(path.delimiter), base]
    .filter((part) => part.length > 0)
    .join(path.delimiter);
}

/**
 * Return a copy of `env` with the Kimi fallback directories prepended to PATH.
 */
export function envWithKimiPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: kimiPathWithFallbacks(env.PATH ?? process.env.PATH) };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a Kimi command to an absolute path.
 * - If the command already contains a path separator, return it as-is.
 * - Otherwise, search the provided PATH (or process.env.PATH) and then the
 *   fallback directories.
 * - If no executable is found, return the original command so the caller can
 *   surface a clean "not found" error.
 */
export async function resolveKimiCommand(
  command: string,
  envPath?: string,
): Promise<string> {
  if (command.includes(path.sep) || command.includes("/") || command.includes("\\")) {
    return command;
  }

  const searchPath = envPath ?? process.env.PATH ?? "";
  const dirs = searchPath
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);

  for (const dir of [...dirs, ...kimiFallbackBinDirs()]) {
    const candidate = path.join(dir, command);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return command;
}
