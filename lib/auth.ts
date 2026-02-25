// lib/auth.ts
import crypto from "crypto";
import type { GetServerSidePropsContext, GetServerSidePropsResult } from "next";
import { parseCookie } from "@/lib/ui";

export type SocketRole = "admin" | "judge" | "public";

const ROLE_COOKIE_MAX_AGE_SEC = 43200; // 12 hours

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET must be set (min 16 chars) in production");
    }
    return "dev-secret-change-me";
  }
  return secret;
}

/** Create HMAC-signed role payload. Format: base64url(payload).base64url(signature) */
function signRolePayload(role: SocketRole): string {
  const exp = Math.floor(Date.now() / 1000) + ROLE_COOKIE_MAX_AGE_SEC;
  const payload = JSON.stringify({ r: role, exp });
  const secret = getSessionSecret();
  const sig = crypto.createHmac("sha256", secret).update(payload).digest();
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const sigB64 = sig.toString("base64url");
  return `${payloadB64}.${sigB64}`;
}

/** Verify signed role cookie. Returns role or null if invalid/expired. */
export function verifyRoleCookie(signedValue: string): SocketRole | null {
  if (!signedValue || typeof signedValue !== "string") return null;
  const parts = signedValue.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, sigB64] = parts;
  let payloadStr: string;
  try {
    payloadStr = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const secret = getSessionSecret();
  const expectedSig = crypto.createHmac("sha256", secret).update(payloadStr).digest().toString("base64url");
  if (sigB64 !== expectedSig) return null;

  let payload: { r?: string; exp?: number };
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return null;
  }

  const role = payload?.r;
  if (role !== "admin" && role !== "judge" && role !== "public") return null;
  if (typeof payload?.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;

  return role;
}

/** Set signed cacc_role cookie for Socket.IO handshake. Tamper-proof via HMAC. */
export function setRoleCookie(
  res: GetServerSidePropsContext["res"],
  role: SocketRole
) {
  const signed = signRolePayload(role);
  const parts = [
    `cacc_role=${encodeURIComponent(signed)}`,
    "Path=/",
    `Max-Age=${ROLE_COOKIE_MAX_AGE_SEC}`,
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function requireAdmin(ctx: GetServerSidePropsContext) {
  const cookie = parseCookie(ctx.req.headers.cookie);
  const authed = cookie["cacc_admin"] === "1";

  if (!authed) {
    return {
      redirect: {
        destination: "/login",
        permanent: false,
      },
    } as const;
  }

  return { props: {} } as const;
}

/** requireAdmin + set signed cacc_role for Socket.IO. Use for admin/judge pages. */
export function requireAdminRole(
  ctx: GetServerSidePropsContext,
  role: "admin" | "judge"
): GetServerSidePropsResult<Record<string, never>> {
  const result = requireAdmin(ctx);
  if ("redirect" in result) return result;
  // Only set signed cookie; never trust raw cacc_role from request
  setRoleCookie(ctx.res, role);
  return result;
}
