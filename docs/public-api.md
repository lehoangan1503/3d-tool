# API công khai — tạo sản phẩm từ bên ngoài

Dùng khi template được làm **ngoài app** (thường là AI sinh ra `surface.jpg`) và
muốn đưa thẳng vào thành sản phẩm, không cần mở dashboard.

Trước đây phải làm tay 2 bước: tạo sản phẩm mới → upload template vào. API này
gộp lại thành **1 request**, và **token mang sẵn config** nên không cần khai gì
ngoài file ảnh.

---

## 1. Tạo token

Dashboard → menu người dùng (góc phải) → **API Token** → *Tạo token mới*.

Mỗi token gồm 3 thứ:

| Trường | Ví dụ | Ý nghĩa |
|---|---|---|
| Tên gợi nhớ | `AI tạo gậy da` | Chỉ để anh nhìn danh sách cho dễ |
| Loại gậy | `Gậy da` | **Đóng cứng** vào token — mọi sản phẩm token này tạo đều là loại đó |
| Tiền tố tên | `n02` | Dán vào đầu tên sản phẩm: `n02-dragon-gold` |

> **Tạo mỗi loại gậy một token riêng.** Đó là điểm chính của thiết kế: token A
> luôn ra gậy da, token B luôn ra gậy trơn. Bên gọi API không bao giờ phải khai
> loại gậy, nên **không bao giờ khai sai** — quan trọng khi bên gọi là AI.

Token hiện **đúng một lần** lúc tạo. Hệ thống chỉ lưu bản băm (SHA-256), nên mất
thì phải tạo cái mới — không có cách xem lại.

---

## 2. Gọi API

```
POST /api/v1/products
Authorization: Bearer cue_live_xxxxxxxx
Content-Type: multipart/form-data
```

| Field | Bắt buộc | Ghi chú |
|---|---|---|
| `file` | ✅ | Ảnh template. JPEG / PNG / WebP, tối đa 25MB |
| `name` | ❌ | Ghi đè tên. Không gửi thì lấy tên file |

```bash
curl -X POST https://app-cua-anh.com/api/v1/products \
  -H "Authorization: Bearer cue_live_xxxxxxxx" \
  -F file=@dragon-gold.jpg
```

Trả về `201`:

```json
{
  "id": "3f9a1c22-....",
  "name": "n02-dragon-gold",
  "type": "leather",
  "surface_url": "https://....supabase.co/storage/v1/object/public/product-assets/...",
  "created_at": "2026-09-07T10:22:31.512Z",
  "editor_url": "https://app-cua-anh.com/dashboard/products/3f9a1c22-...."
}
```

Mở `editor_url` là thấy sản phẩm với template đã dán lên gậy 3D. Sản phẩm này
**giống hệt** một sản phẩm tạo tay — render GPU, deploy Shopify, mọi thứ dùng
được bình thường.

### Tên sản phẩm được tính thế nào

```
tiền tố token  +  tên file (bỏ đuôi, bỏ dấu, chữ thường)
```

| Tiền tố | File gửi lên | Tên sản phẩm |
|---|---|---|
| `n02` | `dragon-gold.jpg` | `n02-dragon-gold` |
| `n02` | `Rồng Vàng 01.png` | `n02-rồng-vàng-01` |
| `n02` | `n02-dragon.jpg` | `n02-dragon` (không nhân đôi tiền tố) |
| *(trống)* | `dragon.jpg` | `dragon` |

---

## 3. Lỗi

| Mã | Nghĩa |
|---|---|
| `400` | Thiếu field `file`, sai định dạng ảnh, hoặc body không phải multipart |
| `401` | Token sai, đã thu hồi, hoặc thiếu header `Authorization` |
| `413` | File lớn hơn 25MB |
| `500` | Lỗi phía server — xem log, không phải lỗi request |
| `502` | Không lưu được ảnh lên Storage. Sản phẩm đã được rollback, gọi lại được |
| `503` | Không kiểm tra được token (database) |

`401` **luôn trả cùng một thông điệp** cho mọi nguyên nhân. Cố ý: phân biệt
"không tồn tại" với "đã thu hồi" sẽ cho người dò token biết đoán nào từng đúng.

---

## 4. Bảo mật

- Token chỉ làm được **đúng những gì chủ token làm được**. Không có quyền đọc
  sản phẩm của người khác, không có quyền admin.
- Chỉ lưu SHA-256 của token. Rò database không cho ai token dùng được.
- **Thu hồi** (revoke) có hiệu lực ngay lập tức, kiểm tra ở mỗi request. Muốn
  giữ lịch sử thì thu hồi; muốn xoá sạch thì Delete.
- Cột `Dùng lần cuối` trong danh sách trả lời "token này còn ai dùng không?"
  trước khi thu hồi.
- Đổi secret = tạo token mới rồi xoá cái cũ. Không có nút "rotate", để token cũ
  giữ được lịch sử dùng của chính nó.

---

## 5. Chưa có (và vì sao)

**API chưa render.** Nó tạo sản phẩm, chưa bắn mockup/video. Anh vào app bấm
render như bình thường.

Lý do tách: render tốn tiền GPU thật và mất vài phút, nên không thể trả file
ngay trong một request — sẽ cần thêm cơ chế poll job hoặc webhook. Làm sau, khi
đường tạo sản phẩm đã chạy ổn. Hạ tầng job đã có sẵn (`render_jobs`, xem
`docs/render-gpu-setup.md`), nên thêm vào là mở rộng chứ không phải làm lại.
