/**
 * Catalogue of every HTTP endpoint this project exposes.
 *
 * Written for the API-token settings page, where the question being answered is
 * "what can I call, and with what?" — so the grouping is by AUTHENTICATION, not
 * by feature. That distinction is the whole point of the list: of ~49 routes,
 * exactly one accepts an API token. The rest need a browser session or the GPU
 * worker's shared secret, and pasting one of those into an external tool
 * produces a 401 that looks like a broken token.
 *
 * Kept as data rather than prose so the page can render copyable request
 * samples from it. Hand-maintained: it is documentation, and a generated list
 * would lose the "what is this for" column that makes it worth reading.
 * Verified against `src/app/api/**\/route.ts` on 2026-09-07.
 */

/** How a caller proves who they are. */
export type ApiAuthKind = "token" | "session" | "worker";

export interface ApiEndpoint {
  /** HTTP methods this route exports. */
  readonly methods: readonly string[];
  readonly path: string;
  /** What it does, in Vietnamese — this list is read by the operator. */
  readonly summary: string;
}

export interface ApiGroup {
  readonly auth: ApiAuthKind;
  readonly title: string;
  /** Why this group is or is not callable from outside. */
  readonly note: string;
  readonly endpoints: readonly ApiEndpoint[];
}

/**
 * A ready-to-edit request body, shown so the caller replaces values rather than
 * inventing a shape.
 *
 * `curl` is given for the multipart route because a JSON body cannot express a
 * file upload — showing JSON there would be actively misleading.
 */
export interface ApiSample {
  readonly id: string;
  readonly title: string;
  readonly language: "bash" | "json";
  /** `__ORIGIN__` is replaced with the live origin at render time. */
  readonly body: string;
}

export const API_GROUPS: readonly ApiGroup[] = [
  {
    auth: "token",
    title: "Gọi được từ bên ngoài (API token)",
    note:
      "Chỉ nhóm này nhận header Authorization: Bearer. Dùng cho AI, script, n8n, " +
      "hoặc bất cứ thứ gì không chạy trong browser.",
    endpoints: [
      {
        methods: ["POST"],
        path: "/api/v1/products",
        summary: "Gửi 1 file template → tạo sản phẩm mới (loại gậy + tiền tố lấy từ token)",
      },
    ],
  },
  {
    auth: "session",
    title: "Chỉ dùng được trong app (session cookie)",
    note:
      "Những route dashboard tự gọi. Xác thực bằng cookie đăng nhập, nên KHÔNG " +
      "gọi được bằng API token — bắn Bearer vào đây sẽ trả 401. Liệt kê ở đây để " +
      "biết app có sẵn những gì.",
    endpoints: [
      { methods: ["GET", "POST"], path: "/api/products", summary: "Danh sách / tạo sản phẩm" },
      { methods: ["GET", "PUT", "DELETE"], path: "/api/products/[id]", summary: "Xem / sửa / xoá một sản phẩm" },
      { methods: ["POST"], path: "/api/products/[id]/asset", summary: "Upload asset cho sản phẩm" },
      { methods: ["POST"], path: "/api/products/[id]/clone", summary: "Nhân bản sản phẩm" },
      { methods: ["GET"], path: "/api/products/[id]/settings", summary: "Cấu hình 3D của sản phẩm" },
      { methods: ["GET", "POST"], path: "/api/products/[id]/renders", summary: "Ảnh mockup đã render của sản phẩm" },
      { methods: ["GET", "POST"], path: "/api/products/[id]/videos", summary: "Video đã render của sản phẩm" },
      { methods: ["POST"], path: "/api/upload", summary: "Upload surface / texture cho sản phẩm" },
      { methods: ["POST"], path: "/api/upload-overlay", summary: "Upload ảnh overlay" },
      { methods: ["POST"], path: "/api/convert-cmyk", summary: "Chuyển ảnh CMYK sang RGB" },
      { methods: ["GET", "DELETE"], path: "/api/storage-images", summary: "Quản lý ảnh trong Storage" },

      { methods: ["GET"], path: "/api/render-jobs", summary: "Hàng đợi render của tôi" },
      { methods: ["GET", "DELETE"], path: "/api/render-jobs/[jobId]", summary: "Xem / huỷ một job render" },
      { methods: ["POST"], path: "/api/render-jobs/[jobId]/retry", summary: "Chạy lại job thất bại" },
      { methods: ["POST"], path: "/api/render-jobs/[jobId]/remove", summary: "Xoá job khỏi danh sách" },

      { methods: ["GET", "POST"], path: "/api/extractor-references", summary: "Reference ảnh (khung chụp mockup)" },
      { methods: ["GET", "PUT", "DELETE"], path: "/api/extractor-references/[id]", summary: "Xem / sửa / xoá reference" },
      { methods: ["POST"], path: "/api/extractor-references/[id]/thumbnail", summary: "Tạo thumbnail cho reference" },
      { methods: ["GET"], path: "/api/extractor-references/summary", summary: "Tóm tắt reference" },
      { methods: ["GET", "POST"], path: "/api/extractor-reference-groups", summary: "Nhóm reference" },
      { methods: ["PUT", "DELETE"], path: "/api/extractor-reference-groups/[id]", summary: "Sửa / xoá nhóm reference" },
      { methods: ["GET", "POST"], path: "/api/extractor-presets", summary: "Preset của extractor" },
      { methods: ["GET", "POST"], path: "/api/image-ratios", summary: "Tỉ lệ ảnh dùng khi render" },

      { methods: ["GET", "POST"], path: "/api/video-studio-templates", summary: "Template video studio" },
      { methods: ["GET", "PUT", "DELETE"], path: "/api/video-studio-templates/[id]", summary: "Sửa / xoá template video" },
      { methods: ["GET", "POST"], path: "/api/shadow-config-templates", summary: "Template cấu hình bóng" },
      { methods: ["GET", "PUT", "DELETE"], path: "/api/shadow-config-templates/[id]", summary: "Sửa / xoá template bóng" },
      { methods: ["GET"], path: "/api/hdri", summary: "Danh sách HDRI" },
      { methods: ["GET"], path: "/api/settings", summary: "Cấu hình Three.js mặc định" },
      { methods: ["GET", "POST"], path: "/api/silver-config", summary: "Cấu hình phần bạc" },

      { methods: ["GET", "POST", "PUT", "DELETE"], path: "/api/shopify/deploy-templates", summary: "Template triển khai Shopify" },
      { methods: ["POST", "DELETE"], path: "/api/shopify/create-product", summary: "Đẩy sản phẩm lên Shopify" },
      { methods: ["GET"], path: "/api/shopify/deployment", summary: "Trạng thái đã deploy" },
      { methods: ["POST"], path: "/api/shopify/save-draft", summary: "Lưu bản nháp deploy" },
      { methods: ["GET", "POST"], path: "/api/shopify/collections", summary: "Collection trong app" },
      { methods: ["GET"], path: "/api/shopify/collections/shopify", summary: "Collection lấy từ Shopify" },
      { methods: ["GET"], path: "/api/shopify/stores", summary: "Danh sách store" },
      { methods: ["GET", "POST"], path: "/api/shopify/generate-content", summary: "Sinh nội dung sản phẩm bằng AI" },
      { methods: ["GET", "POST", "PUT", "DELETE"], path: "/api/shopify/skills", summary: "Skill dùng cho sinh nội dung" },

      { methods: ["GET", "PUT"], path: "/api/profile", summary: "Thông tin cá nhân / biệt danh" },
      { methods: ["GET", "POST"], path: "/api/api-tokens", summary: "Danh sách / tạo API token (chính trang này)" },
      { methods: ["PATCH", "DELETE"], path: "/api/api-tokens/[id]", summary: "Thu hồi / xoá API token" },
    ],
  },
  {
    auth: "worker",
    title: "Dành riêng cho GPU worker (secret riêng)",
    note:
      "Pod render trên RunPod dùng RENDER_WORKER_SECRET, không phải token của " +
      "người dùng. Đừng gọi tay — nó ghi trực tiếp vào job của người khác.",
    endpoints: [
      { methods: ["POST"], path: "/api/render-worker/claim", summary: "Pod nhận job từ hàng đợi" },
      { methods: ["PATCH"], path: "/api/render-worker/[jobId]/progress", summary: "Báo tiến độ render" },
      { methods: ["POST"], path: "/api/render-worker/[jobId]/upload", summary: "Nộp file đã render" },
      { methods: ["POST"], path: "/api/render-worker/[jobId]/complete", summary: "Đánh dấu job xong" },
      { methods: ["GET"], path: "/api/render-worker/queue-depth", summary: "Độ sâu hàng đợi (quyết định có nhận thêm job)" },
      { methods: ["POST"], path: "/api/render-worker/purge", summary: "Dọn file render đã hết hạn" },
    ],
  },
];

/**
 * Copyable samples.
 *
 * The token route comes first and gets both a curl and a JSON form, because it
 * is the one an external caller actually uses. `__TOKEN__` is substituted with
 * a real token when the page has just minted one, so the sample is runnable as
 * pasted instead of needing two edits.
 */
export const API_SAMPLES: readonly ApiSample[] = [
  {
    id: "curl-create-product",
    title: "Tạo sản phẩm từ file template (curl)",
    language: "bash",
    body: `curl -X POST __ORIGIN__/api/v1/products \\
  -H "Authorization: Bearer __TOKEN__" \\
  -F file=@surface.jpg`,
  },
  {
    id: "curl-create-product-named",
    title: "Tạo sản phẩm, tự đặt tên (curl)",
    language: "bash",
    body: `curl -X POST __ORIGIN__/api/v1/products \\
  -H "Authorization: Bearer __TOKEN__" \\
  -F file=@surface.jpg \\
  -F name="Dragon Gold"`,
  },
  {
    id: "json-request-spec",
    title: "Mô tả request (JSON) — thay giá trị rồi đưa cho AI/n8n",
    language: "json",
    body: `{
  "method": "POST",
  "url": "__ORIGIN__/api/v1/products",
  "headers": {
    "Authorization": "Bearer __TOKEN__"
  },
  "body": {
    "type": "multipart/form-data",
    "fields": {
      "file": "<đường dẫn file ảnh: .jpg / .png / .webp, tối đa 25MB>",
      "name": "<tuỳ chọn — bỏ trống thì lấy tên file>"
    }
  }
}`,
  },
  {
    id: "json-response",
    title: "Response khi thành công (201)",
    language: "json",
    body: `{
  "id": "3f9a1c22-7b41-4e8d-9c05-1a2b3c4d5e6f",
  "name": "n02-dragon-gold",
  "type": "leather",
  "surface_url": "https://<project>.supabase.co/storage/v1/object/public/product-assets/<user>/<product>/surface.jpg",
  "created_at": "2026-09-07T10:22:31.512Z",
  "editor_url": "__ORIGIN__/dashboard/products/3f9a1c22-7b41-4e8d-9c05-1a2b3c4d5e6f"
}`,
  },
  {
    id: "json-errors",
    title: "Các mã lỗi",
    language: "json",
    body: `{
  "400": "Thiếu field file, sai định dạng ảnh, hoặc body không phải multipart",
  "401": "Token sai, đã thu hồi, hoặc thiếu header Authorization",
  "413": "File lớn hơn 25MB",
  "500": "Lỗi phía server",
  "502": "Không lưu được ảnh lên Storage (sản phẩm đã được rollback, gọi lại được)",
  "503": "Không kiểm tra được token (database)"
}`,
  },
];

/** Fills in the live origin, and a real token when one was just created. */
export function fillSample(body: string, origin: string, token: string | null): string {
  return body
    .replaceAll("__ORIGIN__", origin)
    .replaceAll("__TOKEN__", token ?? "cue_live_xxxxxxxxxxxxxxxx");
}

/** Total endpoint count, for the section heading. */
export function countEndpoints(): number {
  return API_GROUPS.reduce((sum, g) => sum + g.endpoints.length, 0);
}
