import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { CreateProductDialog } from "@/components/products/create-product-dialog";
import { ProductCard } from "@/components/products/product-card";
import { ThemeToggle } from "@/components/theme-toggle";
import type { Product } from "@/types/product";
import { LogOut, Package } from "lucide-react";

export default async function DashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: products, error } = await supabase.from("products").select("*").eq("user_id", user.id).order("updated_at", { ascending: false });

  if (error) {
    console.error("Failed to fetch products:", error);
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card/80 backdrop-blur-sm border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <h1 className="text-xl font-semibold text-foreground">Cue Customizer</h1>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground hidden sm:block">{user.email}</span>
              <ThemeToggle />
              <form action={logout}>
                <Button variant="ghost" size="sm" type="submit">
                  <LogOut className="h-4 w-4" />
                  <span className="hidden sm:inline">Sign Out</span>
                </Button>
              </form>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <h2 className="text-2xl font-bold text-foreground">My Products</h2>
            <p className="text-muted-foreground">Create and customize your pool cue designs</p>
          </div>
          <CreateProductDialog />
        </div>

        {/* Products Grid */}
        {products && products.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(products as Product[]).map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        ) : (
          <div className="text-center py-16 bg-card rounded-xl border">
            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 rounded-full bg-primary/10">
              <Package className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold mb-2 text-foreground">No products yet</h3>
            <p className="text-muted-foreground mb-6 max-w-sm mx-auto">Create your first custom cue design to get started</p>
            <CreateProductDialog />
          </div>
        )}
      </main>
    </div>
  );
}
