"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Check, Copy, KeyRound, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import {
  API_GROUPS,
  API_SAMPLES,
  countEndpoints,
  fillSample,
} from "@/lib/api-tokens/api-catalog";
import type { ApiTokenCreated, ApiTokenSummary, CreateApiTokenInput } from "@/types/api-token";

/**
 * Manages API tokens.
 *
 * The screen is built around one awkward fact: a token's plaintext exists only
 * in the creation response. So a new token is shown in a panel that stays put
 * until dismissed, rather than a toast that can be missed — losing it means
 * making another one.
 */

/**
 * The `type` field's values, shown as a reference table.
 *
 * On this screen since 037: the type left the token and became a request
 * field, so the thing a user needs from this page is no longer "pick one" but
 * "what do I type into my flow" — hence a list to read, not a control.
 */
const TYPE_FIELD_VALUES: readonly { value: string; label: string; also: string }[] = [
  { value: "leather", label: "Gậy da", also: "da, gậy da" },
  { value: "smooth", label: "Gậy trơn", also: "tron, gậy trơn, plain" },
  { value: "lizard", label: "Gậy da lizard", also: "da lizard, gậy da lizard" },
];

/**
 * A copyable sample.
 *
 * Its own component so each block owns its "copied" state — one shared flag
 * would light up the tick on every block at once, which reads as "all copied"
 * when only one was.
 */
function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Blocked outside a secure context; the text is selectable on screen.
    }
  }

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-muted/40">
        <span className="text-xs font-medium">{title}</span>
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {/* overflow-x-auto rather than wrapping: a broken curl line is not
          copy-pasteable, and these are meant to be pasted. */}
      <pre className="px-3 py-2.5 text-xs font-mono overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Formats a timestamp for the list, or a dash when it never happened. */
function formatWhen(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ApiTokensClient() {
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [namePrefix, setNamePrefix] = useState("");
  const [creating, setCreating] = useState(false);

  /** The one-time plaintext, held until the user dismisses it. */
  const [freshToken, setFreshToken] = useState<ApiTokenCreated | null>(null);
  const [copied, setCopied] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);

  /**
   * The live origin, for the samples.
   *
   * Read in an effect rather than during render: this component is
   * server-rendered first, where `window` does not exist, and reading it inline
   * would either crash or produce markup that disagrees with the client's.
   * Starting empty means the first paint shows a relative path, which the
   * effect completes before anyone can copy it.
   */
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrigin(window.location.origin);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/api-tokens");
      if (!res.ok) throw new Error((await res.json()).error ?? "Không tải được");
      const data: { tokens: ApiTokenSummary[] } = await res.json();
      setTokens(data.tokens);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được danh sách token");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The setState the rule objects to happens after an await, not during the
    // render this effect runs in.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function handleCreate() {
    if (creating || !label.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const body: CreateApiTokenInput = {
        label: label.trim(),
        name_prefix: namePrefix.trim() || null,
      };
      const res = await fetch("/api/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Không tạo được token");

      setFreshToken(data as ApiTokenCreated);
      setLabel("");
      setNamePrefix("");
      setCopied(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tạo được token");
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleRevoke(token: ApiTokenSummary) {
    setBusyId(token.id);
    try {
      const res = await fetch(`/api/api-tokens/${token.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revoked: token.revoked_at === null }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Không đổi được trạng thái");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không đổi được trạng thái");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(token: ApiTokenSummary) {
    // Irreversible and silent from the caller's side — whatever is using this
    // token starts failing with no other signal — so it is worth a stop.
    if (!confirm(`Xoá token "${token.label}"? Mọi nơi đang dùng token này sẽ lỗi 401 ngay lập tức.`)) {
      return;
    }
    setBusyId(token.id);
    try {
      const res = await fetch(`/api/api-tokens/${token.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Không xoá được");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không xoá được token");
    } finally {
      setBusyId(null);
    }
  }

  async function handleCopy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is blocked without a secure context or permission; the token
      // is on screen and selectable, so this is not worth an error banner.
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-card/80 backdrop-blur-sm border-b sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/dashboard">
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Dashboard</span>
            </Link>
          </Button>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            API Token
          </h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-8">
        <p className="text-sm text-muted-foreground">
          Token cho phép gửi template từ bên ngoài vào, tạo sản phẩm rồi đặt render
          luôn — không cần mở dashboard.{" "}
          <strong>Một token dùng cho tất cả các loại gậy</strong> và cho cả 3 API.
          Loại gậy khai trong field <code className="font-mono">type</code> khi tạo
          sản phẩm; khi render thì chỉ cần <strong>đề cập tên</strong> nhóm ảnh,
          reference hoặc template video — trộn nhiều loại trong một request cũng
          được.
        </p>

        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium mb-2">Luồng cho AI agent — 3 bước</p>
          <ol className="text-xs text-muted-foreground flex flex-col gap-1.5 list-decimal pl-4">
            <li>
              <code className="font-mono">POST /api/v1/products</code> — gửi file
              template + <code className="font-mono">type</code> → nhận{" "}
              <code className="font-mono">id</code> và{" "}
              <code className="font-mono">name</code> của sản phẩm
            </li>
            <li>
              <code className="font-mono">GET /api/v1/render-targets</code> — xem có
              những nhóm / reference / template nào (gọi 1 lần, nhớ tên là đủ)
            </li>
            <li>
              <code className="font-mono">POST /api/v1/renders</code> — đặt render
              bằng tên. Trộn được nhiều nhóm + reference lẻ + template video trong
              cùng 1 request; mỗi target thành 1 job. Rồi poll{" "}
              <code className="font-mono">status_url</code> của từng job để lấy link
              file
            </li>
          </ol>
        </div>

        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}

        {/* The plaintext, shown once. */}
        {freshToken && (
          <div className="rounded-lg border-2 border-primary bg-primary/5 p-4 flex flex-col gap-3">
            <div className="flex items-start gap-2">
              <TriangleAlert className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-sm">Copy token ngay — sẽ không hiện lại lần nào nữa</p>
                <p className="text-xs text-muted-foreground mt-0.5">Hệ thống chỉ lưu bản mã hoá. Mất token thì phải tạo cái mới.</p>
              </div>
            </div>

            <div className="flex gap-2">
              <code className="flex-1 rounded-md border bg-background px-3 py-2 text-xs font-mono break-all select-all">{freshToken.token}</code>
              <Button size="sm" onClick={() => handleCopy(freshToken.token)}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>

            <div className="rounded-md bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground mb-1.5">Gọi thử — thay đường dẫn file của anh:</p>
              <code className="text-xs font-mono break-all block">
                curl -X POST {typeof window !== "undefined" ? window.location.origin : ""}
                /api/v1/products \<br />
                &nbsp;&nbsp;-H &quot;Authorization: Bearer {freshToken.token}&quot; \<br />
                &nbsp;&nbsp;-F file=@surface.jpg \<br />
                &nbsp;&nbsp;-F type=leather
              </code>
            </div>

            <Button variant="outline" size="sm" onClick={() => setFreshToken(null)}>
              Tôi đã lưu token
            </Button>
          </div>
        )}

        {/* Create */}
        <section className="rounded-lg border bg-card p-4 flex flex-col gap-4">
          <h2 className="font-semibold text-sm">Tạo token mới</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="token-label" className="text-xs">
                Token name
              </Label>
              <Input id="token-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="AI tạo sản phẩm" maxLength={80} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="token-prefix" className="text-xs">
                Tiền tố tên mặc định (tuỳ chọn)
              </Label>
              <Input id="token-prefix" value={namePrefix} onChange={(e) => setNamePrefix(e.target.value)} placeholder="n02" maxLength={32} />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Tiền tố <code className="font-mono">n02</code> + file <code className="font-mono">dragon-gold.jpg</code> → sản phẩm <code className="font-mono">n02-dragon-gold</code>.
            Chỉ dùng chữ thường, số và dấu gạch ngang. Request có thể gửi{" "}
            <code className="font-mono">name_prefix</code> để dùng tiền tố khác cho
            riêng lần đó.
          </p>

          <div>
            <Button onClick={handleCreate} disabled={creating || !label.trim()}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Tạo token
            </Button>
          </div>
        </section>

        {/* List */}
        <section className="flex flex-col gap-3">
          <h2 className="font-semibold text-sm">Token của tôi</h2>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              Đang tải…
            </div>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Chưa có token nào.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {tokens.map((token) => {
                const revoked = token.revoked_at !== null;
                return (
                  <div key={token.id} className={`rounded-lg border bg-card p-4 flex flex-wrap items-center gap-x-4 gap-y-2 ${revoked ? "opacity-60" : ""}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm truncate">{token.label}</span>
                        {token.name_prefix && (
                          <Badge variant="outline" className="font-mono">
                            {token.name_prefix}-
                          </Badge>
                        )}
                        {revoked && <Badge variant="destructive">Đã thu hồi</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 font-mono">{token.token_prefix}…</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Tạo {formatWhen(token.created_at)} · Dùng lần cuối {formatWhen(token.last_used_at)}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => handleToggleRevoke(token)} disabled={busyId === token.id}>
                        {busyId === token.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : revoked ? "Bật lại" : "Thu hồi"}
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(token)} disabled={busyId === token.id} title="Xoá token">
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* The one field a caller must fill in per template. */}
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="font-semibold text-sm">
              Field <code className="font-mono">type</code> — khai loại gậy trong request
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Bắt buộc. Không phân biệt chữ hoa/thường, có dấu hay không dấu.
              Thiếu hoặc sai giá trị thì API trả lỗi 400 kèm danh sách này — không
              bao giờ tự tạo sai loại.
            </p>
          </div>

          <div className="rounded-lg border bg-card divide-y">
            {TYPE_FIELD_VALUES.map((entry) => (
              <div
                key={entry.value}
                className="px-4 py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1"
              >
                <code className="font-mono text-xs shrink-0 w-24">
                  type={entry.value}
                </code>
                <span className="text-xs font-medium shrink-0 w-28">{entry.label}</span>
                <span className="text-xs text-muted-foreground">
                  cũng nhận: {entry.also}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Copyable request samples, then the full endpoint catalogue. */}
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="font-semibold text-sm">Mẫu request — copy rồi thay data</h2>
            <p className="text-xs text-muted-foreground mt-1">
              {freshToken
                ? "Token vừa tạo đã được điền sẵn vào các mẫu dưới đây."
                : "Chỗ cần thay đã ghi rõ. Tạo token mới thì mẫu sẽ tự điền token thật."}
            </p>
          </div>

          {API_SAMPLES.map((sample) => (
            <CodeBlock
              key={sample.id}
              title={sample.title}
              code={fillSample(sample.body, origin, freshToken?.token ?? null)}
            />
          ))}
        </section>

        <section className="flex flex-col gap-4">
          <div>
            <h2 className="font-semibold text-sm">
              Toàn bộ API của project ({countEndpoints()} endpoint)
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Nhóm theo <strong>cách xác thực</strong>, vì đó là thứ quyết định anh gọi
              được hay không. Chỉ nhóm đầu tiên nhận API token.
            </p>
          </div>

          {API_GROUPS.map((group) => (
            <div key={group.auth} className="rounded-lg border bg-card overflow-hidden">
              <div
                className={`px-4 py-3 border-b ${
                  group.auth === "token" ? "bg-primary/10" : "bg-muted/40"
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{group.title}</span>
                  <Badge variant={group.auth === "token" ? "success" : "outline"}>
                    {group.endpoints.length}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{group.note}</p>
              </div>

              <div className="divide-y">
                {group.endpoints.map((ep) => (
                  <div
                    key={ep.path}
                    className="px-4 py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1"
                  >
                    <span className="font-mono text-[11px] text-muted-foreground shrink-0 w-40">
                      {ep.methods.join(" ")}
                    </span>
                    <code className="font-mono text-xs shrink-0">{ep.path}</code>
                    <span className="text-xs text-muted-foreground">{ep.summary}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
