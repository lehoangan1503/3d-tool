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
 *
 * The allowed `type` values get a block of their own rather than a line of
 * prose: it is the one field the caller must fill in per template, and the
 * people wiring up n8n copy a block far more reliably than they read a
 * sentence.
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
      "hoặc bất cứ thứ gì không chạy trong browser. Token chỉ để xác thực — loại " +
      "gậy khai trong field type của request.",
    endpoints: [
      {
        methods: ["POST"],
        path: "/api/v1/products",
        summary:
          "Gửi file ảnh + type (leather / smooth / lizard) → tạo sản phẩm mới. " +
          "Một token dùng cho mọi loại gậy.",
      },
      {
        methods: ["GET"],
        path: "/api/v1/render-targets",
        summary:
          "Danh sách nhóm ảnh 2D, reference 2D lẻ và template video 3D — kèm tên để gọi render",
      },
      {
        methods: ["POST"],
        path: "/api/v1/renders",
        summary:
          "Đặt render mockup / video. Chỉ cần ĐỀ CẬP TÊN — trộn nhiều nhóm + " +
          "reference lẻ + template video trong 1 request",
      },
      {
        methods: ["GET"],
        path: "/api/v1/renders/[jobId]",
        summary: "Hỏi tiến độ + lấy link file khi render xong",
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
  -F file=@surface.jpg \\
  -F type=leather`,
  },
  {
    id: "type-values",
    title: "Giá trị của field type — chỉ cần đổi đúng dòng này",
    language: "json",
    body: `{
  "leather": "Gậy da        — gửi: leather | da | gay da",
  "smooth":  "Gậy trơn      — gửi: smooth  | tron | gay tron",
  "lizard":  "Gậy da lizard — gửi: lizard  | da lizard | gay da lizard",
  "_ghi_chú": "Không phân biệt chữ hoa/thường, có dấu hay không dấu đều nhận. Thiếu type → lỗi 400."
}`,
  },
  {
    id: "curl-create-product-named",
    title: "Tạo sản phẩm, tự đặt tên + tiền tố riêng (curl)",
    language: "bash",
    body: `curl -X POST __ORIGIN__/api/v1/products \\
  -H "Authorization: Bearer __TOKEN__" \\
  -F file=@surface.jpg \\
  -F type=smooth \\
  -F name="Dragon Gold" \\
  -F name_prefix=n02`,
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
      "type": "<BẮT BUỘC — leather (gậy da) | smooth (gậy trơn) | lizard (gậy da lizard)>",
      "name": "<tuỳ chọn — bỏ trống thì lấy tên file>",
      "name_prefix": "<tuỳ chọn — bỏ trống thì lấy tiền tố mặc định của token>"
    }
  }
}`,
  },
  {
    id: "curl-render-targets",
    title: "Xem có những gì để render (curl)",
    language: "bash",
    body: `curl __ORIGIN__/api/v1/render-targets \\
  -H "Authorization: Bearer __TOKEN__"`,
  },
  {
    id: "curl-render-group",
    title: "Render nhóm ảnh 2D — chỉ cần tên nhóm (curl)",
    language: "bash",
    body: `curl -X POST __ORIGIN__/api/v1/renders \\
  -H "Authorization: Bearer __TOKEN__" \\
  -H "Content-Type: application/json" \\
  -d '{"product": "n02-dragon-gold", "groups": ["NOVERA-D"]}'`,
  },
  {
    id: "curl-render-mixed",
    title: "Trộn tất cả trong 1 request — nhiều nhóm + reference lẻ + video (curl)",
    language: "bash",
    body: `curl -X POST __ORIGIN__/api/v1/renders \\
  -H "Authorization: Bearer __TOKEN__" \\
  -H "Content-Type: application/json" \\
  -d '{
    "product": "n02-dragon-gold",
    "groups": ["NOVERA-D", "Ebay 1"],
    "references": ["BAN1", "banner1"],
    "video_templates": ["Studio quay tròn"]
  }'`,
  },
  {
    id: "json-render-fanout",
    title: "Trộn target thì ra bao nhiêu job?",
    language: "json",
    body: `{
  "_quy_tắc": "Mỗi nhóm = 1 job. Mỗi template video = 1 job. TẤT CẢ reference lẻ gộp thành 1 job.",
  "_nhân_với_sản_phẩm": "Gửi thêm products[] thì mỗi target render cho từng sản phẩm (tối đa 60 job / request).",
  "_ví_dụ": {
    "request": {
      "product": "n02-dragon-gold",
      "products": ["n02-tiger-blue"],
      "groups": ["NOVERA-D", "Ebay 1"],
      "references": ["BAN1", "banner1"],
      "video_templates": ["Studio quay tròn"]
    },
    "ra": "4 target x 2 sản phẩm = 8 job",
    "chi_tiết": [
      "NOVERA-D          → n02-dragon-gold, n02-tiger-blue",
      "Ebay 1            → n02-dragon-gold, n02-tiger-blue",
      "BAN1 + banner1    → n02-dragon-gold, n02-tiger-blue  (1 job/sản phẩm, 2 ảnh)",
      "Studio quay tròn  → n02-dragon-gold, n02-tiger-blue"
    ]
  }
}`,
  },
  {
    id: "json-render-spec",
    title: "Mô tả request render (JSON) — đưa cho AI/n8n",
    language: "json",
    body: `{
  "method": "POST",
  "url": "__ORIGIN__/api/v1/renders",
  "headers": {
    "Authorization": "Bearer __TOKEN__",
    "Content-Type": "application/json"
  },
  "body": {
    "product": "<BẮT BUỘC — tên hoặc id sản phẩm vừa tạo>",
    "products": "<tuỳ chọn — thêm sản phẩm khác, mọi target render cho từng cái>",

    "_ba_dòng_dưới_dùng_được_CÙNG_LÚC": "khai cái nào có, bỏ trống cái không cần",
    "groups": ["<tên nhóm ảnh 2D>", "<...>"],
    "references": ["<tên reference 2D lẻ>", "<...>"],
    "video_templates": ["<tên template video 3D>", "<...>"],

    "format": "<ảnh: png (mặc định) | jpeg>",
    "quality": "<ảnh jpeg: 0.1-1, mặc định 0.95>",
    "width": "<video: mặc định 1920>",
    "height": "<video: mặc định 1080>",
    "fps": "<video: mặc định 60>"
  },
  "_ghi_chú": "Tên lấy từ GET /api/v1/render-targets. Không phân biệt hoa/thường, có dấu hay không dấu. Tên trùng nhau → lỗi 400 kèm danh sách id để chọn."
}`,
  },
  {
    id: "json-render-response",
    title: "Response khi đặt render (202) — mỗi target 1 job, rồi poll status_url",
    language: "json",
    body: `{
  "jobs": [
    {
      "id": "9c1b7e40-2a55-4f10-8b3d-6e2f1a4c9d70",
      "kind": "image",
      "status": "queued",
      "product_id": "3f9a1c22-7b41-4e8d-9c05-1a2b3c4d5e6f",
      "product_name": "n02-dragon-gold",
      "target": "NOVERA-D",
      "expected_files": 6,
      "created_at": "2026-09-07T10:24:02.104Z",
      "status_url": "__ORIGIN__/api/v1/renders/9c1b7e40-2a55-4f10-8b3d-6e2f1a4c9d70"
    },
    {
      "id": "a4d2f118-7c93-4a6e-b201-58ff3c9e1d24",
      "kind": "image",
      "status": "queued",
      "product_id": "3f9a1c22-7b41-4e8d-9c05-1a2b3c4d5e6f",
      "product_name": "n02-dragon-gold",
      "target": "BAN1, banner1",
      "expected_files": 2,
      "created_at": "2026-09-07T10:24:02.104Z",
      "status_url": "__ORIGIN__/api/v1/renders/a4d2f118-7c93-4a6e-b201-58ff3c9e1d24"
    },
    {
      "id": "c7e01a83-6b24-4d95-9f38-2ab5e14c7d60",
      "kind": "video",
      "status": "queued",
      "product_id": "3f9a1c22-7b41-4e8d-9c05-1a2b3c4d5e6f",
      "product_name": "n02-dragon-gold",
      "target": "Studio quay tròn",
      "expected_files": 1,
      "created_at": "2026-09-07T10:24:02.312Z",
      "status_url": "__ORIGIN__/api/v1/renders/c7e01a83-6b24-4d95-9f38-2ab5e14c7d60"
    }
  ]
}`,
  },
  {
    id: "json-render-status",
    title: "Poll status_url — xong thì có link file",
    language: "json",
    body: `{
  "id": "9c1b7e40-2a55-4f10-8b3d-6e2f1a4c9d70",
  "kind": "image",
  "status": "succeeded",
  "percent": 100,
  "product_id": "3f9a1c22-7b41-4e8d-9c05-1a2b3c4d5e6f",
  "product_name": "n02-dragon-gold",
  "target": "NOVERA-D",
  "error": null,
  "created_at": "2026-09-07T10:24:02.104Z",
  "finished_at": "2026-09-07T10:25:47.882Z",
  "files": [
    { "name": "Mockup-Web-1", "url": "https://…/Mockup-Web-1.png", "width": 2048, "height": 2048, "bytes": 3814912 }
  ],
  "expires_at": "2026-09-08T10:25:47.882Z",
  "expired": false
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
  "_tạo_sản_phẩm": {
    "400": "Thiếu field file hoặc type, type không hợp lệ, sai định dạng ảnh, hoặc body không phải multipart",
    "413": "File lớn hơn 25MB",
    "502": "Không lưu được ảnh lên Storage (sản phẩm đã được rollback, gọi lại được)"
  },
  "_đặt_render": {
    "400": "Không khai target nào, tên bị trùng (kèm danh sách id), hoặc quá nhiều job (>60 = target x sản phẩm)",
    "404": "Không tìm thấy sản phẩm / nhóm / reference / template — response liệt kê các tên có sẵn",
    "202": "Đã vào hàng đợi (không phải lỗi) — poll status_url để lấy file"
  },
  "_chung": {
    "401": "Token sai, đã thu hồi, hoặc thiếu header Authorization",
    "500": "Lỗi phía server",
    "503": "Không kiểm tra được token (database)"
  }
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
