// pages/judge.tsx
import Head from "next/head";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  BoardState,
  Pad,
  Division,
  ScheduleEvent,
  Team,
} from "@/lib/state";
import { getSocket } from "@/lib/socketClient";
import { fmtTime, buttonStyle, chipStyle, mmssFromSeconds } from "@/lib/ui";
import { requireAdminRole } from "@/lib/auth";
import {
  PadHeader,
  PadPrimarySection,
  PadOnDeckSection,
  PadStandbySection,
} from "@/components/PadLayout";

const COLOR_ORANGE = "rgba(255,152,0,0.95)"; // BREAK
const COLOR_YELLOW = "rgba(255,235,59,0.95)"; // REPORT
const COLOR_RED = "var(--danger)"; // LATE
const COLOR_BLUE = "var(--info)";

type AnySocket = {
  id?: string;
  connected?: boolean;
  on?: (event: string, cb: (...args: any[]) => void) => void;
  off?: (event: string, cb?: (...args: any[]) => void) => void;
  emit?: (event: string, payload?: any) => void;
};

type CommMessage = {
  id: string;
  ts: number;
  from: "ADMIN" | "JUDGE";
  text: string;
  urgent?: boolean;
  ackedAt?: number;
};

type PadChannel = {
  padId: number;
  name: string;
  online: boolean;
  messages: CommMessage[];
};

type CommSnapshot = {
  channels: PadChannel[];
  lastBroadcast?: {
    id: string;
    ts: number;
    text: string;
    ttlSeconds?: number;
  } | null;
};

function formatHhmm(ts: number) {
  if (!Number.isFinite(ts)) return "";
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function areaName(p: Pad): string {
  const n = String((p as any).name ?? "").trim();
  return n.length ? n : `AREA ${p.id}`;
}

function areaLabel(p: Pad): string {
  const l = String((p as any).label ?? "").trim();
  return l.length ? l : "";
}

function mmss(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function sortSchedule(list: ScheduleEvent[]) {
  return list.slice().sort((a, b) => a.startAt - b.startAt);
}
function nowBlock(schedule: ScheduleEvent[], nowMs: number) {
  return schedule.find((e) => nowMs >= e.startAt && nowMs < e.endAt) ?? null;
}
function nextBlock(schedule: ScheduleEvent[], nowMs: number) {
  return (
    schedule
      .filter((e) => e.startAt > nowMs)
      .sort((a, b) => a.startAt - b.startAt)[0] ?? null
  );
}
function nextBreakLike(schedule: ScheduleEvent[], nowMs: number) {
  const breakLike = schedule.filter(
    (e) => e.startAt > nowMs && (e.type === "BREAK" || e.type === "LUNCH"),
  );
  return breakLike.sort((a, b) => a.startAt - b.startAt)[0] ?? null;
}

function isArrivedForNow(p: Pad): boolean {
  const nowId = p.now?.id ?? null;
  return (
    !!p.nowArrivedAt &&
    !!p.nowArrivedTeamId &&
    !!nowId &&
    p.nowArrivedTeamId === nowId
  );
}

function reportIsValid(p: Pad, nowMs: number): boolean {
  const nowId = p.now?.id ?? null;
  if (!nowId) return false;
  if (!p.reportByTeamId || p.reportByTeamId !== nowId) return false;
  if (!p.reportByDeadlineAt) return false;
  if (isArrivedForNow(p)) return false;
  // If break is active, we suppress report banner
  if (p.breakUntilAt && p.breakUntilAt > nowMs) return false;
  return true;
}

function teamLine(t?: Team | null) {
  if (!t) return <span style={{ color: "var(--text-tertiary)" }}>—</span>;
  const meta = [t.division, t.category].filter(Boolean).join(" • ");
  const tag = (t as any).tag as string | undefined;
  return (
    <span>
      <span style={{ fontWeight: 950, color: "var(--text-primary)" }}>
        {t.name}
      </span>
      {meta ? (
        <span style={{ color: "var(--text-secondary)" }}> ({meta})</span>
      ) : null}
      {tag ? (
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
      ) : null}
    </span>
  );
}

function cardStyle(): React.CSSProperties {
  return {
    borderRadius: 12,
    background: "var(--surface-1)",
    border: "1px solid var(--border-crisp)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
  };
}

export default function JudgeConsole() {
  const [socket, setSocket] = useState<AnySocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState<string>("");

  const [state, setState] = useState<BoardState | null>(null);

  const [activePadId, setActivePadId] = useState(1);
  const [lastAction, setLastAction] = useState("—");

  const [, tick] = useState(0);

  const [toolsOpen, setToolsOpen] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);

  // Manual add modal
  const [showAdd, setShowAdd] = useState(false);
  const [addWhere, setAddWhere] = useState<"NOW" | "ONDECK" | "END">("END");
  const [addTeamName, setAddTeamName] = useState("");
  const [addTeamId, setAddTeamId] = useState("");
  const [addUnit, setAddUnit] = useState("");
  const [addDivision, setAddDivision] = useState<Division | "">("");
  const [addCategory, setAddCategory] = useState("");

  // Local break controls
  const [breakReason, setBreakReason] = useState("Break");
  const [breakMinutes, setBreakMinutes] = useState(10);

  // Pad label editor
  const [labelDraft, setLabelDraft] = useState("");

  // Confirm clear modal
  const [showConfirmClear, setShowConfirmClear] = useState(false);

  // Ops Chat (Judge ↔ Admin)
  const [commSnap, setCommSnap] = useState<CommSnapshot | null>(null);
  const [commDraft, setCommDraft] = useState("");
  const [commSendBusy, setCommSendBusy] = useState(false);
  const [commError, setCommError] = useState<string | null>(null);

  // used only to prevent burst presence spam on rapid pad switches
  const lastPresenceSentAtRef = useRef<number>(0);

  useEffect(() => {
    fetch("/api/socket");
    const s = getSocket() as any;
    setSocket(s ?? null);

    if (!s?.on) return;

    const onConnect = () => {
      setConnected(true);
      const sid = String(s.id ?? "");
      setSocketId(sid);
    };

    const onDisconnect = () => {
      setConnected(false);
      setSocketId("");
    };

    const onState = (next: BoardState) => setState(next);

    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    s.on("state", onState);

    setConnected(Boolean(s.connected));
    if (Boolean(s.connected)) {
      const sid = String(s.id ?? "");
      setSocketId(sid);
    }

    const interval = setInterval(() => tick((t) => t + 1), 1000);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowAdd(false);
        setShowConfirmClear(false);
        setMoreOpen(false);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setToolsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      s.off?.("connect", onConnect);
      s.off?.("disconnect", onDisconnect);
      s.off?.("state", onState);
      clearInterval(interval);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pads = useMemo(() => state?.pads ?? [], [state]);
  const nowMs = Date.now();

  useEffect(() => {
    if (pads.length === 0) return;
    const exists = pads.some((p) => p.id === activePadId);
    if (!exists) setActivePadId(pads[0].id);
  }, [pads, activePadId]);

  const pad: Pad | null = useMemo(
    () => pads.find((p) => p.id === activePadId) ?? null,
    [pads, activePadId],
  );

  useEffect(() => {
    if (!pad) return;
    setLabelDraft(pad.label ?? "");
    setMoreOpen(false);
  }, [pad?.id]);

  const canEmit = !!socket?.emit && connected;

  // ===== Ops Chat wiring (Judge ↔ Admin) =====
  useEffect(() => {
    if (!socket) return;

    const onSnap = (snap: CommSnapshot) => setCommSnap(snap);
    const onBroadcast = (payload: {
      id: string;
      ts: number;
      text: string;
      ttlSeconds?: number;
    }) => {
      setCommSnap((prev) => {
        if (!prev) return prev;
        return { ...prev, lastBroadcast: payload };
      });
    };

    socket.on?.("comm:snapshot", onSnap);
    socket.on?.("comm:broadcast", onBroadcast);

    // Join pad channel (server keys chats by padId)
    socket.emit?.("comm:joinPad", { padId: activePadId });

    return () => {
      socket.off?.("comm:snapshot", onSnap);
      socket.off?.("comm:broadcast", onBroadcast);
    };
  }, [socket, activePadId]);

  useEffect(() => {
    if (!socket) return;

    const sendPresence = () => {
      const now = Date.now();
      if (now - lastPresenceSentAtRef.current < 500) return; // small burst guard
      lastPresenceSentAtRef.current = now;
      socket.emit?.("comm:presence", { padId: activePadId });
    };

    sendPresence();
    const t = setInterval(sendPresence, 15000);

    return () => clearInterval(t);
  }, [socket, activePadId]);

  const myChat: CommMessage[] =
    commSnap?.channels?.find((c) => c.padId === activePadId)?.messages ?? [];
  const lastUnackedUrgent = useMemo(
    () =>
      [...myChat].reverse().find((m) => m.urgent && m.ackedAt == null) ?? null,
    [myChat],
  );
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const lastUrgentIdRef = useRef<string | null>(null);

  useEffect(() => {
    const unacked = [...myChat]
      .reverse()
      .find((m) => m.urgent && m.ackedAt == null);
    if (unacked && unacked.id !== lastUrgentIdRef.current) {
      lastUrgentIdRef.current = unacked.id;
      chatScrollRef.current
        ?.querySelector(`[data-msg-id="${unacked.id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    if (!unacked) lastUrgentIdRef.current = null;
  }, [myChat]);

  function sendJudgeChat() {
    const text = commDraft.trim();
    if (!text) return;
    if (!socket) return;
    if (!canEmit) return;

    setCommSendBusy(true);
    setCommError(null);

    socket.emit?.("judge:comm:send", { text });

    setCommDraft("");
    setTimeout(() => setCommSendBusy(false), 250);
  }

  function ackUrgent() {
    if (!lastUnackedUrgent || !socket) return;
    socket.emit?.("judge:comm:ack", { messageId: lastUnackedUrgent.id });
  }

  // schedule awareness (thin)
  const schedule = useMemo(
    () => sortSchedule(state?.schedule ?? []),
    [state?.schedule],
  );
  const globalSchedule = useMemo(
    () => schedule.filter((e) => e.scope === "GLOBAL"),
    [schedule],
  );
  const nowSched = useMemo(
    () => nowBlock(globalSchedule, nowMs),
    [globalSchedule, nowMs],
  );
  const nextSched = useMemo(
    () => nextBlock(globalSchedule, nowMs),
    [globalSchedule, nowMs],
  );
  const nextBL = useMemo(
    () => nextBreakLike(globalSchedule, nowMs),
    [globalSchedule, nowMs],
  );
  const nextBLsec = nextBL ? (nextBL.startAt - nowMs) / 1000 : null;
  const breakSoon = nextBLsec != null && nextBLsec > 0 && nextBLsec <= 15 * 60;

  // Global break / message
  const gbStart = state?.globalBreakStartAt ?? null;
  const gbUntil = state?.globalBreakUntilAt ?? null;
  const gbReason = (state?.globalBreakReason ?? "Break").trim();

  const globalBreakActive =
    (!gbStart || nowMs >= gbStart) && !!gbUntil && nowMs < gbUntil;
  const globalBreakRemaining =
    globalBreakActive && gbUntil ? (gbUntil - nowMs) / 1000 : null;

  // Local pad state
  const localBreakActive = !!pad?.breakUntilAt && pad.breakUntilAt > nowMs;
  const localBreakRemaining =
    localBreakActive && pad?.breakUntilAt
      ? (pad.breakUntilAt - nowMs) / 1000
      : null;

  const arrivedValid = !!pad && isArrivedForNow(pad);

  const reportActive = !!pad && !globalBreakActive && reportIsValid(pad, nowMs);
  const reportSecondsRemaining =
    reportActive && pad?.reportByDeadlineAt
      ? (pad.reportByDeadlineAt - nowMs) / 1000
      : null;
  const reportIsLate =
    reportSecondsRemaining !== null && reportSecondsRemaining < 0;

  const onPadSeconds =
    arrivedValid && pad?.nowArrivedAt
      ? (nowMs - pad.nowArrivedAt) / 1000
      : null;

  const canAdvance = canEmit && !globalBreakActive && !localBreakActive;

  const payloadBase = {
    padId: activePadId,
    id: activePadId,
    pad: activePadId,
    padIndex: Math.max(0, activePadId - 1),
  };

  function emit(event: string, payload: any, label: string) {
    if (!canEmit) return;
    setLastAction(`✅ ${label}`);
    socket!.emit!(event, payload);
  }

  async function logout() {
    try {
      await fetch("/api/admin-logout", { method: "POST" });
    } catch {}
    window.location.href = "/login";
  }

  // Primary actions
  const doArrived = () => emit("judge:arrived", payloadBase, "MARK ARRIVED");
  const doComplete = () => emit("judge:complete", payloadBase, "COMPLETE");
  const doUndo = () => emit("judge:undo", payloadBase, "UNDO");

  // Secondary ops
  const doSwap = () => emit("judge:swap", payloadBase, "SWAP NOW/ON DECK");
  const doSkip = () => emit("judge:skipOnDeck", payloadBase, "SKIP ON DECK");

  // Exceptions
  const doHold = () => emit("judge:hold", payloadBase, "HOLD");
  const doDNS = () => emit("judge:dns", payloadBase, "DNS");
  const doDQ = () => emit("judge:dq", payloadBase, "DQ");

  const doClear = () => {
    setMoreOpen(false);
    setShowConfirmClear(true);
  };
  const confirmClear = () => {
    emit("judge:clear", payloadBase, "CLEAR PAD");
    setShowConfirmClear(false);
  };

  const doStartBreak = () => {
    const mins = Math.max(1, Number(breakMinutes || 10));
    emit(
      "judge:startBreak",
      {
        ...payloadBase,
        minutes: mins,
        reason: (breakReason || "Break").trim(),
        overrideReport: true,
      },
      `START BREAK (${mins}m)`,
    );
  };
  const doEndBreak = () => emit("judge:endBreak", payloadBase, "END BREAK");

  const doSetLabel = () => {
    const label = labelDraft.trim();
    if (!label) return;
    emit("judge:setPadLabel", { ...payloadBase, label }, "SET PAD LABEL");
  };

  const doAddTeam = () => {
    const teamName = addTeamName.trim();
    if (!teamName) return;

    emit(
      "judge:addTeam",
      {
        ...payloadBase,
        where: addWhere,
        teamName,
        teamId: addTeamId.trim() || undefined,
        unit: addUnit.trim() || undefined,
        division: addDivision || undefined,
        category: addCategory.trim() || undefined,
      },
      `MANUAL ADD (${addWhere})`,
    );

    setShowAdd(false);
    setAddWhere("END");
    setAddTeamName("");
    setAddTeamId("");
    setAddUnit("");
    setAddDivision("");
    setAddCategory("");
  };

  // ARRIVED button “ops-glow” when reporting is active
  const arrivedBtnStyle: React.CSSProperties = !canEmit
    ? buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: true })
    : arrivedValid
      ? {
          ...buttonStyle({ bg: "rgba(46,125,50,0.85)", disabled: false }),
          opacity: 0.95,
        }
      : reportActive
        ? {
            ...buttonStyle({ bg: COLOR_BLUE, fg: "#111", disabled: false }),
            border: "2px solid rgba(144, 202, 249, 0.95)",
            boxShadow:
              "0 0 0 6px rgba(144, 202, 249, 0.22), 0 10px 26px rgba(0,0,0,0.30)",
            animation: "pulseGlow 1.2s ease-in-out infinite",
          }
        : buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: false });

  return (
    <>
      <Head>
        <title>Competition Matrix — Judge Console</title>
      </Head>

      <style>{`
        @keyframes pulseGlow {
          0% { box-shadow: 0 0 0 6px rgba(144, 202, 249, 0.18), 0 10px 26px rgba(0,0,0,0.30); }
          50% { box-shadow: 0 0 0 10px rgba(144, 202, 249, 0.30), 0 10px 26px rgba(0,0,0,0.30); }
          100% { box-shadow: 0 0 0 6px rgba(144, 202, 249, 0.18), 0 10px 26px rgba(0,0,0,0.30); }
        }
        @keyframes lateFlash { 0%{opacity:1} 50%{opacity:.55} 100%{opacity:1} }
        @keyframes urgentFlash { 0%,100%{background:rgba(220,53,69,0.25)} 50%{background:rgba(220,53,69,0.45)} }

        .layout.judge-layout {
          display: grid;
          grid-template-columns: 220px minmax(0, 1fr) 360px;
          gap: 14px;
          margin-top: 14px;
        }
        @media (min-width: 1025px) {
          .toolsToggle { display: none; }
        }
        @media (max-width: 1024px) {
          .layout.judge-layout { grid-template-columns: 200px minmax(0, 1fr); }
          .toolsCol.judge-tools-col { display: none; }
        }
        @media (max-width: 640px) {
          .layout.judge-layout { grid-template-columns: 1fr; }
        }

        .chatScroll {
          max-height: 260px;
          overflow: auto;
          padding-right: 6px;
        }
        .chatBubble {
          border-radius: 14px;
          padding: 10px 12px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(0,0,0,0.20);
        }
      `}</style>

      <main
        className="responsive-page"
        style={{
          minHeight: "100vh",
          background: "var(--page-bg)",
          color: "var(--text-primary)",
          padding: 18,
          fontFamily: "system-ui",
        }}
      >
        {/* Header (Admin-style) */}
        <header
          style={{
            ...cardStyle(),
            padding: "16px 18px",
            display: "flex",
            gap: 14,
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
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

            <div>
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

              <div
                style={{
                  marginTop: 6,
                  display: "flex",
                  gap: 12,
                  alignItems: "baseline",
                  flexWrap: "wrap",
                }}
              >
                <div
                  style={{ fontSize: 40, fontWeight: 1000, lineHeight: 1.05 }}
                >
                  JUDGE CONSOLE
                </div>

                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  {state?.updatedAt
                    ? `Last update: ${fmtTime(state.updatedAt)}`
                    : "Waiting for state…"}{" "}
                  • Last action: {lastAction}
                </div>
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <span
              style={chipStyle(
                connected ? "var(--success)" : "var(--warning)",
                connected ? "white" : "#111",
              )}
            >
              {connected ? "LIVE" : "CONNECTING"}
            </span>

            <button
              className="toolsToggle"
              onClick={() => setToolsOpen((v) => !v)}
              style={{
                ...buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: false }),
              }}
              title="Toggle tools (Ctrl/Cmd+K)"
            >
              {toolsOpen ? "Hide Tools" : "Show Tools"}
            </button>

            <Link
              href="/public"
              style={{
                ...buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: false }),
                textDecoration: "none",
              }}
            >
              Public
            </Link>
            <Link
              href="/admin"
              style={{
                ...buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: false }),
                textDecoration: "none",
              }}
            >
              Admin
            </Link>

            <button
              onClick={logout}
              style={buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: false })}
            >
              Logout
            </button>
          </div>
        </header>

        {/* Schedule strip */}
        <div style={{ marginTop: 12, ...cardStyle(), padding: 12 }}>
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <span style={chipStyle("rgba(255,255,255,0.16)", "white")}>
              SCHEDULE
            </span>
            <div style={{ fontWeight: 900 }}>
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
            {breakSoon && nextBL ? (
              <div
                style={{
                  marginLeft: "auto",
                  fontWeight: 950,
                  color: "var(--cacc-gold)",
                }}
              >
                ⚠️ {nextBL.title} begins in {mmss(nextBLsec ?? 0)} (at{" "}
                {fmtTime(nextBL.startAt)})
              </div>
            ) : null}
          </div>
        </div>

        {/* Main 3-zone layout */}
        <div className="layout judge-layout">
          {/* LEFT: AREA TOGGLE */}
          <aside style={{ ...cardStyle(), padding: 12 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <div style={{ fontWeight: 1000 }}>Areas</div>
              <div style={{ fontSize: 11, opacity: 0.75 }}>Toggle</div>
            </div>

            <div
              style={{
                marginTop: 10,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {pads.map((p) => {
                const active = p.id === activePadId;
                return (
                  <button
                    key={p.id}
                    onClick={() => setActivePadId(p.id)}
                    style={{
                      textAlign: "left",
                      padding: "10px 12px",
                      borderRadius: 14,
                      border: active
                        ? "2px solid rgba(255,255,255,0.35)"
                        : "1px solid rgba(255,255,255,0.12)",
                      background: active
                        ? "rgba(0,0,0,0.30)"
                        : "rgba(0,0,0,0.18)",
                      color: "white",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontWeight: 950 }}>{areaName(p)}</div>
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 11,
                        opacity: 0.8,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {areaLabel(p)}
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* CENTER: OPERATOR */}
          <section style={{ ...cardStyle(), padding: 16 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "flex-start",
              }}
            >
              <PadHeader
                variant="operational"
                padName={pad ? areaName(pad) : "—"}
                subtitle={pad ? areaLabel(pad) : ""}
                statusPill={
                  <span
                    style={chipStyle(
                      pad && localBreakActive
                        ? COLOR_ORANGE
                        : pad && reportActive
                          ? reportIsLate
                            ? COLOR_RED
                            : COLOR_YELLOW
                          : pad && arrivedValid
                            ? COLOR_BLUE
                            : "rgba(255,255,255,0.12)",
                      pad && localBreakActive
                        ? "#111"
                        : pad && reportIsLate
                          ? "white"
                          : pad && reportActive
                            ? "#111"
                            : pad && arrivedValid
                              ? "#111"
                              : "white",
                    )}
                  >
                    {pad && localBreakActive
                      ? "BREAK"
                      : pad && reportActive
                        ? reportIsLate
                          ? "LATE"
                          : "REPORTING"
                        : pad && arrivedValid
                          ? "ON PAD"
                          : "IDLE"}
                  </span>
                }
                updatedAt={
                  pad?.updatedAt
                    ? `Updated: ${fmtTime(pad.updatedAt)}`
                    : undefined
                }
              />
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <button
                  onClick={() => setShowAdd(true)}
                  disabled={!canEmit}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: !canEmit,
                  })}
                >
                  Manual Add
                </button>
                <button
                  onClick={() => setToolsOpen((v) => !v)}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: false,
                  })}
                >
                  Tools ▾
                </button>
              </div>
            </div>

            {/* PRIMARY SECTION (merged: status + competitor once, no duplication) */}
            <div style={{ marginTop: 14 }}>
              {pad && localBreakActive ? (
                <PadPrimarySection
                  variant="operational"
                  statusAccent={COLOR_ORANGE}
                  statusBadge={
                    <span style={chipStyle(COLOR_ORANGE, "#111")}>BREAK</span>
                  }
                  timer={
                    <span
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontWeight: 1000,
                      }}
                    >
                      {mmssFromSeconds(localBreakRemaining ?? 0)}
                    </span>
                  }
                  competitorContent={(pad.breakReason ?? "Break").trim()}
                  subContent={`Reporting resumes at ${pad.breakUntilAt ? fmtTime(pad.breakUntilAt) : "—"}`}
                  bannerOverrides={{
                    background: "rgba(255,152,0,0.12)",
                    border: `2px solid ${COLOR_ORANGE}`,
                  }}
                />
              ) : pad && reportActive && pad.reportByDeadlineAt ? (
                <PadPrimarySection
                  variant="operational"
                  statusAccent={reportIsLate ? COLOR_RED : COLOR_YELLOW}
                  statusBadge={
                    <span
                      style={chipStyle(
                        reportIsLate ? COLOR_RED : COLOR_YELLOW,
                        reportIsLate ? "white" : "#111",
                      )}
                    >
                      {reportIsLate ? "LATE" : "REPORTING"}
                    </span>
                  }
                  timer={
                    <span
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontWeight: 1000,
                        color: reportIsLate ? "white" : "#111",
                      }}
                    >
                      {reportSecondsRemaining != null
                        ? reportSecondsRemaining >= 0
                          ? mmssFromSeconds(reportSecondsRemaining)
                          : mmssFromSeconds(-reportSecondsRemaining)
                        : "—"}
                    </span>
                  }
                  competitorContent={pad.now?.name ?? "—"}
                  subContent="Press MARK ARRIVED as soon as the team is physically on the pad."
                  bannerOverrides={{
                    background: reportIsLate
                      ? "rgba(198,40,40,0.16)"
                      : "rgba(255,235,59,0.14)",
                    border: `2px solid ${reportIsLate ? COLOR_RED : COLOR_YELLOW}`,
                  }}
                  lateFlash={reportIsLate}
                />
              ) : pad && arrivedValid ? (
                <PadPrimarySection
                  variant="operational"
                  statusAccent={COLOR_BLUE}
                  statusBadge={
                    <span style={chipStyle(COLOR_BLUE, "#111")}>ON PAD</span>
                  }
                  timer={
                    <span
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontWeight: 1000,
                      }}
                    >
                      {mmss(onPadSeconds ?? 0)}
                    </span>
                  }
                  competitorContent={pad.now?.name ?? "—"}
                  subContent={`Arrived at ${pad.nowArrivedAt ? fmtTime(pad.nowArrivedAt) : "—"}`}
                  bannerOverrides={{
                    background: "rgba(144,202,249,0.12)",
                    border: "2px solid rgba(144,202,249,0.85)",
                  }}
                />
              ) : (
                <PadPrimarySection
                  variant="operational"
                  statusAccent="rgba(255,255,255,0.12)"
                  statusBadge={
                    <span style={chipStyle("rgba(255,255,255,0.12)", "white")}>
                      IDLE
                    </span>
                  }
                  competitorContent="Ready"
                  subContent="No active timers on this pad right now."
                  bannerOverrides={{
                    background: "rgba(0,0,0,0.22)",
                    border: "1px solid rgba(255,255,255,0.10)",
                  }}
                />
              )}
            </div>

            {/* Actions */}
            <div
              style={{
                marginTop: 14,
                display: "flex",
                gap: 10,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <button
                disabled={!canAdvance}
                onClick={doArrived}
                style={arrivedBtnStyle}
              >
                MARK ARRIVED
              </button>
              <button
                disabled={!canAdvance}
                onClick={doComplete}
                style={buttonStyle({
                  bg: "var(--cacc-gold)",
                  fg: "#111",
                  disabled: !canAdvance,
                })}
              >
                COMPLETE
              </button>
              <button
                disabled={!canEmit}
                onClick={doUndo}
                style={buttonStyle({
                  bg: "rgba(0,0,0,0.25)",
                  disabled: !canEmit,
                })}
              >
                UNDO
              </button>

              <span style={{ opacity: 0.6, marginLeft: 4 }}>|</span>

              <button
                disabled={!canAdvance}
                onClick={doSwap}
                style={buttonStyle({
                  bg: "rgba(0,0,0,0.25)",
                  disabled: !canAdvance,
                })}
              >
                SWAP
              </button>
              <button
                disabled={!canAdvance}
                onClick={doSkip}
                style={buttonStyle({
                  bg: "rgba(0,0,0,0.25)",
                  disabled: !canAdvance,
                })}
              >
                SKIP ON DECK
              </button>

              <div style={{ position: "relative", marginLeft: "auto" }}>
                <button
                  disabled={!canEmit}
                  onClick={() => setMoreOpen((v) => !v)}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: !canEmit,
                  })}
                >
                  More ▾
                </button>

                {moreOpen ? (
                  <div
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "calc(100% + 8px)",
                      width: 240,
                      borderRadius: 14,
                      background: "rgba(10, 14, 28, 0.98)",
                      border: "1px solid rgba(255,255,255,0.16)",
                      boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
                      padding: 10,
                      zIndex: 20,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        opacity: 0.75,
                        marginBottom: 8,
                        fontWeight: 900,
                        letterSpacing: 1.0,
                      }}
                    >
                      EXCEPTIONS
                    </div>

                    <button
                      disabled={!canAdvance}
                      onClick={() => {
                        doHold();
                        setMoreOpen(false);
                      }}
                      style={{
                        ...buttonStyle({
                          bg: "rgba(0,0,0,0.25)",
                          disabled: !canAdvance,
                        }),
                        width: "100%",
                        marginBottom: 8,
                      }}
                    >
                      HOLD
                    </button>
                    <button
                      disabled={!canAdvance}
                      onClick={() => {
                        doDNS();
                        setMoreOpen(false);
                      }}
                      style={{
                        ...buttonStyle({
                          bg: "rgba(0,0,0,0.25)",
                          disabled: !canAdvance,
                        }),
                        width: "100%",
                        marginBottom: 8,
                      }}
                    >
                      DNS
                    </button>
                    <button
                      disabled={!canAdvance}
                      onClick={() => {
                        doDQ();
                        setMoreOpen(false);
                      }}
                      style={{
                        ...buttonStyle({
                          bg: "rgba(0,0,0,0.25)",
                          disabled: !canAdvance,
                        }),
                        width: "100%",
                        marginBottom: 10,
                      }}
                    >
                      DQ
                    </button>

                    <div
                      style={{
                        height: 1,
                        background: "rgba(255,255,255,0.10)",
                        margin: "8px 0",
                      }}
                    />

                    <button
                      disabled={!canEmit}
                      onClick={doClear}
                      style={{
                        ...buttonStyle({
                          bg: COLOR_RED,
                          fg: "white",
                          disabled: !canEmit,
                        }),
                        width: "100%",
                      }}
                    >
                      CLEAR AREA…
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            {/* On Deck & Standby (competitor shown once in Primary above) */}
            <div style={{ marginTop: 14 }}>
              <PadOnDeckSection
                variant="operational"
                label="ON DECK"
                labelRight="NEXT"
              >
                {teamLine(pad?.onDeck)}
              </PadOnDeckSection>

              <PadStandbySection
                variant="operational"
                count={pad?.standby?.length ?? 0}
              >
                {(pad?.standby?.length ?? 0) === 0 ? (
                  <span style={{ opacity: 0.75 }}>—</span>
                ) : (
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 6 }}
                  >
                    {(pad?.standby ?? []).slice(0, 6).map((t, idx) => (
                      <div key={t.id} style={{ fontSize: 13, opacity: 0.95 }}>
                        <span
                          style={{
                            opacity: 0.7,
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, monospace",
                          }}
                        >
                          #{idx + 1}
                        </span>{" "}
                        {teamLine(t)}
                      </div>
                    ))}
                    {(pad?.standby?.length ?? 0) > 6 ? (
                      <div style={{ opacity: 0.75, fontSize: 12 }}>
                        +{pad!.standby.length - 6} more…
                      </div>
                    ) : null}
                  </div>
                )}
              </PadStandbySection>
            </div>
          </section>

          {/* RIGHT: Tools */}
          <aside
            className="toolsCol judge-tools-col"
            style={{ display: toolsOpen ? "block" : "none" }}
          >
            <div style={{ ...cardStyle(), padding: 14 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                }}
              >
                <div style={{ fontWeight: 1000 }}>Tools</div>
                <div style={{ fontSize: 11, opacity: 0.75 }}>Ctrl/Cmd+K</div>
              </div>

              {/* =========================
                  JUDGE ↔ ADMIN CHAT
                 ========================= */}
              <div
                style={{
                  marginTop: 12,
                  borderRadius: 16,
                  padding: 12,
                  background: "rgba(0,0,0,0.22)",
                  border: "1px solid rgba(255,255,255,0.10)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 10,
                  }}
                >
                  <div style={{ fontWeight: 1000 }}>🗨️ Ops Chat</div>
                  <div style={{ opacity: 0.75, fontSize: 12 }}>
                    <div style={{ opacity: 0.75, fontSize: 12 }}>
                      Area {activePadId}
                    </div>
                  </div>
                </div>

                {commSnap?.lastBroadcast?.text ? (
                  <div
                    style={{
                      border: "1px solid rgba(255,152,0,0.35)",
                      background: "rgba(255,152,0,0.12)",
                      borderRadius: 12,
                      padding: 10,
                      marginBottom: 10,
                    }}
                  >
                    <div style={{ fontWeight: 900, marginBottom: 4 }}>
                      📣 Admin Broadcast
                    </div>
                    <div style={{ opacity: 0.92 }}>
                      {commSnap.lastBroadcast.text}
                    </div>
                    <div style={{ opacity: 0.6, fontSize: 12, marginTop: 6 }}>
                      {formatHhmm(commSnap.lastBroadcast.ts)}
                    </div>
                  </div>
                ) : null}

                <div
                  ref={chatScrollRef}
                  style={{
                    height: 180,
                    overflow: "auto",
                    padding: 10,
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.10)",
                    background: "rgba(0,0,0,0.25)",
                    marginBottom: 10,
                  }}
                >
                  {myChat.length === 0 ? (
                    <div style={{ opacity: 0.7, fontSize: 13 }}>
                      No messages yet.
                    </div>
                  ) : (
                    myChat.slice(-80).map((m) => (
                      <div
                        key={m.id}
                        data-msg-id={m.id}
                        style={{ marginBottom: 8, display: "flex", gap: 8 }}
                      >
                        <div
                          style={{
                            width: 70,
                            opacity: 0.7,
                            fontSize: 12,
                            paddingTop: 2,
                          }}
                        >
                          {m.from === "ADMIN" ? "ADMIN" : "YOU"} •{" "}
                          {formatHhmm(m.ts)}
                          {m.urgent && (
                            <div
                              style={{
                                fontSize: 10,
                                fontWeight: 900,
                                color: m.ackedAt
                                  ? "rgba(46,125,50,0.9)"
                                  : "var(--danger)",
                              }}
                            >
                              {m.ackedAt ? "Acknowledged" : "⚠ Urgent"}
                            </div>
                          )}
                        </div>
                        <div
                          style={{
                            flex: 1,
                            borderRadius: 10,
                            padding: "8px 10px",
                            border:
                              m.urgent && !m.ackedAt
                                ? "2px solid var(--danger)"
                                : "1px solid rgba(255,255,255,0.10)",
                            background:
                              m.from === "ADMIN"
                                ? "rgba(0, 150, 255, 0.10)"
                                : "rgba(0, 200, 120, 0.10)",
                            whiteSpace: "pre-wrap",
                            animation:
                              m.urgent && !m.ackedAt
                                ? "urgentFlash 1.5s ease-in-out 3"
                                : undefined,
                          }}
                        >
                          {m.text}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {lastUnackedUrgent ? (
                  <div style={{ marginBottom: 8 }}>
                    <button
                      onClick={ackUrgent}
                      disabled={!canEmit}
                      style={buttonStyle({
                        bg: "var(--danger)",
                        fg: "white",
                        disabled: !canEmit,
                      })}
                    >
                      Acknowledge
                    </button>
                  </div>
                ) : null}

                {commError ? (
                  <div
                    style={{
                      color: "var(--danger)",
                      fontSize: 13,
                      marginBottom: 8,
                    }}
                  >
                    {commError}
                  </div>
                ) : null}

                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={commDraft}
                    onChange={(e) => setCommDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendJudgeChat();
                      }
                    }}
                    placeholder="Message Admin… (Enter to send)"
                    style={{
                      flex: 1,
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(0,0,0,0.25)",
                      color: "white",
                      outline: "none",
                    }}
                    disabled={!canEmit}
                  />
                  <button
                    onClick={sendJudgeChat}
                    disabled={!canEmit || commSendBusy || !commDraft.trim()}
                    style={buttonStyle({
                      bg:
                        !canEmit || commSendBusy || !commDraft.trim()
                          ? "rgba(0,0,0,0.25)"
                          : "var(--cacc-gold)",
                      fg: "#111",
                      disabled: !canEmit || commSendBusy || !commDraft.trim(),
                    })}
                  >
                    Send
                  </button>
                </div>
              </div>

              {/* Local Break */}
              <div
                style={{
                  marginTop: 12,
                  borderRadius: 16,
                  padding: 12,
                  background: "rgba(255,152,0,0.10)",
                  border: `1px solid rgba(255,152,0,0.35)`,
                }}
              >
                <div style={{ fontWeight: 1000 }}>🟠 Local Break</div>
                <div style={{ marginTop: 8, opacity: 0.75, fontSize: 12 }}>
                  Start a pad-only break. If pressed during reporting, it
                  overrides the report timer.
                </div>

                <div
                  style={{
                    marginTop: 10,
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <input
                    value={breakReason}
                    onChange={(e) => setBreakReason(e.target.value)}
                    placeholder="Reason"
                    style={{
                      flex: "1 1 180px",
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(0,0,0,0.25)",
                      color: "white",
                      outline: "none",
                    }}
                    disabled={!canEmit || globalBreakActive}
                  />
                  <input
                    type="number"
                    min={1}
                    value={breakMinutes}
                    onChange={(e) =>
                      setBreakMinutes(Number(e.target.value || 10))
                    }
                    style={{
                      width: 90,
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(0,0,0,0.25)",
                      color: "white",
                      outline: "none",
                    }}
                    disabled={!canEmit || globalBreakActive}
                  />

                  <button
                    disabled={!canEmit || globalBreakActive}
                    onClick={doStartBreak}
                    style={buttonStyle({
                      bg: COLOR_ORANGE,
                      fg: "#111",
                      disabled: !canEmit || globalBreakActive,
                    })}
                  >
                    Start
                  </button>

                  <button
                    disabled={!canEmit || !localBreakActive}
                    onClick={doEndBreak}
                    style={buttonStyle({
                      bg: "rgba(0,0,0,0.25)",
                      disabled: !canEmit || !localBreakActive,
                    })}
                  >
                    End
                  </button>
                </div>

                {globalBreakActive && globalBreakRemaining != null ? (
                  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                    Global break active — resumes in{" "}
                    <b>{mmss(globalBreakRemaining)}</b> ({gbReason})
                  </div>
                ) : null}
              </div>

              {/* Area Label */}
              <div
                style={{
                  marginTop: 12,
                  borderRadius: 16,
                  padding: 12,
                  background: "rgba(0,0,0,0.22)",
                  border: "1px solid rgba(255,255,255,0.10)",
                }}
              >
                <div style={{ fontWeight: 1000 }}>Area Label</div>
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <input
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    placeholder="Area label"
                    style={{
                      flex: "1 1 220px",
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(0,0,0,0.25)",
                      color: "white",
                      outline: "none",
                    }}
                  />
                  <button
                    disabled={!canEmit || !labelDraft.trim()}
                    onClick={doSetLabel}
                    style={buttonStyle({
                      bg: "rgba(0,0,0,0.25)",
                      disabled: !canEmit || !labelDraft.trim(),
                    })}
                  >
                    Save
                  </button>
                </div>
              </div>

              {/* Manual Add shortcut */}
              <div
                style={{
                  marginTop: 12,
                  borderRadius: 16,
                  padding: 12,
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.10)",
                }}
              >
                <div style={{ fontWeight: 1000 }}>Manual Add</div>
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                  Insert into NOW / ON DECK / END (tagged MANUAL).
                </div>
                <div style={{ marginTop: 10 }}>
                  <button
                    disabled={!canEmit}
                    onClick={() => setShowAdd(true)}
                    style={buttonStyle({
                      bg: "rgba(0,0,0,0.25)",
                      disabled: !canEmit,
                    })}
                  >
                    Open…
                  </button>
                </div>
              </div>

              <div
                style={{
                  marginTop: 12,
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <Link
                  href="/public"
                  style={{
                    ...buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: false }),
                    textDecoration: "none",
                  }}
                >
                  Public View
                </Link>
                <Link
                  href="/admin"
                  style={{
                    ...buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: false }),
                    textDecoration: "none",
                  }}
                >
                  Admin
                </Link>
              </div>
            </div>
          </aside>
        </div>

        {/* Manual Add Modal */}
        {showAdd ? (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.55)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              zIndex: 50,
            }}
            onClick={() => setShowAdd(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(760px, 100%)",
                borderRadius: 18,
                background: "rgba(10, 14, 28, 0.98)",
                border: "1px solid rgba(255,255,255,0.16)",
                boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
                padding: 16,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <div style={{ fontWeight: 1000, fontSize: 18 }}>
                  Manual Add Team
                </div>
                <button
                  onClick={() => setShowAdd(false)}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: false,
                  })}
                >
                  Close
                </button>
              </div>

              <div
                style={{
                  marginTop: 12,
                  display: "grid",
                  gridTemplateColumns: "160px 1fr",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <div style={{ opacity: 0.85, fontWeight: 800 }}>Insert at</div>
                <select
                  value={addWhere}
                  onChange={(e) => setAddWhere(e.target.value as any)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                >
                  <option value="END">End of Standby</option>
                  <option value="ONDECK">On Deck</option>
                  <option value="NOW">Now</option>
                </select>

                <div style={{ opacity: 0.85, fontWeight: 800 }}>
                  Team Name *
                </div>
                <input
                  value={addTeamName}
                  onChange={(e) => setAddTeamName(e.target.value)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                />

                <div style={{ opacity: 0.85, fontWeight: 800 }}>
                  Team ID (optional)
                </div>
                <input
                  value={addTeamId}
                  onChange={(e) => setAddTeamId(e.target.value)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                />

                <div style={{ opacity: 0.85, fontWeight: 800 }}>
                  Unit (optional)
                </div>
                <input
                  value={addUnit}
                  onChange={(e) => setAddUnit(e.target.value)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                />

                <div style={{ opacity: 0.85, fontWeight: 800 }}>
                  Division (optional)
                </div>
                <select
                  value={addDivision}
                  onChange={(e) => setAddDivision(e.target.value as any)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                >
                  <option value="">—</option>
                  <option value="Jr">Jr</option>
                  <option value="Sr">Sr</option>
                </select>

                <div style={{ opacity: 0.85, fontWeight: 800 }}>
                  Category (optional)
                </div>
                <input
                  value={addCategory}
                  onChange={(e) => setAddCategory(e.target.value)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                />
              </div>

              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  gap: 10,
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                }}
              >
                <button
                  onClick={() => setShowAdd(false)}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: false,
                  })}
                >
                  Cancel
                </button>
                <button
                  disabled={!canEmit || !addTeamName.trim()}
                  onClick={doAddTeam}
                  style={buttonStyle({
                    bg: "var(--cacc-gold)",
                    fg: "#111",
                    disabled: !canEmit || !addTeamName.trim(),
                  })}
                >
                  Add Team
                </button>
              </div>

              <div style={{ marginTop: 10, opacity: 0.75, fontSize: 12 }}>
                Manual adds are tagged <b>MANUAL</b>.
              </div>
            </div>
          </div>
        ) : null}

        {/* Confirm CLEAR modal */}
        {showConfirmClear ? (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.60)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              zIndex: 60,
            }}
            onClick={() => setShowConfirmClear(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(520px, 100%)",
                borderRadius: 18,
                background: "rgba(10, 14, 28, 0.98)",
                border: "1px solid rgba(255,255,255,0.16)",
                boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
                padding: 16,
              }}
            >
              <div style={{ fontWeight: 1000, fontSize: 18 }}>
                Confirm CLEAR AREA
              </div>
              <div
                style={{
                  marginTop: 10,
                  opacity: 0.85,
                  fontSize: 13,
                  lineHeight: 1.35,
                }}
              >
                This clears <b>NOW</b>, <b>ON DECK</b>, <b>STANDBY</b>, and all
                timers for Area {activePadId}.
              </div>

              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  gap: 10,
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                }}
              >
                <button
                  onClick={() => setShowConfirmClear(false)}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: false,
                  })}
                >
                  Cancel
                </button>
                <button
                  disabled={!canEmit}
                  onClick={confirmClear}
                  style={buttonStyle({
                    bg: COLOR_RED,
                    fg: "white",
                    disabled: !canEmit,
                  })}
                >
                  Yes, CLEAR
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </>
  );
}

export async function getServerSideProps(
  ctx: import("next").GetServerSidePropsContext,
) {
  return requireAdminRole(ctx, "judge");
}
