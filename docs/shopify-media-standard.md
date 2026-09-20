# Chuẩn ảnh Shopify — tên file nào vào đâu, và cách tự sửa khi thiếu

Tài liệu này là **nguồn chuẩn duy nhất** cho câu hỏi: *"một sản phẩm trên store
đáng lẽ phải có những ảnh nào, và ảnh đang thiếu tên là gì?"*

Viết cho **agent** đọc. Một agent được đưa ảnh chụp màn hình và câu "sản phẩm này
thiếu ảnh" chỉ cần tài liệu này + 3 API ở mục 4 là đủ để tự sửa xong.

---

## 1. Quy ước tên ảnh

Mọi ảnh render ra đều có **tên reference** (`Mockup-Web-1`, `Details-3`,
`Package-2`). Tên đó — không phải thư mục, không phải thứ tự upload — quyết định
ảnh đi đâu khi deploy.

| Tên ảnh | Đích đến trên Shopify |
|---|---|
| `Mockup-Web-N` | Ảnh gallery (ảnh sản phẩm), xếp theo N tăng dần |
| `Mockup-Web-<Nhãn>N` | Cũng là ảnh gallery — nhãn thương hiệu được phép, vd `Mockup-Web-Novera4` |
| `Mockup-Web-N-Standard` / `-Pro` | Ảnh gallery theo version |
| `Details-N` | Metafield `custom.details_N` |
| `Details-N-Standard` | Metafield `custom.details_N_standard` |
| `Details-N-Premium` | Metafield `custom.details_N_premium` |
| `Details-N-Pro` | Metafield `custom.details_N_pro` |
| `Package-1-Standard` | Metafield `custom.package_product_standard` |
| `Package-1-Pro` | Metafield `custom.package_product_pro` |
| `Package-2` | Metafield `custom.package_box` |
| Tên khác | **Bị bỏ qua** khi deploy |

> Ảnh metafield **không nằm trong gallery**. Đây là lý do một ảnh có thể "biến
> mất" mà nhìn ở Shopify admin không thấy gì bất thường: gallery vẫn đủ, chỉ
> metafield trống. Trên storefront thì ô ảnh đó trắng — đúng như ảnh chụp màn
> hình khu vực `PACKAGE VIEW`.

Luật riêng cho `Mockup-Web-2` và `Mockup-Web-5`: khi có nhiều bản version, deploy
chỉ chọn **một** theo thứ tự ưu tiên `Pro > Premium(dùng ảnh Standard) >
Standard`.

Quy tắc version: cue chỉ có `Standard` thì **không** cần `Package-1-Pro`; cue
`Premium` dùng ảnh `Standard` (tức là **vẫn phải có `Package-1-Standard`**). API
soát ảnh đã áp dụng đúng luật này nên không báo nhầm.

### Quy tắc đặt tên chính xác

| | Ảnh gallery | Ảnh metafield |
|---|---|---|
| Regex | `^Mockup-Web-(?:[A-Za-z]+)?(\d+(?:\.\d+)?)(?:-(.+))?$` | `^(Details\|Package)-(\d+)(?:-(.+))?$` |
| Nhãn chữ | **Được** (`Mockup-Web-Novera4`) | **Không** — tên thành metafield key, `details_novera4` theme không đọc được |
| Số thập phân | **Được** (`Mockup-Web-Novera1.1`, xếp giữa 1 và 2) | **Không** |
| Hậu tố version | `-Standard` / `-Premium` / `-Pro` | `-Standard` / `-Premium` / `-Pro` |

Vẫn bị loại (cố ý): `Mockup-Web-3D` (là preview pose, không phải ảnh gallery),
`Mockup-Ads`, `Mockup-Etsy-4`, `NOVERA2-1`, `Wow1` — thiếu tiền tố `Mockup-Web-`
hoặc không có số theo sau nhãn.

Đuôi file (`.png`, `.jpg`, `.webp`…) được cắt bỏ trước khi so khớp; các đuôi
khác thì **không** — nếu không `Mockup-Web-Novera1.1` sẽ bị cắt thành `...1`.

Nguồn chân lý trong code: `src/lib/shopify/product-builder.ts` (hằng
`MOCKUP_WEB_PATTERN` + hàm `classifyImages`). Tài liệu này mô tả lại chính hàm
đó — nếu hai bên lệch nhau, **code đúng**.

---

## 2. Vì sao ảnh bị thiếu

Bốn nguyên nhân đã gặp thật:

1. **Tên reference không khớp quy ước** — *nguyên nhân phổ biến nhất.* Ảnh sai
   tên bị **bỏ qua hoàn toàn** khi deploy theo đường sắp-xếp-theo-tên: không vào
   gallery, không vào metafield, không báo lỗi. Xem bảng rà soát ở mục 2b.
2. **Xoá nhầm khi sửa sản phẩm.** Người deploy không để ý ảnh metafield, sửa lại
   rồi ảnh mất luôn.
3. **Ghi metafield thất bại im lặng.** Lúc deploy, bước đẩy ảnh lên metafield chỉ
   `console.warn` khi lỗi — deploy vẫn báo thành công. Không ai biết.
4. **File bị xoá trong Shopify Files.** Metafield vẫn còn nhưng trỏ vào file
   không tồn tại. Nhìn admin thấy "đã có", nhưng storefront trống. API gọi trường
   hợp này là `reason: "broken"`.

> **Khối before/after cần ĐỦ 2 metafield, và cái "showcase" phụ thuộc version.**
> Theme live (`snippets/cue-before-after.liquid`) đọc:
> - ảnh **Package** (nửa "after") ← `custom.package_box`
> - ảnh **Showcase** (nửa "before") ← `custom.package_product_standard` với cue
>   Standard/Premium, hoặc `custom.package_product_pro` với cue Pro
>
> Theme render thẻ `<img src="{{ custom_standard }}">` và chỉ đổi sang bản Pro
> bằng JS khi người xem chọn variant Pro. Nên một cue **Premium** mà chỉ có
> `package_product_pro` sẽ ra `src=""` → **ô showcase trắng**, trong khi ô
> package vẫn hiện vì `package_box` không phụ thuộc version. Đó là lý do "có 1
> cái mà hỏng 1 cái".
>
> Hệ quả: cue Standard/Premium **bắt buộc** phải có `Package-1-Standard`. Ảnh
> `Package-1-Pro` không thay thế được — đây là hai màu hộp khác nhau.

> **Metafield KHÔNG bị xoá khi deploy lại.** Đây là lý do một sản phẩm có thể
> hiện ảnh package trên store dù nhóm ảnh hiện tại chẳng có `Package-*` nào:
> metafield đó là **di tích của một lần deploy trước** bằng nhóm ảnh khác.
> Deploy lại chỉ *ghi đè* metafield mà lần deploy mới có ảnh cho nó — không có
> ảnh thì giá trị cũ **nằm nguyên**. Ca thật: `n05-26-Skull` deploy 24/07 bằng
> nhóm đúng chuẩn (ghi được `package_box`, `package_product_pro`, `details_4_pro`,
> `details_5`), rồi deploy lại 14/09 bằng nhóm `Novera chính thức` sai tên →
> không ghi được gì mới, nên store vẫn hiện ảnh package của tháng 7, còn slot
> showcase thì trống. Nhận ra bằng cách so timestamp trong URL file: ảnh gallery
> `1789379441304-*` (14/09) trong khi metafield trỏ `1784889479970-*` (24/07).
>
> Hệ quả cần nhớ: **ảnh metafield trên store có thể cũ hơn ảnh gallery**, và
> before/after lệch nhau là dấu hiệu điển hình của việc này.

> **Hai đường deploy khác nhau, và đây là chỗ dễ nhầm nhất.**
> `classifyImagesPreserveOrder` (dùng khi người dùng kéo thả / upload ảnh) đưa
> **mọi** ảnh không phải `Details-*`/`Package-*` vào gallery, kể cả tên sai quy
> ước — nên ảnh vẫn lên gallery bình thường. `classifyImages` (đường sắp xếp
> theo tên) thì **bỏ hẳn** ảnh sai tên. Cùng một bộ ảnh, hai đường cho kết quả
> khác nhau. Ảnh sai tên không bao giờ vào được metafield ở cả hai đường.

---

## 2b. Rà soát nhóm ảnh — tình trạng ngày 2026-09-20

Sau khi nới regex (nhận nhãn chữ như `Mockup-Web-Novera4`), tình trạng thực tế:

### Nhóm ĐANG được sản phẩm live dùng

| Nhóm | SP live | Tình trạng | Sai ở đâu | Cách sửa |
|---|---|---|---|---|
| `Novera chính thức` | 22 | ✅ **Đã tự khỏi** nhờ nới regex (0/7 → 7/7) | `Mockup-Web-Novera1…6`, `Novera1.1` — có nhãn chữ xen giữa | Không cần làm gì. Deploy lại là ảnh vào đúng chỗ |
| `Uni chính thức` | 18 | ✅ Đúng chuẩn từ đầu | — | — |
| `NOVERA-D` | 9 | ❌ **Vẫn sai, phải sửa tay** | `NOVERA2-1`, `NOVERA6-1`, `novera5-1`, `NOVERA4-1`, `NOVERA3-1`, `NOVERA1-1` — thiếu hẳn tiền tố `Mockup-Web-` | Đổi tên reference: `NOVERA1-1` → `Mockup-Web-Novera1`, `NOVERA2-1` → `Mockup-Web-Novera2`, … |

### Nhóm sai nhưng chưa sản phẩm live nào dùng

| Nhóm | Sai/Tổng | Ví dụ tên sai | Kiểu sai |
|---|---|---|---|
| `Ebay 05` | 17/17 | `Đạt 11`, `dat 09`, `Dat-13`, `MK4-Etsy` | Không theo quy ước nào |
| `Ebay 2` | 13/13 | `ebay2-01`, `Ebay02-10` | Không theo quy ước nào |
| `Ebay 1` | 10/10 | `dat 13`, `đạt - eb10 - 01` | Không theo quy ước nào |
| `Ebay 5` | 10/10 | `dat 10`, `đạt-2` | Không theo quy ước nào |
| `n02-Mockup Etsy Xcue` | 9/9 | `Mockup-Etsy-1`, `MK1-preview` | Sai tiền tố (`Etsy` ≠ `Web`) |
| `n05-mock da-etsy` | 7/7 | `n05-Mock da-06`, `n05-Mock trơn-01` | Không theo quy ước nào |
| `WowCues` | 7/7 | `Wow1` … `Wow7` | Thiếu tiền tố `Mockup-Web-` |
| `test group` | 6/6 | `Frame-3D-Duy1`, `Vietos Teaser` | Không theo quy ước nào |
| `n07` | 3/6 | `ET4`, `ET4-Trơn`, `MK 1- web` | Thiếu tiền tố |
| `Vi - Mockup` | 3/3 | `dat 13`, `Frame-3D-3` | Không theo quy ước nào |
| `Vi Vi` | 3/3 | `meo`, `vivi_01` | Không theo quy ước nào |
| `H-Banner` | 2/2 | `Mockup-Ads`, `Mockup-Ads 1` | Không có số sau nhãn |
| `test` | 2/2 | `hinh-nen-dong`, `Mockup-Etsy-4` | Sai tiền tố |
| `Preview-3D-mockup` | 1/1 | `Preview-3D` | Không phải ảnh gallery (là preview pose) |

Các nhóm này chỉ cần sửa khi định dùng để deploy lên Shopify. Nhóm dùng cho Ebay
/ Etsy / banner thì không cần — chúng không đi qua đường phân loại này.

Muốn tự rà lại bảng này bất cứ lúc nào: chạy regex ở mục 1 lên
`extractor_references.name` của từng nhóm.

---

## 3. Chuẩn "đủ ảnh" được xác định thế nào

**Không có danh sách cứng**, và cố định một danh sách sẽ sai: Novera, WowCue,
Uni mỗi dòng có bộ ảnh khác nhau. Thay vào đó API suy ra chuẩn theo 3 nguồn, ưu
tiên từ chắc chắn nhất:

| `source` | Nghĩa | Độ tin cậy |
|---|---|---|
| `version-rule` | Suy từ **variant sản phẩm đang bán**: cue Standard/Premium bắt buộc phải có `package_product_standard`, cue Pro phải có `package_product_pro` — nếu không, theme render `src=""` và ô showcase trắng | **Chắc chắn nhất** — cứ sửa, không cần hỏi |
| `deploy` | Lấy từ chính danh sách tên ảnh mà lần deploy đó đã gửi (`form_data.imageNames`) | **Chắc chắn** — ảnh này đã từng được gửi lên |
| `group` | Suy từ nhóm ảnh mockup đang gắn với sản phẩm, đọc tên các reference trong nhóm | Cao — trừ khi nhóm bị sửa sau khi deploy |
| `cohort` | Suy từ các sản phẩm **cùng nhóm ảnh**: nếu ≥80% sản phẩm trong nhóm có metafield đó mà sản phẩm này không có → coi là thiếu | Suy đoán — xem `confidence` |

Chốt an toàn cho `cohort`: nhóm dưới **3 sản phẩm** thì không suy đoán gì cả, và
ngưỡng **0.8** giữ cho ảnh đặc thù (chỉ vài sản phẩm có) không bị báo nhầm.

**Với `source: "cohort"`, nên hỏi người dùng trước khi sửa hàng loạt.** Với
`version-rule`, `deploy` và `group` thì cứ sửa.

### `version-rule` bắt lỗi gì mà 3 nguồn kia không bắt được

Ba nguồn kia đều trả lời câu "sản phẩm này *đáng lẽ* được cấp ảnh nào" — tức là
mô tả sản phẩm **lúc deploy**. `version-rule` hỏi câu khác: "với variant sản
phẩm đang bán **hôm nay**, theme cần ảnh nào để render được?"

Khác biệt đó chỉ lộ ra khi **version bị đổi sau khi deploy**:

- Deploy lần đầu là cue **Pro** → ghi `package_product_pro`. Theme hiện đúng.
- Sau đó sửa variant về **Premium**, deploy lại. Metafield **không bao giờ bị
  xoá** khi deploy lại — chỉ bị ghi đè nếu lần deploy mới có ảnh cho ô đó. Nên
  `package_product_pro` nằm lại, còn `package_product_standard` chưa từng được
  ghi.
- Theme render `<img src="{{ custom.package_product_standard }}">` cho cue
  Standard/Premium → ra `src=""` → **ô showcase trắng**, trong khi ô package vẫn
  hiện (vì `package_box` không phụ thuộc version).

Nhìn trong Shopify admin thì thấy "có ảnh metafield" nên tưởng bình thường. Chỉ
xem DOM mới thấy `src` rỗng. Đây là ca đã gặp thật với 6 sản phẩm nhóm Novera.

---

## 4. Ba API để tự sửa

Tất cả dùng `Authorization: Bearer cue_live_...`.

### 4.1 Tra sản phẩm — `GET /api/v1/shopify/products`

Đổi "cái tiêu đề trong ảnh chụp màn hình" thành product name mà các API sau cần.

```bash
curl "__ORIGIN__/api/v1/shopify/products?q=skull" \
  -H "Authorization: Bearer cue_live_xxx"
```

Tìm theo tên sản phẩm (`n05-26-skull`), tiêu đề Shopify, hoặc tên nhóm ảnh.

### 4.2 Soát ảnh thiếu — `POST /api/v1/shopify/media-audit`

Một sản phẩm:

```bash
curl -X POST __ORIGIN__/api/v1/shopify/media-audit \
  -H "Authorization: Bearer cue_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"product": "n05-26-skull"}'
```

Quét cả store (đây là cái trả lời "1000 sản phẩm thì 9 cái đang thiếu"):

```bash
curl -X POST __ORIGIN__/api/v1/shopify/media-audit \
  -H "Authorization: Bearer cue_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1000}'
```

Mặc định chỉ trả về sản phẩm **có vấn đề**. Gửi `"only_issues": false` để xem hết.

Mỗi mục trong `missing[]` có:

- `key` — metafield đang trống, vd `custom.package_box`
- `reference_name` — **tên ảnh cần render**, ném thẳng vào API render
- `reason` — `absent` (chưa có gì) hoặc `broken` (file đã mất)
- `source` + `confidence` — xem mục 3

### 4.3 Up ảnh bù — `POST /api/v1/shopify/media-repair`

```bash
curl -X POST __ORIGIN__/api/v1/shopify/media-repair \
  -H "Authorization: Bearer cue_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
        "product": "n05-26-skull",
        "media": [{"key": "custom.package_box", "url": "https://…/Package-2.png"}]
      }'
```

**Chỉ điền chỗ trống.** Metafield đã có ảnh tốt sẽ trả `status: "skipped"` chứ
không bị ghi đè — an toàn khi chạy tự động trên sản phẩm đang bán. Muốn thay thật
thì gửi `"overwrite": true`. Metafield `broken` thì luôn được ghi đè (đằng nào
cũng đang hỏng).

Endpoint này **không** đụng vào giá, variant, tiêu đề, mô tả hay thứ tự gallery.
Những thứ đó thuộc về deploy, phải có người bấm.

---

## 5. Luồng hoàn chỉnh cho agent

Ứng với câu lệnh kiểu:

> *"@shopify-prime-cues sản phẩm này thiếu mất 1 ảnh, tra xem thiếu ảnh nào rồi
> gọi @tool-3d render bổ sung và up bù lên"*

```
1. GET  /api/v1/shopify/products?q=<chữ trong ảnh chụp>
      → lấy product_name

2. POST /api/v1/shopify/media-audit   {"product": "<product_name>"}
      → missing[] = [{ key: "custom.package_box", reference_name: "Package-2" }]

3. POST /api/v1/renders               {"product": "<product_name>",
                                       "references": ["Package-2"]}
      → job_id

4. GET  /api/v1/renders/<job_id>      (poll đến khi status = "succeeded")
      → files[].url

5. POST /api/v1/shopify/media-repair  {"product": "<product_name>",
                                       "media": [{"key": "custom.package_box",
                                                  "url": "<files[].url>"}]}

6. Lặp lại bước 2 để xác nhận missing[] đã rỗng.
```

Bước 6 không được bỏ: đó là bằng chứng ảnh đã thật sự lên, thay vì tin vào
response của bước 5.

### Quét hàng loạt

```
1. POST /api/v1/shopify/media-audit   {"limit": 1000}
      → 9 sản phẩm thiếu custom.package_box

2. Báo người dùng: "Rà 1000 sản phẩm, thấy 9 sản phẩm nhóm <tên nhóm> đang thiếu
   custom.package_box (ảnh hộp gậy). Có sửa không?"

3. Nếu đồng ý → lặp bước 3–6 ở trên cho từng sản phẩm.
```

Với `source: "cohort"` thì **luôn hỏi trước**. Với `source: "deploy"` thì cứ sửa
và báo lại kết quả.

---

## 5b. Ví dụ đầy đủ — sản phẩm Premium thiếu ảnh showcase

Ca thật, chạy được từng bước. Người dùng dán tiêu đề từ store và nói:

> *"Sản phẩm Novera Dragon Skull Wings bị trắng ô showcase, sửa giúp tôi"*

### Bước 1 — Soát luôn bằng tiêu đề dán từ store

Không cần tra mã sản phẩm trước — dán thẳng tiêu đề người dùng gửi:

```bash
curl -X POST __ORIGIN__/api/v1/shopify/media-audit \
  -H "Authorization: Bearer cue_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"product": "Novera Dragon Skull Wings Gothic Carbon Fiber Pool Cue"}'
```

*(Nếu API trả 409 "khớp nhiều sản phẩm" → gọi
`GET /api/v1/shopify/products?q=...` để xem danh sách rồi dùng `product_name`.)*

```json
{ "results": [{
    "product_name": "n05-26-Skull",
    "versions": ["Premium"],
    "missing": [{
      "key": "custom.package_product_standard",
      "kind": "metafield",
      "reason": "absent",
      "reference_name": "Package-1-Standard",
      "source": "version-rule",
      "confidence": 1
}]}]}
```

**Agent đọc được gì:** sản phẩm bán bản **Premium**; theme lấy ảnh showcase từ
`package_product_standard`; ô đó trống → showcase trắng. Ảnh cần render tên
`Package-1-Standard`. `source: "version-rule"` + `confidence: 1` → chắc chắn,
không cần hỏi lại.

### Bước 2 — Kiểm tra reference có sẵn không

`Package-1-Standard` phải tồn tại thì mới render được:

```bash
curl "__ORIGIN__/api/v1/render-targets" -H "Authorization: Bearer cue_live_xxx"
```

Tìm `Package-1-Standard` trong `references[]`. **Nếu không có** → dừng, báo
người dùng: *"Cần tạo reference `Package-1-Standard` trước, tôi không tự tạo
được."* Đừng render bừa tên khác.

### Bước 3 — Render ảnh thiếu

```bash
curl -X POST __ORIGIN__/api/v1/renders \
  -H "Authorization: Bearer cue_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"product": "n05-26-Skull", "references": ["Package-1-Standard"]}'
```

```json
{ "jobs": [{ "id": "…", "status": "queued", "status_url": "/api/v1/renders/…" }] }
```

### Bước 4 — Chờ render xong

```bash
curl "__ORIGIN__/api/v1/renders/<job_id>" -H "Authorization: Bearer cue_live_xxx"
```

Lặp tới khi `status: "succeeded"` (KHÔNG phải `"done"`), rồi lấy `files[0].url`. Render mất khoảng 1–3
phút; poll mỗi 15–20 giây, đừng poll liên tục.

### Bước 5 — Up bù lên Shopify

```bash
curl -X POST __ORIGIN__/api/v1/shopify/media-repair \
  -H "Authorization: Bearer cue_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
        "product": "n05-26-Skull",
        "media": [{
          "key": "custom.package_product_standard",
          "url": "<files[0].url>"
        }]
      }'
```

```json
{ "filled": 1, "skipped": 0, "failed": 0,
  "results": [{ "key": "custom.package_product_standard", "status": "filled" }] }
```

### Bước 6 — Xác nhận

Chạy lại **bước 1**. `missing[]` phải rỗng. Không được bỏ bước này — đó là bằng
chứng ảnh đã thật sự lên, thay vì tin vào response của bước 5.

### Báo lại cho người dùng

> Sản phẩm bán bản Premium, mà theme lấy ảnh showcase từ ô
> `package_product_standard` — ô này đang trống (sản phẩm chỉ có bản Pro, có lẽ
> do trước đây deploy ở version Pro rồi đổi về Premium). Đã render
> `Package-1-Standard` và up bù vào. Đã soát lại: không còn thiếu gì.

### Quét cả store — KHÔNG cần nhập sản phẩm nào

Bỏ trống `product` là quét toàn bộ sản phẩm đã deploy. Body rỗng `{}` cũng chạy
(mặc định 50 sản phẩm); gửi `limit` để quét rộng hơn, tối đa 1000:

```bash
curl -X POST __ORIGIN__/api/v1/shopify/media-audit \
  -H "Authorization: Bearer cue_live_xxx" \
  -H "Content-Type: application/json" -d '{"limit": 1000}'
```

Kết quả thật đo ngày 2026-09-20 trên store `main` (76 sản phẩm live):

```
QUÉT 76 sản phẩm live → đọc được 74, 2 đã bị xoá trên Shopify
>>> 8 sản phẩm thiếu ảnh:

  Novera Gothic Gargoyle Skull …      ["Premium"]                 package_product_standard [version-rule]
  Novera Inferno Skull Tribal Fire …  ["Premium"]                 package_product_standard [version-rule]
  Novera Dragon Skull Wings …         ["Premium"]                 package_product_standard [version-rule]
  Novera Vampire Skull & Cross …      ["Premium"]                 package_product_standard [version-rule]
  Novera Gothic Reaper …              ["Premium"]                 package_product_standard [version-rule]
  Novera Knight Skull Gothic …        ["Premium"]                 package_product_standard [version-rule]
  Uni Spartan Warrior …               ["Standard","Premium","Pro"] package_product_standard [version-rule]
  Uni Pink Leopard Print …            ["Premium","Pro","Lux"]      Mockup-Web-5-Pro         [deploy]
```

Sản phẩm đã bị xoá trên Shopify (còn dòng trong DB) được **bỏ qua im lặng**,
không tính là thiếu ảnh.

Với `version-rule` thì sửa thẳng rồi báo lại; với `cohort` thì hỏi trước.

---

## 5c. Thêm ảnh cho sản phẩm dùng nhóm KHÔNG chuẩn

Người dùng nói:

> *"Sản phẩm abc thêm ảnh package box và showcase cho tôi"*

— trong khi nhóm ảnh gắn với sản phẩm đó chẳng có `Package-*` nào.

**Vẫn làm được, không cần sửa nhóm.** `POST /api/v1/renders` nhận field
`references` (ảnh lẻ theo tên) **hoàn toàn độc lập với nhóm**. Nhóm chỉ là bộ
ảnh gợi ý lúc deploy, không phải giới hạn của việc render.

```bash
# Render 2 ảnh lẻ — không liên quan gì tới nhóm đang gắn
curl -X POST __ORIGIN__/api/v1/renders \
  -H "Authorization: Bearer cue_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"product": "n05-26-Skull",
       "references": ["Package-1-Standard", "Package-2"]}'
```

Rồi up bù như bình thường:

```bash
curl -X POST __ORIGIN__/api/v1/shopify/media-repair \
  -H "Authorization: Bearer cue_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"product": "n05-26-Skull",
       "media": [
         {"key": "custom.package_product_standard", "url": "<url ảnh Package-1-Standard>"},
         {"key": "custom.package_box",              "url": "<url ảnh Package-2>"}
       ]}'
```

### Agent phải kiểm tra version TRƯỚC khi render

Đây là bước agent **bắt buộc** làm, vì render sai version là tốn GPU và up lên
ảnh vô dụng. Quy tắc:

| Sản phẩm bán version | Ảnh showcase phải render | Metafield đích |
|---|---|---|
| Standard | `Package-1-Standard` | `custom.package_product_standard` |
| Premium | `Package-1-Standard` *(Premium dùng chung ảnh Standard)* | `custom.package_product_standard` |
| Pro | `Package-1-Pro` | `custom.package_product_pro` |
| Standard + Pro | **cả hai** | cả hai ô |
| Premium + Pro | **cả hai** | cả hai ô |

Ảnh hộp `Package-2` → `custom.package_box`, **không phụ thuộc version**, luôn
chỉ cần một ảnh.

Lấy version ở đâu: field `versions` trong response của `media-audit`.

### Khi agent nên đề xuất thêm variant

Nếu người dùng bảo "thêm ảnh showcase bản Pro" mà sản phẩm **chưa có variant
Pro**, thì ảnh đó up lên cũng không ai thấy — theme chỉ đọc
`package_product_pro` khi người xem chọn variant Pro. Agent **nên nói ra**, thay
vì render rồi up một ảnh chết:

> *"Sản phẩm này đang chỉ bán bản Premium (`versions: ["Premium"]`), nên ô
> showcase lấy từ `package_product_standard`. Nếu anh muốn có cả ảnh bản Pro thì
> cần thêm variant Pro cho sản phẩm trong trang deploy trước — em không tự thêm
> variant được. Còn bây giờ em render `Package-1-Standard` để ô showcase hiện
> đúng nhé?"*

**Agent KHÔNG tự đổi variant.** Đổi version kéo theo giá, SKU và cả ô metafield
nào được dùng — đó là quyết định kinh doanh, phải người bấm trong trang deploy.
API `media-repair` cố tình không đụng tới variant vì lý do này.

### Nếu reference cần render chưa tồn tại

`GET /api/v1/render-targets` liệt kê mọi reference gọi được. Nếu tên cần render
không có trong đó, agent **dừng và báo**, không được tự chọn tên gần giống:

> *"Cần reference tên `Package-1-Standard` để render ảnh showcase, nhưng hệ
> thống chưa có. Anh tạo reference đó trong trang Extractor trước giúp em."*

Tính đến 2026-09-20, các reference này đã có sẵn và dùng được ngay cho mọi sản
phẩm: `Package-1-Standard`, `Package-1-Pro`, `Package-2`, `Details-4-Standard`,
`Details-4-Premium`, `Details-4-Pro`, `Details-5`.

---

## 5d. Đã chạy thật — nhật ký một ca sửa hoàn chỉnh

Ngày 2026-09-20, sửa thật trên sản phẩm live, gọi API qua HTTP đúng như agent
gọi. Ghi lại để biết cái gì thực sự chạy, không phải lý thuyết.

**Đầu vào:** link dán nguyên từ thanh địa chỉ

```
https://prime-cues.com/products/uni-gothic-dragon-skull-carbon-fiber-pool-cue-gothic-skull-n05-26
```

| Bước | Gọi | Kết quả |
|---|---|---|
| 1 | `POST media-audit` `{"product": "<link>"}` | Khớp qua **handle** → `n05-26-Skull`, `versions: ["Premium"]`, thiếu `custom.package_product_standard`, `source: version-rule` |
| 2 | `POST renders` `{"references": ["Package-1-Standard"]}` | job queued (nhóm ảnh của sản phẩm **không có** Package-* — vẫn render được) |
| 3 | `GET renders/<id>` | `status: succeeded` sau ~46 giây, ra file PNG 2048×2048 (598 KB) |
| 4 | `POST media-repair` | `filled: 1`, `file_gid: gid://shopify/MediaImage/32601298600073` |
| 5 | `POST media-audit` lại | `products_with_issues: 0` |

**Kiểm chứng trên storefront thật** — đây mới là bằng chứng cuối:

```html
TRƯỚC:  <img id="cueBaProductImage" src data-standard data-pro="//…/img-4.png">
                                    ↑ src rỗng → ô showcase trắng

SAU:    <img id="cueBaProductImage"
             src="//prime-cues.com/cdn/shop/files/Package-1-Standard_60e1b7d0….png"
             data-standard="//…/Package-1-Standard_60e1b7d0….png"
             data-pro="//…/img-4.png">     ← ảnh Pro cũ giữ nguyên
```

Lưu ý thực tế:

- **`status` khi render xong là `succeeded`**, không phải `done`. Agent phải
  chờ `succeeded` (hoặc `failed`), đừng chờ `done` — sẽ treo vô hạn.
- Render mất **khoảng 45–60 giây** cho một ảnh. Poll mỗi 15 giây là hợp lý.
- `media-repair` **không đụng** tới `package_product_pro` đang có — đúng như
  thiết kế "chỉ điền chỗ trống".

---

## 6. Giới hạn cần biết

- **Ảnh gallery (`Mockup-Web-N`) hầu như không soát được.** Shopify không lưu
  "tên" cho ảnh gallery, và deploy đặt alt text theo tiêu đề sản phẩm chứ không
  theo tên slot. API chỉ báo thiếu ảnh gallery khi alt text tình cờ có mang tên
  reference — còn lại thì im lặng, vì báo bừa còn tệ hơn không báo. **Ảnh
  metafield thì luôn soát được chính xác**, và đó đúng là loại hay mất nhất.
- `media-repair` ghi metafield, không chèn ảnh vào gallery. Thiếu ảnh gallery vẫn
  phải deploy lại bằng tay.
- Quét tối đa 1000 sản phẩm mỗi lần (mặc định 50 nếu không gửi `limit`). Mỗi sản
  phẩm tốn 2 lệnh gọi Shopify, nên quét 1000 mất vài phút — cứ chờ, đừng tưởng treo.
- Sản phẩm mới ở dạng nháp (chưa lên Shopify) không bị soát.

---

## 7. Liên quan

- `docs/public-api.md` — tạo sản phẩm + đặt render qua API
- `src/lib/shopify/product-builder.ts` — luật phân loại tên ảnh (nguồn chân lý)
- `src/lib/shopify/media-audit.ts` — cách suy ra chuẩn và so sánh
- Trang **API Token** trong app — danh sách đầy đủ endpoint + mẫu copy-paste
