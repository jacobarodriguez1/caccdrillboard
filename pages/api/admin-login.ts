// pages/api/admin-login.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { setCookie } from "@/lib/ui";
import { checkLoginRateLimit, recordFailedAttempt } from "@/lib/rateLimit";

function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0]?.trim() ?? "unknown";
  return req.socket?.remoteAddress ?? "unknown";
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = getClientIp(req);
  if (!checkLoginRateLimit(ip)) {
    return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (process.env.NODE_ENV === "production" && (!adminPassword || adminPassword.length < 8)) {
    return res.status(500).json({ error: "Server misconfigured: ADMIN_PASSWORD required in production (min 8 chars)" });
  }
  const passwordToCheck = adminPassword ?? "changeme";

  const { password } = req.body ?? {};

  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "Missing password" });
  }

  if (password !== passwordToCheck) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: "Invalid password" });
  }

  // 12 hours
  setCookie(res, "cacc_admin", "1", { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 12 });

  return res.status(200).json({ ok: true });
}
