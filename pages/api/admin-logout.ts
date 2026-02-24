// pages/api/admin-logout.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { clearCookie } from "@/lib/ui";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  clearCookie(res, "cacc_admin");
  return res.status(200).json({ ok: true });
}
