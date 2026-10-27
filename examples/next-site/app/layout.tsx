// The header pattern to copy: the server reads who is signed in (name only) and
// hands it to the client; the AccountButton shows "Log in" or "My account".
import type { ReactNode } from "react";

import { AccountButton, MemberProvider } from "@zwingd-ce/website-kit-next/client";
import { accountUrl, getMember, signOutToken } from "@zwingd-ce/website-kit-next/server";

import { zwingd } from "@/lib/zwingd";

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const kit = zwingd();
  const [member, csrf, account] = await Promise.all([getMember(kit), signOutToken(kit), accountUrl(kit)]);
  return (
    <html lang="en">
      <body>
        <MemberProvider
          member={member}
          signOutToken={csrf}
          appUrl={kit.config.appUrl}
          accountUrl={account}
          coursePath={kit.config.coursePath}
        >
          <header style={{ display: "flex", justifyContent: "space-between", padding: "1rem" }}>
            <a href="/">Example site</a>
            <AccountButton />
          </header>
          <main style={{ padding: "1rem" }}>{children}</main>
        </MemberProvider>
      </body>
    </html>
  );
}
