// pages/public/index.tsx
import Head from "next/head";
import { useEffect, useMemo, useState } from "react";
import PublicBoard from "@/components/PublicBoard";
import { setRoleCookie } from "@/lib/auth";

export async function getServerSideProps(ctx: import("next").GetServerSidePropsContext) {
  setRoleCookie(ctx.res, "public");
  return { props: {} };
}

function useKioskFlag() {
  const [kiosk, setKiosk] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    setKiosk(url.searchParams.get("kiosk") === "1");
  }, []);

  return kiosk;
}

export default function PublicPage() {
  const kiosk = useKioskFlag();

  // Enter fullscreen when kiosk=1
  useEffect(() => {
    if (!kiosk) return;

    const el = document.documentElement;

    const tryFullscreen = async () => {
      try {
        if (!document.fullscreenElement) {
          // @ts-ignore
          await el.requestFullscreen?.();
        }
      } catch {}
    };

    tryFullscreen();
  }, [kiosk]);

  // Kiosk CSS: hide cursor + prevent scroll
  const kioskStyle = useMemo(() => {
    if (!kiosk) return null;
    return (
      <style>{`
        html, body { overflow: hidden; }
        * { cursor: none !important; }
      `}</style>
    );
  }, [kiosk]);

  return (
    <>
      <Head>
        <title>Competition Matrix — Public Board</title>
      </Head>

      {kioskStyle}

      {/* If NOT kiosk, show a button to enter kiosk mode */}
      {!kiosk && (
        <div
          style={{
            position: "fixed",
            right: 16,
            bottom: 16,
            zIndex: 50,
            display: "flex",
            gap: 10,
          }}
        >
          <a
            href="/public?kiosk=1"
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              background: "var(--cacc-gold)",
              color: "#111",
              fontWeight: 1000,
              textDecoration: "none",
              border: "1px solid rgba(255,255,255,0.20)",
            }}
          >
            Enter Kiosk (Fullscreen)
          </a>
        </div>
      )}

      <PublicBoard kiosk={kiosk} />
    </>
  );
}
