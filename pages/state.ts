// pages/api/state.ts
import type { NextApiRequest, NextApiResponse } from "next";

declare global {
  // eslint-disable-next-line no-var
  var boardState: any | undefined;
}

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(global.boardState ?? null);
}
