import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/auth/roles";
import { ApiTokensClient } from "./api-tokens-client";

/**
 * /settings/api-tokens — manage the tokens that let an outside caller create
 * products.
 *
 * Available to any signed-in user: a token can only ever act as its own owner,
 * so it grants nothing the person could not already do in the dashboard. What
 * it adds is a way to do it without a browser.
 */
export default async function ApiTokensPage() {
  const { user } = await getSessionRole();

  if (!user) {
    redirect("/login");
  }

  return <ApiTokensClient />;
}
