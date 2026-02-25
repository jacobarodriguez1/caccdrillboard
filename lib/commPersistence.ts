/**
 * Persist pad chat channels/messages to data/comm_state.json.
 * Load on server start. Debounce saves (max once per second).
 * Does NOT persist online/offline presence.
 */

import fs from "fs";
import path from "path";

export type PersistedChatMessage = {
  id: string;
  ts: number;
  from: "ADMIN" | "JUDGE";
  text: string;
  urgent?: boolean;
  ackedAt?: number;
};

export type PersistedCommState = {
  channels: Record<string, PersistedChatMessage[]>;
};

const COMM_STATE_FILENAME = "comm_state.json";
const DEBOUNCE_MS = 1000;

function getCommStatePath(): string {
  const envPath = process.env.COMM_STATE_PATH?.trim();
  if (envPath) return path.isAbsolute(envPath) ? envPath : path.join(process.cwd(), envPath);
  return path.join(process.cwd(), "data", COMM_STATE_FILENAME);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveScheduled = false;

/**
 * Load persisted comm state. Returns Record<padId, messages>.
 * Keys in file are strings (JSON); we convert to number.
 */
export function loadCommState(): Record<number, PersistedChatMessage[]> {
  const filePath = getCommStatePath();
  if (!fs.existsSync(filePath)) return {};

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  const channels = obj.channels;
  if (!channels || typeof channels !== "object") return {};

  const result: Record<number, PersistedChatMessage[]> = {};
  for (const [k, v] of Object.entries(channels)) {
    const padId = Math.floor(Number(k));
    if (!Number.isFinite(padId) || padId < 1) continue;
    if (!Array.isArray(v)) continue;
    const msgs = v
      .filter((m): m is PersistedChatMessage => m && typeof m === "object" && typeof (m as any).id === "string" && typeof (m as any).ts === "number" && typeof (m as any).text === "string")
      .map((m) => ({
        id: String(m.id),
        ts: Number(m.ts),
        from: m.from === "JUDGE" ? "JUDGE" : "ADMIN",
        text: String(m.text ?? ""),
        urgent: Boolean(m.urgent),
        ackedAt: m.ackedAt != null ? Number(m.ackedAt) : undefined,
      }));
    result[padId] = msgs;
  }
  return result;
}

/**
 * Schedule a debounced save. Writes at most once per DEBOUNCE_MS.
 */
export function scheduleCommSave(getChannels: () => Record<number, PersistedChatMessage[]>) {
  if (saveScheduled) return;
  saveScheduled = true;

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveScheduled = false;
    saveTimer = null;
    try {
      const channels = getChannels();
      const dir = path.dirname(getCommStatePath());
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const toWrite: PersistedCommState = {
        channels: Object.fromEntries(
          Object.entries(channels).map(([k, v]) => [String(k), v])
        ),
      };
      fs.writeFileSync(getCommStatePath(), JSON.stringify(toWrite, null, 2), "utf8");
    } catch (e) {
      console.error("[comm] Persist error:", e);
    }
  }, DEBOUNCE_MS);
}
