import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldCheck, Users, LogOut } from "lucide-react";
import { adminLogout } from "../login/actions";
import { CreateUserForm } from "./create-user-form";
import type { UserProfile } from "@/types/product";

async function getAllUsers(): Promise<UserProfile[]> {
  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from("user_profiles")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[admin] Failed to fetch user_profiles:", error.message);
    return [];
  }

  return (data as UserProfile[]) ?? [];
}

export default async function AdminDashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.app_metadata?.role !== "admin") {
    redirect("/admin/login");
  }

  const users = await getAllUsers();

  return (
    <div className="min-h-screen bg-background">
      {/* Top Bar */}
      <header className="border-b bg-card px-6 py-4">
        <div className="flex items-center justify-between max-w-6xl mx-auto">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-amber-500" />
            <span className="font-semibold text-lg">Admin Dashboard</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground hidden sm:block">{user.email}</span>
            <form action={adminLogout}>
              <Button type="submit" variant="outline" size="sm" className="flex items-center gap-2">
                <LogOut className="h-4 w-4" />
                Đăng Xuất
              </Button>
            </form>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 flex flex-col gap-8">
        {/* Create User */}
        <CreateUserForm />

        {/* User List */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Users className="h-5 w-5" />
              Danh Sách Người Dùng
              <span className="ml-auto text-sm font-normal text-muted-foreground">
                {users.length} tài khoản
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {users.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Chưa có tài khoản nào.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-2 font-medium text-muted-foreground">Email</th>
                      <th className="text-left py-3 px-2 font-medium text-muted-foreground">Nickname</th>
                      <th className="text-left py-3 px-2 font-medium text-muted-foreground">Ngày tạo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.user_id} className="border-b last:border-0 hover:bg-muted/50">
                        <td className="py-3 px-2">{u.email}</td>
                        <td className="py-3 px-2 text-muted-foreground">{u.nickname ?? "—"}</td>
                        <td className="py-3 px-2 text-muted-foreground">
                          {new Date(u.created_at).toLocaleDateString("vi-VN", {
                            day: "2-digit",
                            month: "2-digit",
                            year: "numeric",
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
