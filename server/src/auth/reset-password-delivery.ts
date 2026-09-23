/**
 * Hosted Better Auth reset-password delivery.
 *
 * Better Auth only invokes `sendResetPassword` for an existing user. This
 * handler must never throw: a throw would 500 known emails and 200 unknown
 * ones, which enumerates accounts.
 *
 * Better Auth's `url` is a kernel hop (`/api/auth/reset-password/:token`).
 * Campaign Studio users cannot open the private kernel, so delivery rewrites
 * that hop onto the already-origin-checked Studio `callbackURL` with the same
 * one-use token. That is the public callback, not a second credentials store.
 *
 * Capture is a controlled-reset channel for tests/operators. It is off unless
 * PAPERCLIP_RESET_PASSWORD_CAPTURE=1 (or NODE_ENV=test). Live mail uses
 * RESEND_API_KEY + PAPERCLIP_RESET_PASSWORD_FROM when both are present.
 * The reset URL/token is never logged.
 */

import { readServerOnlySecret } from "../server-secret-env.js";

export type ResetPasswordDeliveryInput = {
  user: { email?: string | null };
  url: string;
  token?: string;
};

const capturedByEmail = new Map<string, string>();

export function isResetPasswordCaptureEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = env.PAPERCLIP_RESET_PASSWORD_CAPTURE?.trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  return env.NODE_ENV === "test";
}

export function clearCapturedResetPasswords(): void {
  capturedByEmail.clear();
}

export function peekCapturedResetPasswordUrl(email: string): string | null {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return null;
  return capturedByEmail.get(key) ?? null;
}

export function consumeCapturedResetPasswordUrl(email: string): string | null {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return null;
  const url = capturedByEmail.get(key) ?? null;
  capturedByEmail.delete(key);
  return url;
}

/**
 * Public Studio callback for the hosted token. Falls back to Better Auth's
 * kernel URL when no callbackURL is present (kernel-only deployments).
 */
export function studioCallbackResetUrl(input: ResetPasswordDeliveryInput): string {
  const url = String(input?.url || "").trim();
  const token = String(input?.token || "").trim();
  if (!url) return url;
  try {
    const parsed = new URL(url);
    const callback = parsed.searchParams.get("callbackURL");
    if (!callback) return url;
    const dest = new URL(callback);
    if (dest.protocol !== "http:" && dest.protocol !== "https:") return url;
    const resetToken = token || parsed.pathname.split("/").filter(Boolean).pop() || "";
    if (resetToken) dest.searchParams.set("token", resetToken);
    return dest.toString();
  } catch {
    return url;
  }
}

function captureIfEnabled(email: string, url: string): void {
  if (!isResetPasswordCaptureEnabled()) return;
  capturedByEmail.set(email, url);
}

async function sendResendResetEmail(input: {
  email: string;
  url: string;
}): Promise<void> {
  const apiKey = readServerOnlySecret("RESEND_API_KEY");
  const from = process.env.PAPERCLIP_RESET_PASSWORD_FROM?.trim();
  if (!apiKey || !from) return;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.email],
      subject: "Reset your password",
      text: "Open the password-reset link from this message. It is single-use and expires.",
      // Keep the bearer link in HTML/text for the recipient only — not in logs.
      html: `<p><a href="${input.url}">Reset your password</a></p><p>This link is single-use and expires.</p>`,
    }),
  });
  if (!response.ok) {
    throw new Error(`resend_status_${response.status}`);
  }
}

/**
 * Better Auth `emailAndPassword.sendResetPassword` implementation.
 * Never throws. Never logs the URL or token.
 */
export async function deliverResetPassword(
  input: ResetPasswordDeliveryInput,
): Promise<void> {
  const email = String(input?.user?.email || "").trim().toLowerCase();
  const url = studioCallbackResetUrl(input);
  if (!email || !url) return;

  try {
    captureIfEnabled(email, url);
  } catch {
    // capture must not fail the request
  }

  try {
    await sendResendResetEmail({ email, url });
  } catch {
    // Mail failure must not 500 a known account.
  }
}
