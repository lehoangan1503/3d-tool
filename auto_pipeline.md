# Cue Customizer — API tự động hoá cho AI agent

Hướng dẫn này dành cho một AI agent (hoặc n8n flow) làm việc này:
**nhận một file ảnh template → tạo sản phẩm gậy → render mockup/video → lấy link file về.**

Toàn bộ chỉ cần **1 API token duy nhất** cho mọi thao tác.

- Base URL: `https://3d.next.lc`
- Xác thực: header `Authorization: Bearer cue_live_...` trên **mọi** request
- Lấy token: đăng nhập dashboard → **Settings → API Token**

---

## Luồng 3 bước

```
1. POST /api/v1/products        gửi file template  → nhận product id
2. GET  /api/v1/render-targets  xem có gì để render → nhớ TÊN
3. POST /api/v1/renders         đặt render bằng tên → nhận job + status_url
4. GET  /api/v1/renders/{id}    poll đến khi xong   → lấy link file, TẢI VỀ NGAY
```

Bước 2 chỉ cần gọi **một lần** rồi ghi nhớ danh sách tên; không cần gọi lại mỗi
lần render.

---

## Bước 1 — Tạo sản phẩm từ file template

`POST /api/v1/products` · body dạng `multipart/form-data`

| Field | Bắt buộc | Ý nghĩa |
|---|---|---|
| `file` | **Có** | Ảnh template: `.jpg` / `.png` / `.webp`, tối đa **25MB** |
| `type` | **Có** | Loại gậy — xem bảng dưới |
| `name` | Không | Tên sản phẩm. Bỏ trống thì lấy tên file |
| `name_prefix` | Không | Tiền tố tên. Bỏ trống thì dùng tiền tố mặc định của token |

### Giá trị của `type`

| Gửi | Nghĩa | Cũng nhận |
|---|---|---|
| `leather` | Gậy da | `da`, `gậy da` |
| `smooth` | Gậy trơn | `tron`, `gậy trơn`, `plain` |
| `lizard` | Gậy da lizard | `da lizard`, `gậy da lizard` |

Không phân biệt chữ hoa/thường, có dấu hay không dấu.
**Thiếu `type` → lỗi 400**, API không bao giờ tự đoán loại gậy.

```bash
curl -X POST https://3d.next.lc/api/v1/products \
  -H "Authorization: Bearer $TOKEN" \
  -F file=@dragon-gold.jpg \
  -F type=leather
```

**Response `201`:**

```json
{
  "id": "3f9a1c22-7b41-4e8d-9c05-1a2b3c4d5e6f",
  "name": "n02-dragon-gold",
  "type": "leather",
  "surface_url": "https://.../surface.jpg",
  "created_at": "2026-09-07T10:22:31.512Z",
  "editor_url": "https://3d.next.lc/dashboard/products/3f9a1c22-..."
}
```

→ **Giữ lại `id`.** Bước 3 dùng nó.

---

## Bước 2 — Xem có gì để render

`GET /api/v1/render-targets`

```bash
curl https://3d.next.lc/api/v1/render-targets \
  -H "Authorization: Bearer $TOKEN"
```

**Response:**

```json
{
  "groups": [
    { "id": "037d5999-...", "name": "NOVERA-D", "reference_count": 6 }
  ],
  "references": [
    { "id": "627bb167-...", "name": "n02-4", "thumb_url": "https://..." }
  ],
  "video_templates": [
    { "id": "2232c923-...", "name": "test-neon" }
  ],
  "usage": { "...": "hướng dẫn gọi render, kèm ví dụ" }
}
```

Ba loại target:

| Loại | Là gì | Render ra |
|---|---|---|
| `groups` | Nhóm bố cục ảnh 2D đã lưu sẵn | 1 job, nhiều ảnh (= `reference_count`) |
| `references` | Từng bố cục ảnh 2D lẻ | 1 ảnh mỗi cái |
| `video_templates` | Template video studio 3D | 1 job, 1 video |

---

## Bước 3 — Đặt render

`POST /api/v1/renders` · body dạng JSON

| Field | Bắt buộc | Ý nghĩa |
|---|---|---|
| `product` | **Có** | Tên hoặc id sản phẩm |
| `products` | Không | Thêm sản phẩm khác — mọi target render cho từng cái |
| `groups` | — | Mảng tên/id nhóm ảnh |
| `references` | — | Mảng tên/id bố cục lẻ |
| `video_templates` | — | Mảng tên/id template video |
| `format` | Không | Ảnh: `png` (mặc định) hoặc `jpeg` |
| `quality` | Không | JPEG: `0.1`–`1`, mặc định `0.95` |
| `width` / `height` | Không | Video: mặc định `1920` / `1080`, tối đa `2560` |
| `fps` | Không | Video: mặc định `60`, khoảng `24`–`120` |

**Phải có ít nhất một trong `groups` / `references` / `video_templates`.**
Cả ba dùng được **cùng lúc** trong một request.

### Ví dụ: trộn cả 3 loại

```bash
curl -X POST https://3d.next.lc/api/v1/renders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "product": "3f9a1c22-7b41-4e8d-9c05-1a2b3c4d5e6f",
    "groups": ["NOVERA-D", "Ebay 1"],
    "references": ["n02-8"],
    "video_templates": ["test-neon"]
  }'
```

### Quy tắc thành job

- Mỗi **group** = 1 job
- Mỗi **video template** = 1 job
- **Tất cả** reference lẻ gộp thành **1 job** (không phải mỗi cái một job)
- Rồi **nhân với số sản phẩm**

Ví dụ trên: 2 group + 1 job reference + 1 video = **4 job**.
Nếu thêm `"products": ["gậy-thứ-2"]` → 4 × 2 = **8 job**.

**Response `202`:**

```json
{
  "jobs": [
    {
      "id": "9c1b7e40-...",
      "kind": "image",
      "status": "queued",
      "product_id": "3f9a1c22-...",
      "product_name": "n02-dragon-gold",
      "target": "NOVERA-D",
      "expected_files": 6,
      "created_at": "2026-09-07T10:24:02.104Z",
      "status_url": "https://3d.next.lc/api/v1/renders/9c1b7e40-..."
    }
  ]
}
```

→ **Giữ `status_url` của TỪNG job.** Mỗi job poll riêng.

---

## Bước 4 — Poll và tải file

`GET /api/v1/renders/{jobId}`

```bash
curl https://3d.next.lc/api/v1/renders/9c1b7e40-... \
  -H "Authorization: Bearer $TOKEN"
```

**Response khi xong:**

```json
{
  "id": "9c1b7e40-...",
  "kind": "image",
  "status": "succeeded",
  "percent": 100,
  "product_name": "n02-dragon-gold",
  "target": "NOVERA-D",
  "error": null,
  "finished_at": "2026-09-07T10:25:47.882Z",
  "files": [
    {
      "name": "Mockup-Web-1",
      "url": "https://.../Mockup-Web-1.png",
      "width": 2048, "height": 2048, "bytes": 3814912
    }
  ],
  "expires_at": "2026-09-08T10:25:47.882Z",
  "expired": false
}
```

### `status` có thể là

| Giá trị | Nghĩa | Agent làm gì |
|---|---|---|
| `queued` | Đang chờ GPU | Poll tiếp |
| `running` | Đang render (xem `percent`) | Poll tiếp |
| `succeeded` | Xong | Đọc `files[]`, **tải về ngay** |
| `failed` | Lỗi — lý do trong `error` | Ghi log, có thể gọi lại |
| `canceled` | Bị huỷ | Dừng |

**Nhịp poll:** mỗi **5–10 giây**. Ảnh thường xong trong vài chục giây đến ~2 phút;
video có thể vài phút.

### ⚠️ File KHÔNG tự tải về

API **chỉ trả link**. Agent phải tự tải.

**File chỉ sống 24 giờ** kể từ lúc render xong (`expires_at` ghi rõ thời điểm).
Sau đó bị dọn, `files` thành rỗng và `expired: true` → phải render lại.
**Tải ngay khi `status: "succeeded"`, đừng để dành.**

Link là public URL — tải không cần token:

```bash
curl -s https://3d.next.lc/api/v1/renders/$JOB_ID \
  -H "Authorization: Bearer $TOKEN" \
| python3 -c "import json,sys;[print(f['url']) for f in json.load(sys.stdin)['files']]" \
| xargs -n1 -P4 curl -sO
```

---

## Quy tắc gọi tên target

Target nhận **tên** hoặc **id**. Dùng tên là cách thường dùng — không phân biệt
chữ hoa/thường, có dấu hay không dấu:

```
"NOVERA-D"  ✓      "novera-d"  ✓      "037d5999-f988-47a8-aeee-54139f84103b"  ✓
```

### Khi tên bị trùng

Nhiều bố cục có thể **cùng tên** (ví dụ có 3 cái tên `n02-4`). Lúc đó API
**không tự chọn** — nó trả lỗi `400` kèm danh sách id:

```json
{
  "error": "More than one reference is called \"n02-4\". Send one of these ids instead: 627bb167-..., dd5c724b-..., 7027a39b-..."
}
```

**Agent xử lý:** không tự đoán. Báo lại cho người dùng kèm danh sách id đó để họ
chọn, rồi gọi lại bằng **id**. (Trong dashboard, mỗi card có nút copy id hiện 4
ký tự cuối — người dùng đối chiếu ảnh rồi copy id đúng.)

### Khi tên không tồn tại

Lỗi `404` kèm **danh sách tên có sẵn** — dùng nó để sửa, không cần gọi lại
`/render-targets`:

```json
{
  "error": "image group not found: \"Novera D\". Available: Banner, banner1, b-details, Ebay 1, NOVERA-D, ..."
}
```

---

## Giới hạn

| Giới hạn | Giá trị |
|---|---|
| File template | 25 MB, chỉ JPEG / PNG / WebP |
| Sản phẩm mỗi request (render ảnh) | 20 |
| Sản phẩm mỗi request (render video) | 10 |
| Tổng job mỗi request | **60** (= số target × số sản phẩm) |
| Kích thước video | tối đa 2560 × 2560 |
| Thời gian giữ file render | **24 giờ** sau khi xong |

Vượt giới hạn job thì lỗi nói rõ con số:

```
That would queue 80 jobs (8 targets x 10 products); the limit is 60. Split it into several requests.
```

→ Chia thành nhiều request nhỏ hơn.

---

## Mã lỗi

| Mã | Nghĩa | Agent làm gì |
|---|---|---|
| `201` | Tạo sản phẩm xong | Lấy `id` |
| `202` | Render đã vào hàng đợi (**không phải lỗi**) | Poll `status_url` |
| `400` | Thiếu field, `type` sai, tên trùng, hoặc quá nhiều job | Đọc `error` và sửa body |
| `401` | Token sai / đã thu hồi / thiếu header | Dừng, báo người dùng |
| `404` | Không tìm thấy sản phẩm / target / job | Đọc danh sách trong `error` rồi sửa tên |
| `413` | File > 25MB | Nén ảnh nhỏ lại |
| `500` | Lỗi server | Thử lại sau |
| `502` | Không lưu được ảnh (sản phẩm đã rollback) | Gọi lại được ngay |
| `503` | Không kiểm tra được token | Thử lại sau |

---

## Lưu ý quan trọng

- **Token thường chỉ render được sản phẩm của chính chủ token.** Sản phẩm của
  người khác trả `404 Product not found` — kể cả khi gửi đúng id. Nếu gặp lỗi này
  mà chắc chắn id đúng, nghĩa là đang dùng sai token.
- **Token của admin render được sản phẩm của cả team** (giống quyền admin trong
  dashboard). Nhưng job và file render **vẫn thuộc về chủ token**, không thuộc chủ
  sản phẩm — nên chỉ token đó đọc được `status_url` của job đó.
- **Nhóm ảnh, bố cục lẻ và template video là dùng chung cả team** — mọi token đều
  thấy và render được. Chỉ *sản phẩm* mới thuộc riêng từng người.
- **Không có webhook.** Agent phải tự poll `status_url`.
- **Mỗi job poll riêng.** Một request render nhiều target trả về nhiều job, chúng
  chạy song song và xong không cùng lúc.
- Một job `failed` **không** làm các job khác trong cùng request thất bại.

---

## Ví dụ hoàn chỉnh (bash)

> Chạy bằng **bash**, không phải zsh — vòng `for JOB in $JOBS` cần bash để tách
> danh sách job id. Lưu thành file rồi `bash pipeline.sh`.

```bash
#!/usr/bin/env bash
set -euo pipefail

TOKEN="cue_live_..."
BASE="https://3d.next.lc"

# 1. Tạo sản phẩm
PRODUCT=$(curl -s -X POST "$BASE/api/v1/products" \
  -H "Authorization: Bearer $TOKEN" \
  -F file=@dragon-gold.jpg \
  -F type=leather \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "Sản phẩm: $PRODUCT"

# 2. Đặt render (nhóm ảnh + video)
JOBS=$(curl -s -X POST "$BASE/api/v1/renders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"product\":\"$PRODUCT\",\"groups\":[\"NOVERA-D\"],\"video_templates\":[\"test-neon\"]}" \
  | python3 -c "import json,sys; print(' '.join(j['id'] for j in json.load(sys.stdin)['jobs']))")
echo "Job: $JOBS"

# 3. Poll rồi tải
for JOB in $JOBS; do
  while true; do
    RES=$(curl -s "$BASE/api/v1/renders/$JOB" -H "Authorization: Bearer $TOKEN")
    ST=$(echo "$RES" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
    echo "$JOB → $ST"
    case "$ST" in
      succeeded)
        echo "$RES" | python3 -c "import json,sys;[print(f['url']) for f in json.load(sys.stdin)['files']]" \
          | xargs -n1 -P4 curl -sO
        break ;;
      failed|canceled)
        echo "$RES" | python3 -c "import json,sys; print('LỖI:', json.load(sys.stdin)['error'])"
        break ;;
      *) sleep 8 ;;
    esac
  done
done
```
