export type PlateauReason = "no_state_change" | "repeating_error";

export interface PlateauDetectorInput {
  iterationSignatures: string[];
  maxPlateauIterations: number;
}

export interface PlateauDetectorResult {
  isStuck: boolean;
  reason: PlateauReason | null;
}

export type VerifierMethod = "test_pass_fail" | "second_model" | "human_legible_diff";

export interface TestPassFailCommandInput {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface TestPassFailOutcomeInput {
  exitCode: number | null;
  evidence?: string;
}

export type TestPassFailInput = TestPassFailCommandInput | TestPassFailOutcomeInput;

export interface VerifierResult {
  verified: boolean;
  method: VerifierMethod;
  evidence: string;
}

function isErrorSignature(signature: string): boolean {
  return /^(error|exception|failed):/i.test(signature.trim());
}

export function plateauDetector(input: PlateauDetectorInput): PlateauDetectorResult {
  const { iterationSignatures, maxPlateauIterations } = input;
  if (maxPlateauIterations < 1 || iterationSignatures.length < maxPlateauIterations) {
    return { isStuck: false, reason: null };
  }

  const window = iterationSignatures.slice(-maxPlateauIterations);
  const [first] = window;
  if (first == null || window.some((signature) => signature !== first)) {
    return { isStuck: false, reason: null };
  }

  return {
    isStuck: true,
    reason: isErrorSignature(first) ? "repeating_error" : "no_state_change",
  };
}

export async function runVerifier(
  method: VerifierMethod,
  input: TestPassFailInput,
): Promise<VerifierResult> {
  if (method !== "test_pass_fail") {
    throw new Error(`${method} verifier is not implemented`);
  }

  if ("exitCode" in input) {
    return {
      verified: input.exitCode === 0,
      method,
      evidence: input.evidence ?? `exit code ${input.exitCode}`,
    };
  }

  const { spawn } = await import("node:child_process");
  return await new Promise<VerifierResult>((resolve) => {
    const child = spawn(input.command, input.args ?? [], {
      cwd: input.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    const timeout = setTimeout(() => {
      chunks.push(`timed out after ${input.timeoutMs}ms`);
      child.kill("SIGTERM");
    }, input.timeoutMs ?? 30_000);

    child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ verified: false, method, evidence: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        verified: code === 0,
        method,
        evidence: chunks.join("").trim(),
      });
    });
  });
}
