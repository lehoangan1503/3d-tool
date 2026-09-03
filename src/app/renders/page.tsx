import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/auth/roles";
import { RendersClient } from "./renders-client";

/**
 * /renders — queue and watch server-side GPU renders.
 *
 * Restricted to admins (tool admin or superadmin): a render spends real money
 * on rented GPU time and writes into shared Storage, so it is not something an
 * ordinary account should be able to trigger in a loop.
 */
export default async function RendersPage() {
  const { user, isToolAdmin, isSuperAdmin } = await getSessionRole();

  if (!user) {
    redirect("/login");
  }

  if (!isToolAdmin && !isSuperAdmin) {
    return (
      <div className="max-w-md mx-auto px-4 py-24 text-center">
        <h1 className="text-xl font-semibold mb-2">Không có quyền truy cập</h1>
        <p className="text-sm text-muted-foreground">
          Render trên GPU yêu cầu quyền admin — mỗi lần render tốn thời gian GPU thuê.
        </p>
      </div>
    );
  }

  return <RendersClient />;
}
