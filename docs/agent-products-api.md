# Cue products API — guide for agents

Use this API to create, update the template of, and delete **3D cue products**.
The operator may give instructions in Vietnamese ("thay ảnh", "xoá sản phẩm"...).

- Base URL: `<BASE_URL>` (e.g. `https://app-cua-anh.com`)
- Every request needs the header: `Authorization: Bearer <TOKEN>` (token starts with `cue_live_`)
- Errors always return JSON: `{ "error": "..." }` — read the message, it explains what to fix.

---

## 1. Create a product from a template image

`POST /api/v1/products` — `multipart/form-data`

| Field | Required | Value |
|---|---|---|
| `file` | yes | JPEG / PNG / WebP, max 25MB |
| `type` | yes | `leather` (gậy da) · `smooth` (gậy trơn) · `lizard` (gậy da lizard) |
| `name` | no | Product name; defaults to the file name |
| `name_prefix` | no | e.g. `n02`; defaults to the token's prefix |

```bash
curl -X POST <BASE_URL>/api/v1/products \
  -H "Authorization: Bearer <TOKEN>" \
  -F file=@dragon.jpg -F type=leather
```

→ `201` `{ id, name, type, surface_url, created_at, editor_url }`. **Keep the `id`.**

## 2. Replace the template image of an existing product

`PUT /api/v1/products/<name-or-id>` — `multipart/form-data`, one field: `file`

```bash
curl -X PUT <BASE_URL>/api/v1/products/n02-dragon \
  -H "Authorization: Bearer <TOKEN>" \
  -F file=@dragon-v2.jpg
```

→ `200` `{ id, name, surface_url, previous_surface_url, updated_at, editor_url, shopify_stores, shopify_sync }`

The new image is wrapped on the 3D cue in the app right away. For the **live
Shopify store**, read `shopify_sync`:

| `shopify_sync` | Meaning | Tell the operator |
|---|---|---|
| `auto` | Same format as before (jpg→jpg) — the store's 3D updates by itself | "Store updates within ~1 hour (cache)" |
| `redeploy_required` | Format changed (e.g. png→jpg) — store still shows the old image | "Redeploy the product from the app to update the store" |
| `not_deployed` | Not on Shopify | nothing |

Tip: to avoid `redeploy_required`, send the new image in the **same format** as the old one
(check the extension of `previous_surface_url`).
Only the 3D template changes — 2D mockup images on the store stay as they were.

## 3. Check whether a product is deployed to Shopify

`GET /api/v1/products/<name-or-id>/shopify` — optional `?store=<store-id>` to ask about one store

```bash
curl <BASE_URL>/api/v1/products/n02-dragon/shopify \
  -H "Authorization: Bearer <TOKEN>"
```

→ `200`
```json
{
  "product_id": "3f9a…",
  "name": "n02-dragon",
  "deployed": true,
  "store": null,
  "deployments": [
    { "store": "main", "shopify_product_id": 812345, "title": "…", "handle": "…",
      "admin_url": "…", "storefront_url": "…", "deployed_at": "…" }
  ]
}
```

`deployed` is the answer (`true` / `false`). A product only saved as a draft, or
already removed from Shopify, is `false`. Check this **before DELETE** — a deployed
product cannot be deleted.

## 4. Delete a product

`DELETE /api/v1/products/<name-or-id>` — no body

```bash
curl -X DELETE <BASE_URL>/api/v1/products/n02-dragon \
  -H "Authorization: Bearer <TOKEN>"
```

→ `200` `{ id, name, deleted: true, removed_files }`

**A product deployed to Shopify can NOT be deleted** → `409` with `shopify_stores`.
There is no override. Tell the operator it must be removed from Shopify first — do not retry.

---

## Identifying a product (`<name-or-id>`)

- **Name** (e.g. `n02-dragon`): case- and accent-insensitive, matches only the token owner's own products. URL-encode it if it contains spaces.
- **Id** (UUID): use this for products owned by someone else (admin tokens only), or when a name is ambiguous.
- If a name matches several products, the `400` error lists their ids — pick one and retry with the id. Never guess.

## Permissions

| Who | Replace image | Delete |
|---|---|---|
| Product owner | ✅ | ✅ (unless deployed to Shopify) |
| Admin token | ✅ any product | ✅ any product (unless deployed to Shopify) |
| Anyone else | `404` | `404` |

## Status codes

| Code | Meaning | What to do |
|---|---|---|
| `400` | Missing/invalid `file` or `type`, not multipart, ambiguous name, or unknown `store` | Fix the request per the message |
| `401` | Missing, wrong or revoked token | Ask the operator for a valid token |
| `404` | Product not found (or not yours) | Check the name / use the id |
| `409` | Delete refused: product is on Shopify | Stop, report to the operator |
| `413` | File over 25MB | Compress the image |
| `5xx` | Server error | Retry once; if it fails again, report the message |

## Rules for agents

- Confirm with the operator before **DELETE** — it is permanent (files included).
- One product per request; for several, call once per product.
- Report the `editor_url` back so a human can check the result.
