// pages/api/reload-roster.ts
import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";
import { createInitialState } from "@/lib/state";
import { buildStateFromRosterCsv } from "@/lib/roster";

const ROSTER_FILENAME = "drillTeamsRoster_2026.csv";

function getRosterPath() {
  return path.join(process.cwd(), "data", ROSTER_FILENAME);
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const rosterPath = getRosterPath();
    let nextState = createInitialState();

    if (fs.existsSync(rosterPath)) {
      const built = buildStateFromRosterCsv(rosterPath);
      if (built) nextState = built;
    }

    (global as any).boardState = nextState;
    (global as any).padHistory = {};
    (global as any).audit = (global as any).audit ?? [];
    (global as any).globalPaused = false;

    // reset report timers for NOW per pad
    const reportTimers = ((global as any).reportTimers as any) ?? {};
    for (let padId = 1; padId <= 8; padId++) {
      reportTimers[padId] = {
        byTeamId: nextState.pads[padId - 1]?.now?.id ?? null,
        startedAt: Date.now(),
        windowMs: 5 * 60 * 1000,
        paused: false,
        pauseAccumMs: 0,
      };
    }
    (global as any).reportTimers = reportTimers;

    // If socket server exists, broadcast immediately
    const io = (global as any).io;
    if (io) {
      io.emit("state", nextState);
      io.emit("reportTimers", reportTimers);
      io.emit("globalPaused", false);
      io.emit("audit", (global as any).audit);
    }

    res.status(200).json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? "Unknown error" });
  }
}
