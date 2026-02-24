// lib/auth.ts
import type { GetServerSidePropsContext, GetServerSidePropsResult } from "next";
import { parseCookie } from "@/lib/ui";

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
