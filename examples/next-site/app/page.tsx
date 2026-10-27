// A plain page: it reads the member from the cached check and never calls the
// app or starts a hand-over. Only the header's "Log in" does that, on a click.
import { getMember } from "@zwingd-ce/website-kit-next/server";

import { zwingd } from "@/lib/zwingd";

export const dynamic = "force-dynamic";

export default async function Home() {
  const member = await getMember(zwingd());
  return (
    <section>
      <h1>{member ? `Welcome back${member.firstName ? `, ${member.firstName}` : ""}` : "Welcome"}</h1>
      <p>
        {member
          ? "You are signed in through the app. Buying here goes straight to payment once member checkout is on."
          : "Anyone can browse and buy. Members can log in to see their account."}
      </p>
    </section>
  );
}
