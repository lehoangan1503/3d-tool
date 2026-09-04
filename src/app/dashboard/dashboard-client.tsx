"use client";

import { useState } from "react";
import Link from "next/link";
import { logout } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { ProductsGrid } from "@/components/products/products-grid";
import { ReferencesGrid } from "@/components/products/references-grid";
import { StudioTemplatesGrid } from "@/components/products/studio-templates-grid";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserDropdown } from "@/components/user-dropdown";
import { FirstLoginDialog } from "@/components/first-login-dialog";
import { LogOut, ShieldCheck, Rocket, Sparkles } from "lucide-react";
import { StoreSwitcher } from "@/components/shopify/store-switcher";
import type { UserProfile } from "@/types/product";

interface DashboardClientProps {
  profile: UserProfile;
  showFirstLoginDialog: boolean;
  /** Superadmin (auth app_metadata) — the only tier with /admin/* access. */
  isSuperAdmin?: boolean;
  /** Superadmin, tool admin, or mode — may use the auto-deploy tool. */
  canDeploy?: boolean;
  /** GPU rendering is admin-only — it spends rented-card time. */
  canRender?: boolean;
  /**
   * Superadmin or tool admin — may delete any user's 2D reference / 3D video
   * template from the dashboard lists. 'mode' and normal users may not.
   */
  canDeleteTeamAssets?: boolean;
}

/** Which list the dashboard is showing. */
type DashboardView = "products" | "references" | "studio";

const VIEW_TABS: Array<{ value: DashboardView; label: string }> = [
  { value: "products", label: "Sản Phẩm" },
  { value: "references", label: "Tham Chiếu 2D" },
  { value: "studio", label: "Video 3D" },
];

export function DashboardClient({ profile: initialProfile, showFirstLoginDialog, isSuperAdmin, canDeploy, canRender, canDeleteTeamAssets }: DashboardClientProps) {
  const [profile, setProfile] = useState(initialProfile);
  const [firstLoginOpen, setFirstLoginOpen] = useState(showFirstLoginDialog);
  const [view, setView] = useState<DashboardView>("products");

  // Shared by all three lists so the tabs sit right next to each heading.
  // mr-auto keeps them left-aligned inside the heading row's justify-between.
  const viewTabs = (
    <div className="flex items-center gap-2 mr-auto">
      {VIEW_TABS.map((t) => (
        <Button
          key={t.value}
          variant={view === t.value ? "default" : "outline"}
          size="sm"
          onClick={() => setView(t.value)}
        >
          {t.label}
        </Button>
      ))}
    </div>
  );

  function handleFirstLoginComplete(nickname: string | null) {
    if (nickname) {
      setProfile((prev) => ({ ...prev, nickname }));
    }
    setFirstLoginOpen(false);
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card/80 backdrop-blur-sm border-b sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-18">
            <h1 className="text-xl font-semibold text-foreground">Cue Customizer</h1>
            <div className="flex items-center gap-2">
              <StoreSwitcher />
              {canRender && (
                <Button variant="outline" size="sm" asChild>
                  <Link href="/renders" target="_blank" rel="noopener noreferrer">
                    <Sparkles className="h-4 w-4" />
                    <span className="hidden sm:inline">Render GPU</span>
                  </Link>
                </Button>
              )}
              {canDeploy && (
                <Button variant="outline" size="sm" asChild>
                  <Link href="/auto-deploy" target="_blank" rel="noopener noreferrer">
                    <Rocket className="h-4 w-4" />
                    <span className="hidden sm:inline">Triển khai tự động</span>
                  </Link>
                </Button>
              )}
              {isSuperAdmin && (
                <Button variant="outline" size="sm" asChild>
                  <Link href="/admin/dashboard" target="_blank" rel="noopener noreferrer">
                    <ShieldCheck className="h-4 w-4" />
                    <span className="hidden sm:inline">Admin Dashboard</span>
                  </Link>
                </Button>
              )}
              <UserDropdown profile={profile} />
              <ThemeToggle />
              <form action={logout}>
                <Button variant="ghost" size="sm" type="submit">
                  <LogOut className="h-4 w-4" />
                  <span className="hidden sm:inline">Đăng Xuất</span>
                </Button>
              </form>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {view === "products" && <ProductsGrid currentUserId={profile.user_id} tabs={viewTabs} />}
        {view === "references" && <ReferencesGrid tabs={viewTabs} canDelete={canDeleteTeamAssets} />}
        {view === "studio" && <StudioTemplatesGrid tabs={viewTabs} canDelete={canDeleteTeamAssets} />}
      </main>

      <FirstLoginDialog open={firstLoginOpen} onComplete={handleFirstLoginComplete} />
    </div>
  );
}
