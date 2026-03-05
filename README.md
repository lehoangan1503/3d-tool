# Cue Customizer (Next.js + Supabase)

3D Pool Cue Customizer with real-time preview. Built with Next.js 14, Supabase, shadcn/ui, Tailwind CSS, and Three.js.

## Features

- 🎱 Two cue types: **Smooth** and **Leather**
- 🎨 Leather customization: texture type (crocodile/snake) + color palette
- 📷 Upload custom surface images
- 🔄 Real-time 3D preview with orbit controls
- 💾 Save products to Supabase
- 🔐 User authentication

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Database**: Supabase (PostgreSQL)
- **Auth**: Supabase Auth
- **Storage**: Supabase Storage
- **UI**: shadcn/ui + Tailwind CSS
- **3D**: Three.js

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.local` and fill in your Supabase credentials:

```env
NEXT_PUBLIC_SUPABASE_URL=http://5.223.48.44:8000
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
NEXT_PUBLIC_DB_SCHEMA=shopify_customizer
```

### 3. Set up database

Run the migration in your Supabase SQL Editor:

```bash
# Copy and paste contents of:
supabase/migrations/001_initial_schema.sql
```

### 4. Create storage bucket

In Supabase Dashboard → Storage:
1. Create bucket named `product-assets`
2. Set to **Public**
3. Add RLS policies (see migration file comments)

### 5. Run development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Project Structure

```
src/
├── app/
│   ├── api/                    # API routes
│   │   ├── products/           # CRUD for products
│   │   ├── settings/           # Three.js settings
│   │   └── upload/             # File upload
│   ├── dashboard/              # Protected pages
│   │   └── products/[id]/      # Product editor
│   └── login/                  # Auth page
├── components/
│   ├── ui/                     # shadcn components
│   ├── editor/                 # 3D editor components
│   └── products/               # Product list components
├── lib/
│   ├── supabase/               # Supabase clients
│   └── three/                  # Three.js scene manager
└── types/                      # TypeScript types

public/
├── models/                     # GLB 3D models
│   ├── cue-butt-smooth.glb
│   └── cue-butt-leather.glb
└── textures/                   # Default textures
    ├── leathers/
    └── defaults/
```

## Database Schema

Using custom schema: `shopify_customizer`

### products
| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| user_id | UUID | Owner (auth.users) |
| name | VARCHAR | Product name |
| type | VARCHAR | 'smooth' or 'leather' |
| surface_url | TEXT | Surface image URL |
| texture_type | VARCHAR | Leather texture type |
| color | VARCHAR | Leather color |

### threejs_settings
| Column | Type | Description |
|--------|------|-------------|
| name | VARCHAR | Setting name (unique) |
| settings | JSONB | Camera, lighting, etc. |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/products | List user's products |
| POST | /api/products | Create product |
| GET | /api/products/[id] | Get product |
| PUT | /api/products/[id] | Update product |
| DELETE | /api/products/[id] | Delete product |
| GET | /api/settings | Get Three.js settings |
| POST | /api/upload | Upload file to storage |

## Commands

```bash
npm run dev      # Development server
npm run build    # Production build
npm run start    # Start production server
npm run lint     # Run ESLint
```

## Notes

- Schema `shopify_customizer` is used (not `public`) for multi-project Supabase
- Storage paths: `{user_id}/{product_id}/surface.{ext}`
- RLS policies enforce user isolation
