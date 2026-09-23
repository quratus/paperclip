import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCapturedResetPasswords,
  consumeCapturedResetPasswordUrl,
  deliverResetPassword,
  isResetPasswordCaptureEnabled,
  peekCapturedResetPasswordUrl,
  studioCallbackResetUrl,
} from "../auth/reset-password-delivery.js";
import { __resetServerOnlySecretCaptureForTests } from "../server-secret-env.js";

const ORIGINAL_CAPTURE = process.env.PAPERCLIP_RESET_PASSWORD_CAPTURE;
const ORIGINAL_FROM = process.env.PAPERCLIP_RESET_PASSWORD_FROM;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_RESEND = process.env.RESEND_API_KEY;

afterEach(() => {
  clearCapturedResetPasswords();
  __resetServerOnlySecretCaptureForTests();
  if (ORIGINAL_CAPTURE === undefined) delete process.env.PAPERCLIP_RESET_PASSWORD_CAPTURE;
  else process.env.PAPERCLIP_RESET_PASSWORD_CAPTURE = ORIGINAL_CAPTURE;
  if (ORIGINAL_FROM === undefined) delete process.env.PAPERCLIP_RESET_PASSWORD_FROM;
  else process.env.PAPERCLIP_RESET_PASSWORD_FROM = ORIGINAL_FROM;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_RESEND === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_RESEND;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reset password delivery", () => {
  it("captures the reset URL only when capture is enabled", async () => {
    process.env.NODE_ENV = "production";
    process.env.PAPERCLIP_RESET_PASSWORD_CAPTURE = "1";

    await deliverResetPassword({
      user: { email: "member@example.test" },
      url: "https://campaign-studio.sqncr.ai/passwort-zuruecksetzen?token=secret-token",
    });

    expect(peekCapturedResetPasswordUrl("member@example.test")).toContain(
      "token=secret-token",
    );
    expect(consumeCapturedResetPasswordUrl("MEMBER@example.test")).toContain(
      "campaign-studio.sqncr.ai/passwort-zuruecksetzen",
    );
    expect(peekCapturedResetPasswordUrl("member@example.test")).toBeNull();
  });

  it("does not capture in production when capture is off", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.PAPERCLIP_RESET_PASSWORD_CAPTURE;

    await deliverResetPassword({
      user: { email: "member@example.test" },
      url: "https://campaign-studio.sqncr.ai/passwort-zuruecksetzen?token=secret-token",
    });

    expect(peekCapturedResetPasswordUrl("member@example.test")).toBeNull();
  });

  it("never throws when Resend fails, so known emails cannot be enumerated", async () => {
    process.env.NODE_ENV = "test";
    process.env.PAPERCLIP_RESET_PASSWORD_FROM = "Auth <auth@example.test>";
    process.env.RESEND_API_KEY = "re_test_key";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));

    await expect(deliverResetPassword({
      user: { email: "member@example.test" },
      url: "https://campaign-studio.sqncr.ai/passwort-zuruecksetzen?token=secret-token",
    })).resolves.toBeUndefined();
  });

  it("treats capture flag 1 as enabled even outside test", () => {
    expect(isResetPasswordCaptureEnabled({
      PAPERCLIP_RESET_PASSWORD_CAPTURE: "1",
      NODE_ENV: "production",
    })).toBe(true);
    expect(isResetPasswordCaptureEnabled({
      NODE_ENV: "production",
    })).toBe(false);
  });

  it("rewrites the private kernel hop onto the Studio callback with the same token", () => {
    const studio = studioCallbackResetUrl({
      user: { email: "member@example.test" },
      url: "https://vps3.tailf7e361.ts.net/api/auth/reset-password/secret-token?callbackURL=https%3A%2F%2Fcampaign-studio.sqncr.ai%2Fpasswort-zuruecksetzen",
      token: "secret-token",
    });
    expect(studio).toBe(
      "https://campaign-studio.sqncr.ai/passwort-zuruecksetzen?token=secret-token",
    );
  });

  it("posts live Resend mail to the Studio callback and never throws when From is missing", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.PAPERCLIP_RESET_PASSWORD_CAPTURE;
    process.env.PAPERCLIP_RESET_PASSWORD_FROM = "Auth <auth@example.test>";
    process.env.RESEND_API_KEY = "re_test_key";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverResetPassword({
      user: { email: "member@example.test" },
      url: "https://vps3.tailf7e361.ts.net/api/auth/reset-password/secret-token?callbackURL=https%3A%2F%2Fcampaign-studio.sqncr.ai%2Fpasswort-zuruecksetzen",
      token: "secret-token",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.to).toEqual(["member@example.test"]);
    expect(body.html).toContain("https://campaign-studio.sqncr.ai/passwort-zuruecksetzen?token=secret-token");
    expect(body.html).not.toContain("vps3.tailf7e361.ts.net");

    delete process.env.PAPERCLIP_RESET_PASSWORD_FROM;
    fetchMock.mockClear();
    await expect(deliverResetPassword({
      user: { email: "member@example.test" },
      url: "https://campaign-studio.sqncr.ai/passwort-zuruecksetzen?token=secret-token",
    })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
