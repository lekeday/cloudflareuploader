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

## ☁️ Deployment to Cloudflare

### 1. Login to Cloudflare
```bash
npx wrangler login
```

### 2. Create the Production D1 Database
```bash
npx wrangler d1 create dspace-db
```
Copy the `database_id` returned in the terminal output and paste it into [`cloudflare/wrangler.toml`](file:///home/leke/apps/AI/dspace/cloudflare/wrangler.toml):
```toml
[[d1_databases]]
binding = "DB"
database_name = "dspace-db"
database_id = "<YOUR_PRODUCTION_D1_DATABASE_ID>"
```

### 3. Apply Schema to Production D1
```bash
npx wrangler d1 execute dspace-db --remote --file=schema.sql
```

### 4. Deploy
```bash
npm run deploy
```
Your application will be live globally on your `*.workers.dev` subdomain!
