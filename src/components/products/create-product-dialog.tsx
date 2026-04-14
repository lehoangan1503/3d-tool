"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Sparkles, Layers } from "lucide-react";
import type { ProductType } from "@/types/product";

export function CreateProductDialog({ onCreated }: { onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<ProductType>("smooth");
  const router = useRouter();

  async function handleCreate() {
    if (!name.trim()) return;

    setLoading(true);
    try {
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), type }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to create product");
      }

      const product = await res.json();
      setOpen(false);
      setName("");
      setType("smooth");
      onCreated?.();
      router.push(`/dashboard/products/${product.id}`);
      router.refresh();
    } catch (error) {
      console.error("Create product error:", error);
      alert(error instanceof Error ? error.message : "Không thể tạo sản phẩm");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" />
          Sản Phẩm Mới
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tạo Sản Phẩm Mới</DialogTitle>
          <DialogDescription>
            Chọn loại cơ để bắt đầu tùy chỉnh thiết kế của bạn.
          </DialogDescription>
        </DialogHeader>
        
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name" className="dark:text-white">Tên Sản Phẩm</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Cơ tùy chỉnh của tôi"
              className="dark:bg-white/5 dark:border-white/20 dark:text-white dark:placeholder:text-white/40"
            />
          </div>
          
          <div className="flex flex-col gap-2">
            <Label htmlFor="type" className="dark:text-white">Loại Cơ</Label>
            <Select value={type} onValueChange={(v) => setType(v as ProductType)}>
              <SelectTrigger id="type" className="dark:bg-white/5 dark:border-white/20 dark:text-white">
                <SelectValue placeholder="Chọn loại" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="smooth">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
                      <Sparkles className="h-4 w-4 text-white/80" />
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">Trơn</span>
                      <span className="text-xs text-white/60">Bề mặt trơn cổ điển</span>
                    </div>
                  </div>
                </SelectItem>
                <SelectItem value="leather">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
                      <Layers className="h-4 w-4 text-white/80" />
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">Da</span>
                      <span className="text-xs text-white/60">Bọc da vân</span>
                    </div>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Hủy
          </Button>
          <Button onClick={handleCreate} disabled={loading || !name.trim()}>
            {loading ? "Đang tạo..." : "Tạo Sản Phẩm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
