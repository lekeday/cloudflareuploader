# DSpace Ebook Uploader (Cloudflare Workers + D1 Serverless Edition)

A 100% serverless, zero-Django edition of the DSpace Ebook Uploader powered by:
- **Cloudflare Workers**: High-performance edge API runtime and proxy to DSpace 6.x / 7.x.
- **Cloudflare D1**: Serverless SQLite database at the edge for storing repository connection profiles and upload logs.
- **Cloudflare Pages / Workers Assets**: Serves the single-page application with Tailwind CSS, Alpine.js, Lucide icons, and in-browser PDF.js metadata extraction.

---

## 📁 Directory Structure

```
cloudflare/
├── package.json           # NPM scripts and Wrangler dependency
├── wrangler.toml          # Worker & D1 database bindings
├── schema.sql             # D1 SQLite table definitions
├── src/
│   ├── index.js           # Worker API router & request dispatcher
│   ├── dspace.js          # DSpace 6 SWORD 2.0 & DSpace 7 REST API client
│   └── crypto.js          # Web Crypto AES-GCM credential encryption
└── public/
    └── index.html         # Rich frontend SPA (Tailwind + Alpine + PDF.js)
```

---

## 🚀 Quickstart & Local Development

### 1. Install Dependencies
```bash
cd cloudflare
npm install
```

### 2. Initialize Local D1 Database
Create the tables in your local Wrangler D1 SQLite environment:
```bash
npx wrangler d1 execute dspace-db --local --file=schema.sql
```

### 3. Run Locally with Wrangler
```bash
npm run dev
# Or: npx wrangler dev
```
Open your browser at `http://localhost:8787`.

---

## 🛡️ Best Practices Implemented

### 1. Database Backups & Point-in-Time Recovery
- **Automated Cloudflare Backups**: Cloudflare D1 automatically captures hourly snapshots.
- **Bookmarks Before Migrations**:
  In the D1 console, run:
  ```sql
  /bookmark
  ```
  To restore back to any bookmark:
  ```sql
  /restore <bookmark-id>
  ```
- **Exporting DB Dumps**:
  ```bash
  npx wrangler d1 export dspace-db --output=backup.sql
  ```

### 2. Large PDF Handling (100MB+) via Cloudflare R2
- The worker natively supports **Cloudflare R2** staging buckets for large PDF bitstreams.
- To enable, create an R2 bucket (`npx wrangler r2 bucket create dspace-large-files`) and bind it in Cloudflare Dashboard → Settings → Bindings → R2 Bucket (`BUCKET`).

### 3. Batch Limits & Staggered Concurrency
- The UI contains a **concurrency throttle** (default 3 parallel workers).
- Uploads are dispatched asynchronously with non-blocking workers so target DSpace instances are not overwhelmed with concurrent connection bursts.
