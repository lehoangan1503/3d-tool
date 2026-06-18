import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/auth/roles";
import { AutoDeployClient } from "./auto-deploy-client";

export default async function AutoDeployPage() {
  const { user, canDeploy } = await getSessionRole();

  if (!user) {
    redirect("/login");
  }

  // Triển khai tự động ends in a Shopify deploy, which requires admin or mode role.
  if (!canDeploy) {
    return (
      <div className="max-w-md mx-auto px-4 py-24 text-center">
        <h1 className="text-xl font-semibold mb-2">Không có quyền truy cập</h1>
        <p className="text-sm text-muted-foreground">
          Tính năng Triển khai tự động yêu cầu quyền admin hoặc mode để tạo sản phẩm Shopify.
        </p>
      </div>
    );
  }

  return <AutoDeployClient />;
}
