import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tags } from "lucide-react";
import { DeployTemplatesEditor } from "./templates-editor";

export default async function AdminDeployTemplatesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.app_metadata?.role !== "admin") {
    redirect("/admin/login");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Tags className="h-5 w-5" />
          Bảng giá
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-5 text-sm text-muted-foreground">
          &quot;Global&quot; là bảng giá mặc định đang dùng. Tạo thêm bảng giá (Uni, Novera...) và sửa
          số cho từng bảng; khi deploy chọn bảng nào thì sản phẩm ăn giá bảng đó.
        </p>
        <DeployTemplatesEditor />
      </CardContent>
    </Card>
  );
}
