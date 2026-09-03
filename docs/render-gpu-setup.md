# Render trên GPU thuê — giải thích + hướng dẫn setup RunPod Serverless

Tài liệu này trả lời 3 câu:

1. Từng API route làm gì, và **tại sao VPS không cần GPU**
2. **Worker** là cái gì
3. **Batch** và **song song** hoạt động ra sao

rồi hướng dẫn setup RunPod Serverless từ đầu đến chạy được.

---

## Phần 1 — Kiến trúc: ai làm việc gì

Trước đây render xảy ra **trong browser của người vận hành**: deploy dialog dựng
`ExtractorSceneManager`, lặp qua từng reference trong group, mỗi mockup ăn 10–30s
GPU của cái laptop đó. Chọn nhiều product là treo tab hoặc hết GPU memory.

Bây giờ tách làm 3 chỗ, mỗi chỗ một nhiệm vụ:

```
┌──────────────┐         ┌─────────────────────┐        ┌──────────────────────┐
│   BROWSER    │         │   VPS (KHÔNG GPU)   │        │  GPU THUÊ (RunPod)   │
│              │         │                     │        │                      │
│ chọn product │──POST──▶│ 1. đọc DB           │        │  container bật lên   │
│ chọn group   │         │ 2. gói payload      │        │  ↓                   │
│              │         │ 3. INSERT job row   │        │  Chrome mở page      │
│              │◀─job_id─│ 4. poke RunPod  ────┼───────▶│  của app anh         │
│              │         │ 5. return (~200ms)  │        │  ↓                   │
│              │         │                     │        │  WebGL render THẬT   │
│  poll status │──GET───▶│ đọc job row         │        │  ↓                   │
│              │         │                     │◀───────│  upload từng file    │
│  hiện ảnh    │◀─URLs───│                     │        │  ↓                   │
└──────────────┘         └─────────────────────┘        │  container CHẾT      │
                                                        └──────────────────────┘
```

### Tại sao VPS không cần GPU?

Vì **VPS không render gì cả**. Route `POST /api/products/[id]/renders` chỉ làm:

| Bước | Việc | Cần GPU? |
|---|---|---|
| 1 | `SELECT` group "NOVERA-D" → nó trỏ tới 6 reference nào | Không — đọc DB |
| 2 | `SELECT` product → model type, surface URL, three.js settings | Không — đọc DB |
| 3 | Gói tất cả thành 1 cục JSON (`payload`) | Không — `JSON.stringify` |
| 4 | `INSERT` 1 dòng vào `render_jobs`, `status='queued'` | Không — ghi DB |
| 5 | `fetch()` sang `api.runpod.ai` để đánh thức GPU | Không — 1 HTTP call |
| 6 | Trả `job_id` về cho browser | Không |

Tổng: **đọc/ghi DB + 1 HTTP call ≈ 200ms.** Không có pixel nào được vẽ.

Việc nặng thật sự — dựng scene 3D, chạy WebGL, vẽ canvas 2048×2048, load HDRI,
encode video — xảy ra **hoàn toàn bên trong Chrome trên card thuê**. VPS không
bao giờ chạm vào.

> **Vì sao không import three.js vào API route cho gọn?**
> Vì `src/lib/three/*` (~250KB) là **code browser**: nó gọi
> `document.createElement("canvas")`, `new Image()`, WebGL, và cho video là
> `canvas.captureStream()` + `MediaRecorder`. Node không có thứ nào trong số đó
> — API route sẽ chết ngay dòng `document.` đầu tiên.
> Viết lại bằng `headless-gl` + ffmpeg thì phải bỏ toàn bộ MediaRecorder, tự
> encode, và **ảnh server sẽ khác ảnh preview** — đúng cái không được phép sai.
> Chạy nguyên code đó trong Chrome thật, trên GPU, giữ pixel giống hệt.

---

## Phần 2 — Từng API route

### Nhóm A — dành cho người dùng (cần đăng nhập, RLS chặn theo user)

#### `POST /api/products/[id]/renders` — queue render ảnh

```jsonc
// Body
{
  "groupId": "uuid-cua-nhom-anh",   // bắt buộc — group "NOVERA-D (6 ảnh)"
  "productIds": ["uuid-b", "uuid-c"], // tuỳ chọn — render thêm cho product khác
  "format": "png",                   // hoặc "jpeg" cho file nhẹ khi lên Shopify
  "quality": 0.95                    // chỉ áp dụng cho jpeg
}
```

Làm gì:
- Đọc group → resolve ra danh sách reference **theo đúng thứ tự group đã lưu**
- Đọc product → inline luôn `threejs_settings` vào payload
- Tạo **1 job cho MỖI product** (xem Phần 3)
- Poke RunPod 1 lần cho mỗi job
- Trả `202` + danh sách job

Giới hạn 20 product/request. Reference bị xoá sau khi group được lưu thì bỏ qua
cái đó, không làm chết cả lệnh render.

#### `POST /api/products/[id]/videos` — queue render video

```jsonc
{
  "templateId": "uuid-video-template",
  "productIds": ["uuid-b"],
  "width": 1920, "height": 1080, "fps": 60
}
```

Giống route ảnh, khác 2 điểm: đọc từ `video_studio_templates`, và giới hạn 10
product (video nặng hơn mockup rất nhiều — mỗi clip vài phút GPU).

#### `GET /api/render-jobs/[jobId]` — poll tiến độ

Đây là cái browser gọi lặp lại sau khi queue:

```jsonc
{
  "status": "running",           // queued | running | succeeded | failed | canceled
  "progressDone": 3,
  "progressTotal": 6,
  "progressLabel": "Đang render Mockup-Web-4",
  "outputs": [                    // đầy dần lên, không đợi xong hết
    { "name": "Mockup-Web-1", "url": "https://...", "width": 2048, "height": 2048 }
  ]
}
```

`outputs` **đầy dần** vì worker upload từng ảnh xong là gửi luôn — nên UI thấy
ảnh nhảy ra lần lượt, và nếu crash ở ảnh thứ 5 thì 4 ảnh đầu vẫn còn.

#### `DELETE /api/render-jobs/[jobId]` — cancel

Đổi status thành `canceled`. Worker kiểm tra ở **mỗi nhịp heartbeat**, thấy
canceled là dừng ngay → **cắt tiền GPU giữa job**, không phải trả cho render mà
không ai lấy.

#### `GET /api/render-jobs` — cả queue trong 1 request

```
GET /api/render-jobs?status=queued,running
```

Quan trọng cho batch: 5 product đang render thì **1 request** lấy hết tình trạng
cả 5, không phải 5 request mỗi nhịp poll.

### Nhóm B — dành cho worker (auth bằng `RENDER_WORKER_SECRET`, không phải session)

Worker chạy trong container, không có cookie đăng nhập. Nó dùng shared secret
trong header `Authorization: Bearer <secret>`, và mọi route này dùng service
client (bỏ qua RLS) vì nó **đúng là** đang xử lý job của user khác.

| Route | Việc |
|---|---|
| `POST /api/render-worker/claim` | Nhận job + payload. Dùng `FOR UPDATE SKIP LOCKED` nên 2 worker cùng poll không bao giờ lấy trùng 1 job |
| `PATCH .../[jobId]/progress` | Heartbeat: báo "3/6", gia hạn lease, **và nhận lại cờ `canceled`** |
| `POST .../[jobId]/upload` | Gửi 1 file (multipart). Server đẩy lên Storage → nên **service key không bao giờ nằm trong container GPU** |
| `POST .../[jobId]/complete` | Chốt `succeeded` / `failed` |
| `GET .../queue-depth` | "Còn việc không?" — **chỉ đếm, không claim** |

> **Bảo mật:** không bao giờ đặt `RENDER_WORKER_SECRET` dưới tiền tố
> `NEXT_PUBLIC_`. Lộ nó là người ngoài claim được job và gắn URL rác vào.
> Nếu secret chưa set, toàn bộ nhóm B trả `503` (fail closed) — thà không chạy
> còn hơn mở cửa.

**Cơ chế lease — chống worker chết treo job:** khi claim, job được đặt
`lease_until = now + 15 phút`. Worker chết giữa đường → không ai gia hạn → lần
claim sau tự trả job về `queued` để worker khác làm lại (tối đa 3 lần). Không có
cái này thì 1 container crash là job kẹt `running` mãi mãi.

---

## Phần 3 — Worker là gì, batch và song song

### Worker là gì?

**Worker = 1 container Docker chứa Chrome, chạy trên card thuê.**

Nó **không** phải server đứng chờ 24/7. Nó được đánh thức → làm việc → **chết**,
vì tính tiền theo giây.

```
RunPod nhận poke
  ↓  cold start ~30-60s (pull image, bật Chrome)
worker.mjs bật Chrome
  ↓  VERIFY WebGL có trên GPU thật không → không có thì chết ngay, báo lỗi rõ
mở  https://app-cua-anh/render-worker?jobId=abc&token=xxx
  ↓
Trong Chrome (page của app anh):
  claim job → đọc payload → dựng scene 3D → render ảnh 1 → upload
                                          → render ảnh 2 → upload  ...
  → mark complete
  ↓
worker: "còn job trong queue?" → GET queue-depth
  ↓  còn → làm tiếp (tối đa 5 job/lần thức)
  ↓  hết → Chrome tắt, container CHẾT → RunPod ngừng tính tiền
```

**Điểm cốt lõi:** worker **mở chính website của anh**. Nó không giữ bản copy code
render nào riêng. Nên `ExtractorSceneManager` chỉ tồn tại **1 bản** — sửa code
render thì browser và server đổi cùng nhau, không bao giờ lệch pixel.

### Batch + song song — có 3 tầng, đừng lẫn

#### Tầng 1 — Batch: 1 request → N job → **song song thật**

Anh chọn 3 product + group "NOVERA-D (6 ảnh)":

```
POST /api/products/cueA/renders   { groupId: "novera-d", productIds: ["cueB","cueC"] }
                    ↓
        Tạo 3 dòng DB (KHÔNG phải 1 dòng):
          job#1 → cueA + 6 reference
          job#2 → cueB + 6 reference
          job#3 → cueC + 6 reference
                    ↓
        Poke RunPod 3 lần → RunPod bật 3 container trên 3 card khác nhau
                    ↓
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │  card 1  │  │  card 2  │  │  card 3  │   ← CÙNG LÚC
        │ job#1    │  │ job#2    │  │ job#3    │
        │ 6 ảnh    │  │ 6 ảnh    │  │ 6 ảnh    │
        └──────────┘  └──────────┘  └──────────┘

Tổng thời gian ≈ thời gian của 1 product, KHÔNG phải 3.
```

**Sao 1 job mỗi product, không gộp cả 3 vào 1 job?**

| Gộp 1 job | Tách 3 job |
|---|---|
| 3 product xếp hàng trên **1 card** → mất 3× thời gian | 3 card chạy song song → 1× thời gian |
| cueB lỗi → cả lệnh render chết, mất luôn cueA/cueC | cueB lỗi, cueA/cueC vẫn xong bình thường |
| 1 thanh progress gộp, không biết product nào đang ở đâu | Progress riêng từng product |

#### Tầng 2 — Trong 1 job: 6 ảnh chạy **tuần tự** (cố ý)

6 reference trong cùng job render lần lượt, **không** song song. Đây là chủ đích:
mỗi ảnh cần 1 WebGL context + HDRI + texture 4096px. Chạy 6 cái cùng lúc trên 1
card là hết VRAM → Chrome crash.

Tuần tự nhưng **mỗi ảnh xong là upload ngay** → UI thấy ảnh nhảy ra dần, và crash
ở ảnh 5 thì 4 ảnh đầu đã an toàn trong Storage.

#### Tầng 3 — Drain: 1 card làm nhiều job liên tiếp (van an toàn, không phải kế hoạch)

Cold start (~30–60s: pull image, bật Chrome, tải GLB + HDRI) **đắt hơn** render 1
ảnh. Nên xong job, worker hỏi "còn việc không?" — còn thì làm tiếp, tối đa
`RENDER_MAX_JOBS_PER_RUN` (mặc định 5).

```
card đang nóng ──job#1──▶ job xong ──"còn việc?"──▶ có ──job tiếp──▶ ...
                                                    không ──▶ CHẾT
```

**Ba điều dễ hiểu sai ở đây:**

**(1) 5 job đó KHÔNG cùng 1 product.** Job đầu là job pod được đánh thức cho.
Job 2..5 là job **cũ nhất trong queue chung** — product nào cũng được
(`WHERE status='queued' ORDER BY created_at`, không filter product). Worker
không có khái niệm "product của tôi".

**(2) Drain thường KHÔNG chạy.** Nó chỉ kích hoạt khi **job nhiều hơn pod**:

```
Max Workers = 5, queue 3 job:
  pod#1 ← job cueA → xong → queue rỗng → chết        (làm 1 job)
  pod#2 ← job cueB → xong → queue rỗng → chết        (làm 1 job)
  pod#3 ← job cueC → xong → queue rỗng → chết        (làm 1 job)
  → MAX_JOBS_PER_RUN=5 không bao giờ dùng tới

Max Workers = 2, queue 6 job:
  pod#1 ← job1 → job3 → job5     (drain, 3 product khác nhau)
  pod#2 ← job2 → job4 → job6
```

Nên `MAX_JOBS_PER_RUN` là **mức trần khi thiếu pod**, không phải chỉ tiêu gom job.

**(3) Sao lại 5?** 5 là mặc định chọn theo phán đoán, không phải số đo được. Cái
có thật là **hai lực kéo ngược nhau**:

*Kéo lên:* cold start ~45s là phần đắt nhất; job thứ 2 trên card nóng gần như
miễn phí phần khởi động.

*Kéo xuống — 3 lý do thật:*

1. **VRAM không được thu hồi sạch giữa các job.** Page được đóng sau mỗi job,
   nhưng Chrome + driver NVIDIA vẫn giữ lại một phần. Job thứ 10–15 trong cùng
   pod dễ crash hơn job thứ 2.
2. **`Execution Timeout` áp cho CẢ POD, không phải từng job.** Đây là cái bẫy
   đắt nhất: 5 job video × 6 phút = 30 phút > timeout 20 phút → **pod bị kill
   giữa job cuối**. Job đó bị treo `running` cho tới khi lease 15 phút hết hạn,
   user thấy render đứng im.
3. **Pod chết chỉ ảnh hưởng job đang dở** (job xong đã upload), nhưng job dở đó
   phải đợi hết lease mới được retry.

**Cách chặn bẫy (2) bằng code, không chỉ bằng cẩn thận:** set
`RENDER_RUN_BUDGET_MS` = đúng `Execution Timeout` của endpoint. Worker theo dõi
thời gian đã dùng và **không nhận job mới nếu job đó có thể không kịp xong**:

```
[worker abc] stopping after 3 job(s): 1080s used, another ~360s would exceed
             the 1200s run budget
```

Đã kiểm chứng bằng test số học của đúng vòng lặp này:

| Loại job | Cap | Budget | Thực tế nhận | Kết quả |
|---|---|---|---|---|
| Video 6 phút | 5 | 20 phút | **3 job** (18 phút) | Tự dừng, không bị kill |
| Ảnh 2.5 phút | 5 | 20 phút | 5 job (12.5 phút) | Dùng hết cap |
| Ảnh 2.5 phút | 8 | 20 phút | 8 job (20 phút) | Vừa khít |
| Video 6 phút | 5 | **không set** | 5 job (30 phút) | **Bị kill** — nên phải set |

Có budget rồi thì `MAX_JOBS_PER_RUN` để 5 hay 8 đều an toàn — worker tự biết dừng.

**Nên set bao nhiêu:**

| Anh render gì | `MAX_JOBS_PER_RUN` | Vì sao |
|---|---|---|
| Chỉ ảnh (~2.5 phút/job) | `5` – `8` | 8 × 2.5 = 20 phút, khít timeout |
| Chỉ video (~4–6 phút/job) | `2` – `3` | Để 5 là vượt timeout |
| Lẫn cả hai | `3` | An toàn cho trường hợp xấu nhất |
| Max Workers ≥ số product hay chọn | `1` – `2` | Drain gần như không dùng tới |

**Nghịch lý có lợi (vẫn đúng):** queue 5 product **cùng lúc** rẻ hơn bấm render 5
lần riêng lẻ — nhưng lý do là **RunPod bật 5 pod song song**, không phải vì 1 pod
gom 5 job.

---

## Phần 3.5 — Khác gì với `docs/server-render-api-plan.md`?

Repo đã có một plan cũ hơn cho cùng bài toán. Nó **không sai**, nhưng chọn hướng
khác vì lúc đó chưa chốt hạ tầng ("deploy target undecided"). Ghi ra đây để khỏi
lẫn khi đọc cả hai:

| | Plan cũ (`server-render-api-plan.md`) | Cái đang chạy (tài liệu này) |
|---|---|---|
| Nơi render | Sidecar container **trên chính VPS** | **GPU thuê**, scale-to-zero |
| GPU | Không — CPU/SwiftShader, "GPU chỉ nhanh hơn, không đẹp hơn" | Có — card thuê theo giây |
| Chromium | Playwright + page pool giữ nóng | Puppeteer, container bật/tắt theo job |
| Kiểu API | `POST /api/render` **đồng bộ**, chờ tới khi xong | **Async job + poll**, trả `job_id` ngay |
| Batch | 1 request bulk, `RENDER_CONCURRENCY=1` để khỏi OOM | 1 job/product, chạy song song trên nhiều card |
| Trạng thái | Không có bảng job | Bảng `render_jobs` + lease + cancel |

Hai điểm plan cũ nói đúng và cái này giữ nguyên:

- **Tái dùng `renderReferenceToBlob`, không viết lại render.** Đây là điều kiện
  để ảnh server giống ảnh preview. Cả hai plan đều dựa vào nó.
- **`/render-worker` phải không bị chặn auth.** Đã kiểm tra: middleware chỉ chặn
  `/dashboard` và `/admin`, nên route này đi qua được — không cần sửa gì.

Còn lại thì hướng đã đổi theo quyết định "thuê card, không dùng card của VPS":
đồng bộ đổi thành async (batch nhiều product vượt timeout HTTP), và
`RENDER_CONCURRENCY=1` không còn cần vì mỗi job có card riêng chứ không giành
RAM trên VPS.

> Về câu "CPU cho chất lượng y hệt, GPU chỉ nhanh hơn": nhận định đó **đúng về
> chất lượng**. Nhưng nhanh hơn ở đây không nhỏ — SwiftShader chậm hơn card thật
> cỡ 10–50×, nên với 6 mockup × nhiều product thì nó là khác biệt giữa "vài phút"
> và "gần cả tiếng". Đó là lý do worker cảnh báo to khi phát hiện đang chạy
> SwiftShader: lúc đó anh **trả giá GPU mà nhận tốc độ CPU**.

---

## Phần 4 — Setup RunPod Serverless từ đầu

### Bước 0 — Chuẩn bị

Cần: tài khoản RunPod đã nạp tiền, GitHub (repo này), và app đã deploy ở URL
**công khai** — container GPU nằm ngoài mạng VPS nên `localhost` hoặc IP nội bộ
sẽ không tới được.

**Không cần Docker Hub.** RunPod tự build từ GitHub (xem Bước 3).

#### Env vars đặt ở đâu — hai bên khác nhau

Đây là chỗ dễ sai nhất: **không phải copy y hệt 2 bên.** Chỉ đúng một biến trùng.

| Biến | `.env` app 3D (VPS) | Env RunPod (worker) |
|---|---|---|
| `RENDER_WORKER_SECRET` | ✅ | ✅ **phải giống hệt nhau** |
| `RENDER_GPU_PROVIDER` | ✅ | — (chỉ để ghi nhãn truy vết) |
| `RUNPOD_API_KEY` | ✅ | ❌ |
| `RUNPOD_ENDPOINT_ID` | ✅ | ❌ |
| `RENDER_APP_BASE_URL` | ✅ | ❌ |
| `RENDER_OUTPUT_BUCKET` | ✅ | ❌ |
| `APP_BASE_URL` | ❌ | ✅ URL công khai của app |
| `WORKER_MODE`, `PORT` | ❌ | ✅ |
| `RENDER_MAX_JOBS_PER_RUN` | ❌ | ✅ |
| `RENDER_RUN_BUDGET_MS` | ❌ | ✅ |
| `RENDER_JOB_TIMEOUT_MS` | ❌ | ✅ |
| `RENDER_ANGLE_BACKEND` | ❌ | ✅ |
| `NVIDIA_DRIVER_CAPABILITIES` | ❌ | ✅ |

Lý do: **app** cần key để *gọi* RunPod; **worker** cần URL để *gọi lại* app.
`RENDER_WORKER_SECRET` là mật khẩu để worker chứng minh nó là worker thật — nên
là biến duy nhất phải khớp.

### Bước 1 — Apply migration

```bash
psql "$DATABASE_URL" -f supabase/migrations/029_render_jobs.sql
```

Tạo bảng `render_jobs`, RLS policies, và 2 hàm claim atomic. Kiểm tra:

```bash
psql "$DATABASE_URL" -c "\d shopify_customizer.render_jobs" | head -20
```

### Bước 2 — Sinh secret

```bash
openssl rand -hex 32
```

Lưu lại — dùng ở **cả 2 nơi** (app và worker), phải giống nhau.

### Bước 3 — Build & push image lên Docker Hub

Có 2 đường. Đường A ít việc hơn; đường B cho anh image dùng được ở mọi nhà cung
cấp. Anh chọn B thì làm theo mục này.

#### Đường A (nhanh nhất) — để RunPod tự build từ GitHub

RunPod clone repo và tự build, lưu vào registry riêng của nó. Chỉ cần:

```bash
git push origin main
```

rồi ở Bước 4 chọn **Use your own Repository** → GitHub → Dockerfile Path là
`render-worker/Dockerfile`.

Ràng buộc: image do RunPod build **chỉ chạy trên RunPod** (tài liệu của họ:
*"cannot be pulled or executed on other platforms"*), nên muốn so giá với
Beam/Modal thì phải build lại. Xem mục dưới.

#### Đường B — tự build, push Docker Hub

**B1. Bật Docker Desktop**

```bash
open -a Docker
```

Đợi icon con cá voi ở menu bar hết animation (~30s). Kiểm tra:

```bash
docker info --format '{{.ServerVersion}}'
```

**B2. Tạo tài khoản + access token Docker Hub**

Vào [hub.docker.com](https://hub.docker.com) → Sign Up. **Username** ở đây chính
là `<dockerhub-user>`, nó thành phần đầu của tên image (ví dụ
`anle/cue-render-worker`).

Rồi tạo access token (đừng dùng password tài khoản):

> avatar góc phải trên → **Account settings** → **Personal access tokens** →
> **Generate new token** → Description `cue-render-worker`, Permissions
> **Read & Write**

Token chỉ hiện **một lần**, copy ra chỗ nào đó.

**B3. Login**

```bash
docker login -u <dockerhub-user>
# Password: dán ACCESS TOKEN, không phải password tài khoản
```

Thấy `Login Succeeded` là xong.

**B4. Build và push**

```bash
cd /Users/an/Documents/cue-customizer-nextjs

docker buildx build \
  --platform linux/amd64 \
  -f render-worker/Dockerfile \
  -t <dockerhub-user>/cue-render-worker:v1 \
  --push \
  .
```

Ba chi tiết dễ sai, cả ba đều làm build vô dụng:

| Chi tiết | Vì sao |
|---|---|
| Dấu `.` ở **cuối** | Build context là **repo root**, không phải `./render-worker`. Sai là `check-context.mjs` fail build ngay kèm hướng dẫn |
| `--platform linux/amd64` | Máy anh arm64, RunPod amd64. Không có cờ này thì image không chạy trên RunPod |
| `--push` | Đẩy thẳng lên hub. Không có nó thì buildx cho multi-platform image không nằm lại local được |

Lần đầu ~15-30 phút (cross-build qua QEMU chậm hơn native). Lần sau nhanh hơn
nhiều nhờ cache layer.

**B5. Kiểm tra image đã lên hub**

```bash
docker buildx imagetools inspect <dockerhub-user>/cue-render-worker:v1
```

Phải thấy `Platform: linux/amd64`. Xong bước này thì sang Bước 4, ở màn hình
RunPod chọn **Use your own Repository** → nhập tên image
`<dockerhub-user>/cue-render-worker:v1` (mục container registry, không phải
GitHub).

> **Ghi chú về Chrome trong image:** Dockerfile cài Google Chrome từ `.deb`
> chính thức của Google, **không** dùng `apt-get install chromium`. Trên Ubuntu
> 22.04, gói `chromium` của apt là **transitional package** phụ thuộc `snapd` và
> trỏ sang Chromium snap — snap không chạy trong Docker, nên đường đó hoặc fail
> build, hoặc cài ra shim và `/usr/bin/chromium` không tồn tại, worker chết lúc
> launch với *"Failed to launch the browser process"*.
> Bản `.deb` của Google chỉ có **amd64** (không có arm64), nên `FROM` đã ghim
> `--platform=linux/amd64`: build trên máy M-series **buộc** phải qua
> `buildx --platform linux/amd64`. Đó là chủ đích — image arm64 vô dụng với RunPod.

#### Sao không build sẵn image cho nhanh?

Được, nhưng thường **không cần**. Đánh đổi thật:

| | RunPod build từ GitHub | Build sẵn, push registry |
|---|---|---|
| Anh phải làm | `git push` | build + push (máy M-series → amd64, ~15-30 ph lần đầu) |
| Cần Docker Hub | Không | Có |
| Sửa `worker.mjs` | push → build lại 5-10 ph | build + push lại |
| **Sửa code render** | **Không build gì** | **Không build gì** |
| Cold start | Pull từ registry nội bộ RunPod (nhanh hơn) | Pull từ Docker Hub |
| Chạy ở nhà cung cấp khác | **KHÔNG** (xem dưới) | Có |

> **Ràng buộc cần biết trước:** tài liệu RunPod ghi *"Images built through
> Runpod's image builder service are designed exclusively for Runpod's
> infrastructure and cannot be pulled or executed on other platforms."*
> Nghĩa là image do RunPod build **không dùng được** ở Beam/Modal/VPS — muốn so
> giá nhà cung cấp thì phải build lại từ đầu. Không phải vấn đề lúc bắt đầu,
> nhưng nên biết.

Điểm mấu chốt: **worker image rất ít khi cần build lại.** Nó chỉ chứa Chromium +
~24KB script. Sửa code render (việc thường xuyên) thì chỉ cần deploy lại app —
xem "Hai image khác nhau" bên dưới.

Khuyến nghị: bắt đầu bằng GitHub build. Khi nào muốn so giá nhà cung cấp thì
lúc đó mới build tay:

```bash
# Chú ý dấu "." ở cuối — context là REPO ROOT, không phải ./render-worker
docker build -f render-worker/Dockerfile -t <user>/cue-render-worker:v1 .

# Máy M-series phải cross-build, RunPod chạy amd64:
docker buildx build --platform linux/amd64 \
  -f render-worker/Dockerfile \
  -t <user>/cue-render-worker:v1 --push .
```

#### Hai image khác nhau — worker KHÔNG build lại app

Đây là 2 image độc lập, không liên quan gì nhau:

| | App image (`./Dockerfile`) | Worker image (`render-worker/Dockerfile`) |
|---|---|---|
| Base | `node:20-alpine` | `nvidia/cuda:12.4.1-runtime-ubuntu22.04` |
| Chứa | Next.js build, `public/` (models, HDRI), sharp | Chromium + CUDA libs + 4 file `.mjs` |
| Dependencies | next, react, three, supabase… | **chỉ** `puppeteer-core` |
| Size | ~300 MB | ~2.5 GB |
| Chạy ở | VPS (không GPU) | GPU thuê |
| Chứa code render? | Có (nhưng để browser chạy) | **Không một dòng nào** |

Worker image **không** chứa `ExtractorSceneManager`, không chứa three.js, không
import gì từ `src/`. Toàn bộ code của nó là ~24KB script nói "mở URL này rồi đợi
kết quả". Code render đến từ **app của anh**, qua HTTP, lúc chạy:

```
Worker image:  Chromium + 24KB script
                    ↓
       mở https://app-cua-anh/render-worker
                    ↓
       App trên VPS trả về JS bundle
       (ExtractorSceneManager + three.js)
                    ↓
       Chromium chạy bundle đó BẰNG GPU
```

**Hệ quả thực tế:**

- Sửa code render (`src/lib/three/*`, `image-extractor.tsx`) → **deploy lại app,
  worker image không cần build lại**. Pod tiếp theo tự lấy code mới.
- Chỉ khi sửa `render-worker/*.mjs` hoặc `Dockerfile` mới phải build lại worker.
- Đây cũng là lý do ảnh server giống hệt preview: `ExtractorSceneManager` chỉ
  tồn tại **một bản duy nhất**, không có bản copy nào trong worker để lệch.

### Bước 4 — Tạo Serverless Endpoint trên RunPod

Console → **Serverless** → **New Endpoint**. Ở màn hình chọn template, kéo xuống
dưới cùng, bỏ qua toàn bộ catalog có sẵn (vLLM, ComfyUI, SDXL… — đó là image của
người khác cho AI model, không liên quan), chọn:

> **Use your own Repository** — *Deploy directly from your GitHub Repositories
> or from a Docker container registry* (nhãn `Advanced`)

Rồi kết nối GitHub và chọn repo `lehoangan1503/3d-tool`.

**Cấu hình build:**

| Field | Giá trị |
|---|---|
| Branch | `main` |
| Dockerfile Path | `render-worker/Dockerfile` |
| Build Context | để mặc định (root) — Dockerfile đã viết cho root |

Giới hạn của RunPod image builder: `docker build` phải xong trong **30 phút**,
cả quy trình trong **160 phút**, image ≤ **80GB**. Image này ~2.5GB, build ~5-10
phút — thoải mái.

**Cấu hình endpoint:**

| Field | Giá trị | Ghi chú |
|---|---|---|
| GPU | RTX 4090 (24GB) hoặc A10 | 4090 hợp nhất cho WebGL |
| Active Workers | **0** | Bắt buộc = 0 để scale-to-zero, không có job thì không tính tiền |
| Max Workers | 3–5 | **= số job song song tối đa.** Đặt bằng số product hay chọn cùng lúc thì mỗi job có pod riêng và drain không cần dùng tới |
| Idle Timeout | 5s | Chết nhanh sau khi hết việc |
| Execution Timeout | 1200s (20 phút) | Áp cho **cả pod**, không phải từng job. Phải copy đúng số này vào `RENDER_RUN_BUDGET_MS` |
| Container Disk | 20 GB | Chứa image + GLB/HDRI tải về |

**Environment Variables** (phần này quyết định chạy hay không):

```
APP_BASE_URL              = https://app-cua-anh.com
RENDER_WORKER_SECRET      = <secret ở Bước 2>
NVIDIA_DRIVER_CAPABILITIES = compute,utility,graphics,display
RENDER_ANGLE_BACKEND      = gl
WORKER_MODE               = serve      # xem ghi chú bên dưới
PORT                      = 8080
RENDER_MAX_JOBS_PER_RUN   = 5          # ảnh: 5-8 · video: 2-3 · lẫn: 3
RENDER_RUN_BUDGET_MS      = 1200000    # = Execution Timeout ở trên. Không set
                                       # là pod có thể bị kill giữa job cuối
RENDER_JOB_TIMEOUT_MS     = 1200000    # trần cho MỘT job
```

> `RENDER_RUN_BUDGET_MS` và `RENDER_JOB_TIMEOUT_MS` khác nhau:
> cái đầu là ngân sách cho **cả pod** (quyết định có nhận job mới nữa không),
> cái sau là trần cho **một job** (quyết định khi nào coi là treo).

> **Vì sao `WORKER_MODE=serve` chứ không phải `runpod`?**
> RunPod **không công bố** spec cho worker không dùng Python SDK (đã tra
> `docs.runpod.io/serverless/workers/*` và `llms.txt` — chỉ có đường Python).
> Nên `runpod-handler.mjs` là **suy đoán tên biến**, chưa kiểm chứng với endpoint
> thật. `serve` mode là HTTP thuần, chắc chắn hoạt động.
> Sai tên biến ở mode `runpod` thì worker vẫn render đúng job được giao rồi
> thoát — chỉ mất tính năng drain, không sai kết quả. Muốn dùng `runpod` mode
> thì xem log pod trước: worker in ra đúng danh sách `RUNPOD_*` mà nền tảng
> thực sự cấp.

> `NVIDIA_DRIVER_CAPABILITIES` phải có `graphics`. Mặc định thường chỉ
> `compute,utility` → thư viện GL/EGL không được mount vào container → WebGL
> không có driver nào để nói chuyện. Dockerfile đã set, nhưng set lại ở đây cho
> chắc vì một số nền tảng ghi đè.

Tạo xong, copy **Endpoint ID** (dạng `abc123xyz`) và tạo **API Key** ở
Settings → API Keys.

### Bước 5 — Cấu hình app (VPS)

Thêm vào `.env` của app rồi restart:

```bash
RENDER_WORKER_SECRET=<secret ở Bước 2>      # PHẢI giống RunPod
RENDER_GPU_PROVIDER=runpod
RUNPOD_API_KEY=<API key ở Bước 4>
RUNPOD_ENDPOINT_ID=<Endpoint ID ở Bước 4>
RENDER_APP_BASE_URL=https://app-cua-anh.com  # URL công khai
```

### Bước 6 — Test

**6a. Worker API sống chưa:**

```bash
# Sai token → phải trả 401
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer sai" \
  https://app-cua-anh.com/api/render-worker/queue-depth

# Đúng token → phải trả {"queued":0}
curl -s -H "Authorization: Bearer <secret>" \
  https://app-cua-anh.com/api/render-worker/queue-depth
```

**6b. Queue 1 job thật** (cần cookie đăng nhập — dễ nhất là mở DevTools
Console trên trang dashboard đã login rồi chạy):

```js
const r = await fetch('/api/products/<PRODUCT_ID>/renders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ groupId: '<GROUP_ID>' })
});
const data = await r.json();
console.log(data);          // { jobs: [{ id, status: 'queued', ... }] }
```

**6c. Poll:**

```js
const jobId = data.jobs[0].id;
setInterval(async () => {
  const j = await (await fetch(`/api/render-jobs/${jobId}`)).json();
  console.log(j.status, `${j.progressDone}/${j.progressTotal}`, j.progressLabel);
}, 3000);
```

**6d. Xem log pod** ở RunPod Console → Endpoint → Workers → Logs. Dòng cần tìm:

```
[worker xxx] WebGL renderer: NVIDIA GeForce RTX 4090/PCIe/SSE2 (angle=gl)
```

Thấy tên card thật = **thành công**.

---

## Phần 5 — Lỗi thường gặp

### `WARNING: software rendering — paying GPU rates for CPU speed`

Log hiện `SwiftShader` hoặc `llvmpipe` thay vì tên card. Chrome không lấy được
GPU và fallback sang CPU: **render vẫn ra ảnh nhưng chậm 10–50×** — trả giá GPU
để nhận tốc độ CPU. Đây là lỗi tốn tiền nhất vì nó không báo lỗi.

Sửa: kiểm tra `NVIDIA_DRIVER_CAPABILITIES` có `graphics`; kiểm tra endpoint thật
sự được gán GPU.

### `Chrome has no WebGL in this container`

Worker chết ngay khi bật, chưa render gì. Đây là **cố ý** — thà chết sớm và rõ
ràng còn hơn đốt tiền GPU cho những render không thể thành công.

Nguyên nhân hay gặp: `RENDER_ANGLE_BACKEND=gl` nhưng container thiếu desktop GL.
Worker đã tự thử lại với backend mặc định trước khi chết, nên nếu vẫn lỗi thì là
GPU/driver chưa vào được container.

> Ghi chú đã kiểm chứng: `--use-angle=gl` là backend đúng trên Linux+NVIDIA,
> nhưng trên macOS nó **làm `getContext("webgl")` trả về `null`** — không render
> được gì cả. Vì thế backend mới cấu hình được thay vì hard-code, và worker
> verify WebGL ngay lúc bật Chrome.

### Job kẹt `queued` mãi

Worker không nhận được poke, hoặc endpoint chưa có worker rảnh.

- Log app có `[render] dispatch to runpod failed:` → sai `RUNPOD_API_KEY` /
  `RUNPOD_ENDPOINT_ID`
- `Max Workers` = 0 → tăng lên
- Job **không mất**: dispatch thất bại thì job vẫn nằm `queued`, worker nào poll
  sau sẽ nhặt. Đây là chủ đích, để provider sập không làm mất việc.

### Chrome crash giữa render

Thiếu shared memory. Docker mặc định cho `/dev/shm` 64MB, canvas 2048×2048 cần
hơn thế. RunPod thường cấp đủ; chạy Docker tay thì phải thêm `--shm-size=2g`.

### Chữ trong mockup thành ô vuông

Thiếu font. Dockerfile đã cài `fonts-noto-core` + `fonts-noto-cjk`. Lỗi này dễ
lọt tới khi khách nhìn thấy mới biết — kiểm tra ảnh có chữ ngay lần test đầu.

### Ảnh server khác ảnh preview trong browser

Không nên xảy ra: cả hai gọi **cùng một hàm** `renderReferenceToBlob`. Nếu lệch,
nghi trước tiên là payload — `surfaceUrl` không resolve được từ container (URL
nội bộ), hoặc `threejs_settings` thiếu, làm scene dựng bằng giá trị mặc định.

---

## Phần 6 — Chi phí

RTX 4090 trên RunPod Serverless ≈ **$1.10/giờ**, tính theo giây, scale-to-zero.

Ước lượng thô cho 1 job 6 mockup:

```
cold start   ~45s
render 6 ảnh ~90s   (15s/ảnh trên 4090)
upload       ~10s
─────────────────
tổng        ~145s  ≈ $0.044/product
```

Drain giúp giảm rõ rệt: 5 product **queue cùng lúc** chỉ trả cold start 1 lần
cho mỗi card thay vì 5 lần.

Cách giữ hoá đơn thấp:
- `Active Workers = 0` — điều kiện tiên quyết, sai cái này là trả tiền 24/7
- `Idle Timeout` ngắn (5s)
- `Max Workers` đủ lớn để mỗi product có pod riêng — đây là thứ làm batch nhanh
- `RENDER_MAX_JOBS_PER_RUN` + `RENDER_RUN_BUDGET_MS` để card nóng không bỏ việc,
  mà cũng không bị kill giữa job (xem Tầng 3, Phần 3)
- Cancel job không cần nữa — worker dừng ngay ở heartbeat kế tiếp

**Về các nhà cung cấp khác trong bảng so sánh:** SaladCloud ($0.16/h) và Vast.ai
rẻ hơn nhiều nhưng là GPU consumer trên host chia sẻ, cold start dài và không
đảm bảo — không phù hợp khi có người đang ngồi đợi ảnh. Beam và Modal cũng tính
theo giây và scale-to-zero; dùng được ngay với `WORKER_MODE=serve` (xem
`render-worker/README.md`).
