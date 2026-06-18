"use client";

import { Loader2, CheckCircle2, XCircle, ExternalLink, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Product } from "@/types/product";
import type { RunStep } from "@/lib/auto-deploy/run-pipeline";

export type RunItemStatus = "pending" | "running" | "done" | "failed";

export interface RunItem {
  product: Product;
  status: RunItemStatus;
  step?: RunStep;
  stepDone?: number;
  stepTotal?: number;
  error?: string;
  adminUrl?: string;
  isUpdate?: boolean;
}

const STEP_LABEL: Record<RunStep, string> = {
  render: "Đang render ảnh",
  video: "Đang render video",
  upload: "Đang tải ảnh lên",
  content: "Đang tạo nội dung AI",
  deploy: "Đang tạo sản phẩm Shopify",
};

interface RunProgressProps {
  items: RunItem[];
  running: boolean;
  finished: boolean;
  onRetryFailed?: () => void;
}

export function RunProgress({ items, running, finished, onRetryFailed }: RunProgressProps) {
  const doneCount = items.filter((i) => i.status === "done").length;
  const failedCount = items.filter((i) => i.status === "failed").length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {running && (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang chạy...
            </span>
          )}
          {finished && (
            <span>
              Hoàn thành: <span className="text-green-500">{doneCount} thành công</span>
              {failedCount > 0 && <span className="text-destructive"> · {failedCount} thất bại</span>}
            </span>
          )}
        </span>
        {finished && failedCount > 0 && onRetryFailed && (
          <Button variant="outline" size="sm" onClick={onRetryFailed}>
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Thử lại {failedCount} thất bại
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2 max-h-[28rem] overflow-y-auto pr-1">
        {items.map((item) => (
          <div key={item.product.id} className="flex items-start gap-3 rounded-lg bg-muted/50 px-3 py-2.5">
            <div className="mt-0.5 shrink-0">
              {item.status === "pending" && <div className="w-4 h-4 rounded-full border border-border" />}
              {item.status === "running" && <Loader2 className="w-4 h-4 text-primary animate-spin" />}
              {item.status === "done" && <CheckCircle2 className="w-4 h-4 text-green-500" />}
              {item.status === "failed" && <XCircle className="w-4 h-4 text-destructive" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground truncate">{item.product.name}</p>

              {item.status === "running" && item.step && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {STEP_LABEL[item.step]}
                  {item.step === "render" && item.stepTotal ? ` (${item.stepDone ?? 0}/${item.stepTotal})` : "..."}
                </p>
              )}

              {item.status === "done" && (
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-green-600 dark:text-green-400">
                    {item.isUpdate ? "Đã cập nhật" : "Đã tạo mới"}
                  </span>
                  {item.adminUrl && (
                    <a
                      href={item.adminUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary inline-flex items-center gap-0.5 hover:underline"
                    >
                      Mở Shopify <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              )}

              {item.status === "failed" && (
                <p className="text-xs text-destructive mt-0.5 break-words">{item.error}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
