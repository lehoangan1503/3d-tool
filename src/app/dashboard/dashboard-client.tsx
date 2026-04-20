"use client";

import { useState } from "react";
import { logout } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { ProductsGrid } from "@/components/products/products-grid";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserDropdown } from "@/components/user-dropdown";
import { FirstLoginDialog } from "@/components/first-login-dialog";
import { LogOut } from "lucide-react";
import type { UserProfile } from "@/types/product";

interface DashboardClientProps {
  profile: UserProfile;
  showFirstLoginDialog: boolean;
}

export function DashboardClient({ profile: initialProfile, showFirstLoginDialog }: DashboardClientProps) {
  const [profile, setProfile] = useState(initialProfile);
  const [firstLoginOpen, setFirstLoginOpen] = useState(showFirstLoginDialog);

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
        <ProductsGrid currentUserId={profile.user_id} />
      </main>

      <FirstLoginDialog open={firstLoginOpen} onComplete={handleFirstLoginComplete} />
    </div>
  );
}
