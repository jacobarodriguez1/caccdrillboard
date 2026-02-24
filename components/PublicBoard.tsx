// components/PublicBoard.tsx
import { useEffect, useMemo, useRef, useState } from "react";

import type { BoardState, Pad, Team, ScheduleEvent } from "@/lib/state";
import { getSocket } from "@/lib/socketClient";
import { fmtTime, mmssFromSeconds, chipStyle } from "@/lib/ui";

/** ---------- Color tokens (explicit) ---------- */
const COLOR_ORANGE = "rgba(255,152,0,0.95)"; // BREAK
const COLOR_YELLOW = "rgba(255,235,59,0.95)"; // REPORT NOW
const COLOR_RED = "var(--danger)"; // LATE
const COLOR_BLUE = "var(--info)"; // ON PAD

/** lane defaults */
const ACCENT_ONDECK = "rgba(255,255,255,0.22)";
const ACCENT_STANDBY = "rgba(255,255,255,0.12)";

/** ---------- Helpers ---------- */
function areaName(p: Pad): string {
  const n = String((p as any).name ?? "").trim();
  return n.length ? n : `AREA ${p.id}`;
}

function areaLabel(p: Pad): string {
  const l = String((p as any).label ?? "").trim();
  return l.length ? l : "";
}

function tagBadge(tag?: string) {
  if (!tag) return null;
  return (
    <span
      style={{
        marginLeft: 8,
        padding: "2px 8px",
        borderRadius: 999,
        border: "1px solid rgba(255,255,255,0.25)",
        fontSize: 11,
        fontWeight: 900,
        letterSpacing: 0.6,
        opacity: 0.9,
        whiteSpace: "nowrap",
        background: "rgba(0,0,0,0.25)",
      }}
    >
      {tag}
    </span>
  );
}

function teamInline(t?: Team | null) {
  if (!t) return <span style={{ opacity: 0.6 }}>—</span>;
  const meta = [t.division, t.category].filter(Boolean).join(" • ");
  const tag = (t as any).tag as string | undefined;

  return (
    <span>
      <span style={{ fontWeight: 1000 }}>{t.name}</span>
      {meta ? <span style={{ opacity: 0.72 }}>{" "}({meta})</span> : null}
      {tag ? tagBadge(tag) : null}
    </span>
  );
}

function isArrivedForNow(p: Pad): boolean {
  const nowId = p.now?.id ?? null;
  return !!p.nowArrivedAt && !!p.nowArrivedTeamId && !!nowId && p.nowArrivedTeamId === nowId;
}

type Banner =
  | null
  | { kind: "GLOBAL_BREAK_ACTIVE"; title: string; rightText: string; sub?: string }
  | { kind: "GLOBAL_BREAK_SCHEDULED"; title: string; rightText: string; sub?: string }
  | { kind: "GLOBAL_MSG"; title: string; rightText?: string; sub?: string }
  | { kind: "PAD_MSG"; title: string; rightText?: string; sub?: string }
  | { kind: "BREAK_ACTIVE"; title: string; rightText: string; sub?: string }
  | { kind: "ONPAD"; title: string; rightText: string; sub?: string }
  | { kind: "REPORT"; title: string; rightText: string; sub?: string; late?: boolean };

type NonNullBanner = Exclude<Banner, null>;

function statusColors(status: string) {
  switch (status) {
    case "GLOBAL BREAK":
    case "BREAK":
      return { bg: COLOR_ORANGE, fg: "#111" };
    case "REPORTING":
      return { bg: COLOR_YELLOW, fg: "#111" };
    case "LATE":
      return { bg: COLOR_RED, fg: "white" };
    case "ON PAD":
      return { bg: COLOR_BLUE, fg: "#111" };
    case "NOW":
      return { bg: "var(--cacc-gold)", fg: "#111" };
    default:
      return { bg: "rgba(255,255,255,0.12)", fg: "white" };
  }
}

function bannerStyle(b: Banner) {
  if (!b) return null;

  if (b.kind === "GLOBAL_BREAK_ACTIVE" || b.kind === "BREAK_ACTIVE") {
    return { border: `2px solid ${COLOR_ORANGE}`, background: "rgba(255,152,0,0.12)" };
  }
  if (b.kind === "GLOBAL_BREAK_SCHEDULED") {
    return { border: "2px solid rgba(255,255,255,0.22)", background: "rgba(255,255,255,0.08)" };
  }
  if (b.kind === "GLOBAL_MSG" || b.kind === "PAD_MSG") {
    return { border: "2px solid rgba(255,255,255,0.20)", background: "rgba(0,0,0,0.22)" };
  }
  if (b.kind === "ONPAD") {
    return { border: "2px solid rgba(144,202,249,0.85)", background: "rgba(144,202,249,0.12)" };
  }
  if (b.kind === "REPORT") {
    if (b.late) return { border: `2px solid ${COLOR_RED}`, background: "rgba(198,40,40,0.16)" };
    return { border: `2px solid ${COLOR_YELLOW}`, background: "rgba(255,235,59,0.14)" };
  }
  return null;
}

/** ---------- schedule helpers ---------- */
function sortSchedule(list: ScheduleEvent[]) {
  return list.slice().sort((a, b) => a.startAt - b.startAt);
}
function nowBlock(schedule: ScheduleEvent[], nowMs: number) {
  return schedule.find((e) => nowMs >= e.startAt && nowMs < e.endAt) ?? null;
}
function nextBlock(schedule: ScheduleEvent[], nowMs: number) {
  return schedule.filter((e) => e.startAt > nowMs).sort((a, b) => a.startAt - b.startAt)[0] ?? null;
}
function nextRelevantEventForPad(schedule: ScheduleEvent[], padId: number, nowMs: number) {
  const relevant = schedule.filter((e) => {
    if (e.startAt <= nowMs) return false;
    if (e.scope === "GLOBAL") return true;
    if (e.scope === "PAD" && e.padIds?.includes(padId)) return true;
    return false;
  });
  return relevant.sort((a, b) => a.startAt - b.startAt)[0] ?? null;
}
function nextBreakLike(schedule: ScheduleEvent[], nowMs: number) {
  const breakLike = schedule.filter((e) => e.startAt > nowMs && (e.type === "BREAK" || e.type === "LUNCH"));
  return breakLike.sort((a, b) => a.startAt - b.startAt)[0] ?? null;
}

/** ---------- per-pad banners ---------- */
function getPadBanner(p: Pad, nowMs: number, globalBreakActive: boolean): Banner {
  if (globalBreakActive) return null;

  if (p.message && (!p.messageUntilAt || nowMs < p.messageUntilAt)) {
    return {
      kind: "PAD_MSG",
      title: p.message,
      rightText: p.messageUntilAt ? mmssFromSeconds((p.messageUntilAt - nowMs) / 1000) : undefined,
      sub: p.messageUntilAt ? `Ends at ${fmtTime(p.messageUntilAt)}` : undefined,
    };
  }

  if (p.breakUntilAt && p.breakUntilAt > nowMs) {
    return {
      kind: "BREAK_ACTIVE",
      title: `BREAK: ${(p.breakReason ?? "Break").trim()}`,
      rightText: mmssFromSeconds((p.breakUntilAt - nowMs) / 1000),
      sub: `Resumes at ${fmtTime(p.breakUntilAt)}`,
    };
  }

  if (isArrivedForNow(p) && p.nowArrivedAt) {
    return {
      kind: "ONPAD",
      title: `ON PAD: ${p.now?.name ?? "—"}`,
      rightText: mmssFromSeconds((nowMs - p.nowArrivedAt) / 1000),
      sub: `Arrived at ${fmtTime(p.nowArrivedAt)}`,
    };
  }

  const validReport =
    !!p.reportByDeadlineAt &&
    !!p.reportByTeamId &&
    !!p.now?.id &&
    p.now.id === p.reportByTeamId &&
    !(p.breakUntilAt && p.breakUntilAt > nowMs);

  if (validReport && p.reportByDeadlineAt) {
    const diffSec = (p.reportByDeadlineAt - nowMs) / 1000;
    if (diffSec >= 0) {
      return {
        kind: "REPORT",
        title: `REPORT NOW: ${p.now?.name ?? "—"}`,
        rightText: mmssFromSeconds(diffSec),
        sub: p.lastCompleteAt ? `Started at ${fmtTime(p.lastCompleteAt)}` : undefined,
      };
    }
    return {
      kind: "REPORT",
      title: `LATE — REPORT NOW: ${p.now?.name ?? "—"}`,
      rightText: mmssFromSeconds(-diffSec),
      sub: p.lastCompleteAt ? `Started at ${fmtTime(p.lastCompleteAt)}` : undefined,
      late: true,
    };
  }

  return null;
}

function deriveStatus(p: Pad, banner: Banner | null, nowMs: number, globalBreakActive: boolean) {
  if (globalBreakActive) return "GLOBAL BREAK";
  if (p.breakUntilAt && p.breakUntilAt > nowMs) return "BREAK";
  if (banner?.kind === "REPORT") return banner.late ? "LATE" : "REPORTING";
  if (banner?.kind === "ONPAD") return "ON PAD";
  if (p.now) return "NOW";
  return "IDLE";
}

/** beep on late in kiosk mode */
function beep() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.05;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => {
      o.stop();
      ctx.close?.();
    }, 120);
  } catch {}
}

/** ---------- Lane UI ---------- */
const laneLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 1000,
  letterSpacing: 1.2,
  opacity: 0.68,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

function laneBox(accent: string, bg: string): React.CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: "8px 1fr",
    borderRadius: 14,
    overflow: "hidden",
    background: bg,
    border: "1px solid rgba(255,255,255,0.10)",
  };
}

function laneAccent(accent: string): React.CSSProperties {
  return { background: accent };
}

const laneContent: React.CSSProperties = {
  padding: "10px 12px",
};

function laneChip(label: string, bg: string, fg: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    height: 22,
    padding: "0 10px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 1000,
    letterSpacing: 1.1,
    background: bg,
    color: fg,
    border: "1px solid rgba(255,255,255,0.10)",
    textTransform: "uppercase",
  };
}

/** NEW: NOW lane should match pad status color */
function nowAccentForStatus(status: string) {
  switch (status) {
    case "BREAK":
    case "GLOBAL BREAK":
      return COLOR_ORANGE;
    case "REPORTING":
      return COLOR_YELLOW;
    case "LATE":
      return COLOR_RED;
    case "ON PAD":
      return COLOR_BLUE;
    default:
      return "var(--cacc-gold)";
  }
}

function nowChipForStatus(status: string): React.CSSProperties {
  if (status === "REPORTING") return laneChip("NOW", COLOR_YELLOW, "#111");
  if (status === "BREAK" || status === "GLOBAL BREAK") return laneChip("NOW", COLOR_ORANGE, "#111");
  if (status === "ON PAD") return laneChip("NOW", COLOR_BLUE, "#111");
  if (status === "LATE") return laneChip("NOW", COLOR_RED, "white");
  return laneChip("NOW", "rgba(245, 197, 24, 0.95)", "#111"); // default gold
}

export default function PublicBoard({ kiosk = false }: { kiosk?: boolean }) {
  const [state, setState] = useState<BoardState | null>(null);
  const [search, setSearch] = useState("");
  const [big, setBig] = useState(true);
  const [, tick] = useState(0);

  const lastBeepByPad = useRef<Record<number, number>>({});
  const prevLateByPad = useRef<Record<number, boolean>>({});

  useEffect(() => {
    fetch("/api/socket");

    const socket = getSocket();
    if (socket) socket.on("state", (s: BoardState) => setState(s));

    const interval = setInterval(() => tick((t) => t + 1), 1000);

    const resync = setInterval(async () => {
      try {
        const r = await fetch("/api/state");
        if (r.ok) setState(await r.json());
      } catch {}
    }, 60000);

    return () => {
      if (socket) socket.off("state");
      clearInterval(interval);
      clearInterval(resync);
    };
  }, []);

  const pads = useMemo(() => state?.pads ?? [], [state]);
  const nowMs = Date.now();

  const schedule = useMemo(() => sortSchedule(state?.schedule ?? []), [state?.schedule]);
  const globalSchedule = useMemo(() => schedule.filter((e) => e.scope === "GLOBAL"), [schedule]);
  const nowSched = useMemo(() => nowBlock(globalSchedule, nowMs), [globalSchedule, nowMs]);
  const nextSched = useMemo(() => nextBlock(globalSchedule, nowMs), [globalSchedule, nowMs]);

  // keep available for collision warnings / future UI
  const nextBreakLunch = useMemo(() => nextBreakLike(globalSchedule, nowMs), [globalSchedule, nowMs]);

  const gbStart = state?.globalBreakStartAt ?? null;
  const gbUntil = state?.globalBreakUntilAt ?? null;
  const gbReason = (state?.globalBreakReason ?? "Break").trim();

  const globalBreakActive = (!gbStart || nowMs >= gbStart) && !!gbUntil && nowMs < gbUntil;
  const globalBreakScheduled = !!gbStart && gbStart > nowMs;

  const globalMessageActive =
    !!state?.globalMessage && (!state?.globalMessageUntilAt || state.globalMessageUntilAt > nowMs);

  const globalBanners: NonNullBanner[] = useMemo(() => {
    const banners: NonNullBanner[] = [];

    if (globalBreakScheduled && gbStart) {
      banners.push({
        kind: "GLOBAL_BREAK_SCHEDULED",
        title: `GLOBAL BREAK SCHEDULED: ${gbReason}`,
        rightText: mmssFromSeconds((gbStart - nowMs) / 1000),
        sub: `Starts at ${fmtTime(gbStart)} • Ends at ${gbUntil ? fmtTime(gbUntil) : "—"}`,
      });
    } else if (globalBreakActive && gbUntil) {
      banners.push({
        kind: "GLOBAL_BREAK_ACTIVE",
        title: `GLOBAL BREAK: ${gbReason}`,
        rightText: mmssFromSeconds((gbUntil - nowMs) / 1000),
        sub: `Resumes at ${fmtTime(gbUntil)}`,
      });
    }

    if (globalMessageActive && state?.globalMessage) {
      banners.push({
        kind: "GLOBAL_MSG",
        title: state.globalMessage,
        rightText: state.globalMessageUntilAt
          ? mmssFromSeconds((state.globalMessageUntilAt - nowMs) / 1000)
          : undefined,
        sub: state.globalMessageUntilAt ? `Ends at ${fmtTime(state.globalMessageUntilAt)}` : undefined,
      });
    }

    return banners;
  }, [
    globalBreakScheduled,
    globalBreakActive,
    globalMessageActive,
    gbStart,
    gbUntil,
    gbReason,
    nowMs,
    state?.globalMessage,
    state?.globalMessageUntilAt,
  ]);

  const filteredPads: Pad[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pads;

    const match = (t?: Team | null) =>
      !!t && `${t.id} ${t.name} ${t.unit ?? ""} ${t.category ?? ""} ${t.division ?? ""}`.toLowerCase().includes(q);

    return pads.filter((p) => match(p.now) || match(p.onDeck) || p.standby.some((t) => match(t)));
  }, [pads, search]);

  useEffect(() => {
    if (!kiosk) return;
    if (globalBreakActive) return;

    for (const p of pads) {
      const b = getPadBanner(p, nowMs, globalBreakActive);
      const isLate = b?.kind === "REPORT" && !!b.late;
      const wasLate = !!prevLateByPad.current[p.id];

      if (!wasLate && isLate) {
        const last = lastBeepByPad.current[p.id] ?? 0;
        if (nowMs - last > 30_000) {
          lastBeepByPad.current[p.id] = nowMs;
          beep();
        }
      }
      prevLateByPad.current[p.id] = isLate;
    }
  }, [pads, nowMs, kiosk, globalBreakActive]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--cacc-navy)", color: "white", padding: big ? 18 : 22, fontFamily: "system-ui" }}>
      <style>{`
        @keyframes lateFlash { 0%{opacity:1} 50%{opacity:.55} 100%{opacity:1} }
      `}</style>

     {/* Header (Admin-style) */}
<div
  style={{
    display: "flex",
    gap: 16,
    alignItems: "center",
    flexWrap: "wrap",
    padding: "16px 18px",
    borderRadius: 18,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
  }}
>
  <img
    src="/cacc-shield.png"
    alt="California Cadet Corps"
    style={{
      width: 132,
      height: 132,
      objectFit: "contain",
      borderRadius: 14,
      background: "rgba(0,0,0,0.25)",
      border: "1px solid rgba(255,255,255,0.14)",
      padding: 10,
    }}
  />

  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    <div
      style={{
        fontSize: 22,
        fontWeight: 900,
        letterSpacing: 1.2,
        opacity: 0.92,
        lineHeight: 1.1,
      }}
    >
      CALIFORNIA CADET CORPS
    </div>

    <div style={{ fontWeight: 1000, fontSize: 40, letterSpacing: -0.3, lineHeight: 1.05 }}>
      {(state as any)?.eventHeaderLabel?.trim() || "COMPETITION MATRIX"} — PUBLIC BOARD
    </div>

    <div style={{ fontSize: 12, opacity: 0.8 }}>
      {state?.updatedAt ? `Last update: ${fmtTime(state.updatedAt)}` : "Connecting…"}
    </div>
  </div>

  <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
    <input
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      placeholder="Search team name / id..."
      style={{
        padding: "10px 12px",
        width: 320,
        maxWidth: "82vw",
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.18)",
        background: "rgba(0,0,0,0.25)",
        color: "white",
        outline: "none",
      }}
    />

    {!kiosk && (
      <button
        onClick={() => setBig((v) => !v)}
        style={{
          padding: "10px 12px",
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.18)",
          background: big ? "var(--cacc-gold)" : "rgba(0,0,0,0.25)",
          color: big ? "#111" : "white",
          fontWeight: 900,
          cursor: "pointer",
        }}
      >
        {big ? "Normal" : "Big-screen"}
      </button>
    )}
  </div>
</div>

{/* Schedule NOW/NEXT */}
<div
  style={{
    marginTop: 12,
    borderRadius: 16,
    padding: 12,
    background: "rgba(0,0,0,0.22)",
    border: "1px solid rgba(255,255,255,0.10)",
  }}
>
  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
    <span style={chipStyle("rgba(255,255,255,0.16)", "white")}>SCHEDULE</span>

    <div style={{ fontWeight: 950 }}>
      NOW:{" "}
      {nowSched
        ? `${nowSched.title} (${fmtTime(nowSched.startAt)}–${fmtTime(nowSched.endAt)})`
        : "—"}
    </div>

    <div style={{ opacity: 0.85 }}>
      NEXT:{" "}
      {nextSched
        ? `${nextSched.title} (${fmtTime(nextSched.startAt)}–${fmtTime(nextSched.endAt)})`
        : "—"}
    </div>
  </div>
</div>

      {/* Global banners (stacked) */}
      {globalBanners.length > 0 ? (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          {globalBanners.map((b, idx) => (
            <div key={`${b.kind}-${idx}`} style={{ borderRadius: 16, padding: "12px 14px", ...(bannerStyle(b) ?? {}) }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 950, fontSize: big ? 16 : 18 }}>
                  {b.kind.includes("BREAK") ? "🟠 " : "📢 "}
                  {b.title}
                </div>

                {b.rightText ? (
                  <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: 900 }}>
                    {b.rightText}
                  </div>
                ) : null}
              </div>

              {b.sub ? <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>{b.sub}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* Grid */}
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: big ? "repeat(4, minmax(0, 1fr))" : "repeat(auto-fit, minmax(340px, 1fr))", gap: 14 }}>
        {filteredPads.map((p) => {
          const banner = getPadBanner(p, nowMs, globalBreakActive);
          const status = deriveStatus(p, banner, nowMs, globalBreakActive);
          const { bg, fg } = statusColors(status);

          const nowAccent = nowAccentForStatus(status);

          const lateFlash =
            banner?.kind === "REPORT" && banner.late ? { animation: "lateFlash 1.0s ease-in-out infinite" as const } : null;

          const nextEv = nextRelevantEventForPad(schedule, p.id, nowMs);
          const nextEvText = nextEv ? `${nextEv.title} in ${mmssFromSeconds((nextEv.startAt - nowMs) / 1000)}` : "—";

          // keep computed for future use
          void nextBreakLunch;

          return (
            <div
              key={p.id}
              style={{
                borderRadius: 18,
                overflow: "hidden",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                boxShadow: "0 10px 30px rgba(0,0,0,0.22)",
                minHeight: big ? 320 : 360,
              }}
            >
              <div style={{ height: 6, background: bg }} />
              <div style={{ padding: big ? 14 : 16 }}>
                
                {/* header */}
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: big ? 18 : 20, fontWeight: 1000 }}>{areaName(p)}</div>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>{areaLabel(p)}</div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                    <span style={chipStyle(bg, fg)}>{status}</span>
                    <div style={{ fontSize: 11, opacity: 0.75 }}>Updated: {p.updatedAt ? fmtTime(p.updatedAt) : "—"}</div>
                  </div>
                </div>

                {/* next scheduled line */}
                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9 }}>
                  <b>Next scheduled:</b> {nextEvText}
                </div>

                {/* Primary banner */}
                {banner ? (
                  <div
                    style={{
                      marginTop: 12,
                      borderRadius: 14,
                      color: "white",
                      fontWeight: 950,
                      fontSize: big ? 14 : 16,
                      lineHeight: 1.2,
                      padding: 12,
                      ...(bannerStyle(banner) ?? {}),
                      ...(lateFlash ?? {}),
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                      <div>
                        {banner.kind === "REPORT" ? (banner.late ? "🔴 " : "🟡 ") : banner.kind === "ONPAD" ? "🔵 " : "🟠 "}
                        <span style={{ textDecoration: banner.kind === "REPORT" ? "underline" : "none" }}>{banner.title}</span>
                      </div>
                      {banner.rightText ? <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{banner.rightText}</div> : null}
                    </div>
                    {banner.sub ? <div style={{ marginTop: 6, fontSize: big ? 11 : 12, opacity: 0.9 }}>{banner.sub}</div> : null}
                  </div>
                ) : null}

                {/* ===== LANE QUEUE (fast scanning) ===== */}
                <div style={{ marginTop: 12 }}>
                  {/* NOW lane (matches status color) */}
                  <div style={laneBox(nowAccent, "rgba(255,255,255,0.07)")}>
                    <div style={laneAccent(nowAccent)} />
                    <div style={laneContent}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                        <span style={nowChipForStatus(status)}>NOW</span>
                        <span style={laneLabelStyle}>CURRENT</span>
                      </div>
                      <div style={{ marginTop: 8, fontSize: big ? 18 : 16, fontWeight: 1000 }}>
                        {teamInline(p.now)}
                      </div>
                    </div>
                  </div>

                  {/* ON DECK lane */}
                  <div style={{ ...laneBox(ACCENT_ONDECK, "rgba(0,0,0,0.20)"), marginTop: 10 }}>
                    <div style={laneAccent(ACCENT_ONDECK)} />
                    <div style={laneContent}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                        <span style={laneChip("ON DECK", "rgba(255,255,255,0.16)", "white")}>ON DECK</span>
                        <span style={laneLabelStyle}>NEXT</span>
                      </div>
                      <div style={{ marginTop: 8, fontSize: big ? 16 : 14, fontWeight: 900, opacity: 0.95 }}>
                        {teamInline(p.onDeck)}
                      </div>
                    </div>
                  </div>

                  {/* STANDBY lane */}
                  <div style={{ ...laneBox(ACCENT_STANDBY, "rgba(0,0,0,0.12)"), marginTop: 10 }}>
                    <div style={laneAccent(ACCENT_STANDBY)} />
                    <div style={laneContent}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                        <span style={laneChip("STANDBY", "rgba(255,255,255,0.10)", "white")}>STANDBY</span>
                        <span style={laneLabelStyle}>{(p.standby?.length ?? 0)} waiting</span>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 13, opacity: 0.88 }}>
                        {(p.standby?.length ?? 0) > 0 ? (
                          <>
                            {teamInline(p.standby[0])}
                            {(p.standby?.length ?? 0) > 1 ? <span style={{ opacity: 0.65 }}> {" "}+{(p.standby!.length - 1)} more</span> : null}
                          </>
                        ) : (
                          <span style={{ opacity: 0.6 }}>—</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {filteredPads.length === 0 ? <div style={{ marginTop: 16, opacity: 0.8 }}>No matches for “{search}”.</div> : null}
    </div>
  );
}
