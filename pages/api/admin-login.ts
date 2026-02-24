// pages/api/admin-login.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { setCookie } from "@/lib/ui";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const adminPassword = process.env.ADMIN_PASSWORD || "changeme";
  const { password } = req.body ?? {};

  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "Missing password" });
  }

  if (password !== adminPassword) {
    return res.status(401).json({ error: "Invalid password" });
  }

  // 12 hours
  setCookie(res, "cacc_admin", "1", { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 12 });

  return res.status(200).json({ ok: true });
}
