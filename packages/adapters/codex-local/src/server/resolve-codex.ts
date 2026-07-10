import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function codexFallbackBinDirs(): string[] {
  return [
    path.join(os.homedir(), "bin"),
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".bun", "bin"),
    path.join(os.homedir(), "workspace", "gbrain", "bin"),
    path.join(os.homedir(), ".codex", "packages", "standalone", "current", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
  ];
}

export function codexPathWithFallbacks(existingPath?: string): string {
  const base = existingPath ?? process.env.PATH ?? "";
  return [codexFallbackBinDirs().join(path.delimiter), base]
    .filter((part) => part.length > 0)
    .join(path.delimiter);
}

export function envWithCodexPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: codexPathWithFallbacks(env.PATH ?? process.env.PATH) };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodexCommand(
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

  for (const dir of [...dirs, ...codexFallbackBinDirs()]) {
    const candidate = path.join(dir, command);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return command;
}
