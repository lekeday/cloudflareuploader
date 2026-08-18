import { encryptPassword, decryptPassword } from "./crypto.js";
import { DSpaceClient } from "./dspace.js";

/**
 * Cloudflare Worker API & Static Asset Router
 */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key"
    }
  });
}

function handleCors(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
        "Access-Control-Max-Age": "86400"
      }
    });
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const cors = handleCors(request);
    if (cors) return cors;

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const db = env.DB;
    const secret = env.ENCRYPTION_SECRET || "dspace-edge-secret-2026";

    try {
      // 1. Health & Database Backup Status Check
      if (path === "/api/health" && method === "GET") {
        return jsonResponse({ 
          status: "healthy", 
          engine: "ekunstech-edge-d1", 
          r2_available: Boolean(env.BUCKET || env.R2_BUCKET),
          timestamp: new Date().toISOString() 
        });
      }

      // 1b. D1 Automated Backup Bookmark
      if (path === "/api/db/bookmark" && method === "GET") {
        return jsonResponse({
          success: true,
          bookmark_timestamp: new Date().toISOString(),
          message: "Use this RFC3339 timestamp in D1 console: /bookmark <timestamp> to time travel or restore."
        });
      }

      // 2. Configurations API
      if (path === "/api/configs" && method === "GET") {
        if (!db) return jsonResponse({ success: false, error: "D1 Database binding 'DB' not configured." }, 500);
        const { results } = await db.prepare("SELECT id, name, url, username, detected_version, is_active, created_at FROM dspace_configs WHERE is_active = 1 ORDER BY id DESC").all();
        return jsonResponse({ success: true, configs: results || [] });
      }

      if (path === "/api/configs" && method === "POST") {
        if (!db) return jsonResponse({ success: false, error: "D1 Database binding 'DB' not configured." }, 500);
        const payload = await request.json();
        const encryptedPass = await encryptPassword(payload.password || "", secret);

        const stmt = db.prepare(
          "INSERT INTO dspace_configs (name, url, username, encrypted_password, detected_version) VALUES (?, ?, ?, ?, ?)"
        );
        const result = await stmt.bind(
          payload.name || "Default Repository",
          payload.url,
          payload.username,
          encryptedPass,
          payload.detected_version || "unknown"
        ).run();

        return jsonResponse({
          success: true,
          config: {
            id: result.meta?.last_row_id,
            name: payload.name,
            url: payload.url,
            username: payload.username,
            detected_version: payload.detected_version || "unknown"
          }
        });
      }

      // Helper to retrieve credentials from D1
      async function resolveConfig(configId, fallbackUrl) {
        if (configId && db) {
          const row = await db.prepare("SELECT * FROM dspace_configs WHERE id = ?").bind(configId).first();
          if (row) {
            const pass = await decryptPassword(row.encrypted_password, secret);
            return { url: row.url, username: row.username, password: pass, version: row.detected_version };
          }
        }
        if (fallbackUrl && db) {
          const row = await db.prepare("SELECT * FROM dspace_configs WHERE url = ? AND is_active = 1 LIMIT 1").bind(fallbackUrl).first();
          if (row) {
            const pass = await decryptPassword(row.encrypted_password, secret);
            return { url: row.url, username: row.username, password: pass, version: row.detected_version };
          }
        }
        return { url: fallbackUrl || "", username: "", password: "", version: "unknown" };
      }

      // 3. Detect DSpace Version
      if (path === "/api/detect-version" && method === "POST") {
        const payload = await request.json();
        const cfg = await resolveConfig(payload.config_id, payload.url);
        const det = await DSpaceClient.detectVersion(cfg.url);

        // Optionally update config record in D1
        if (payload.config_id && det.version !== "unknown" && db) {
          await db.prepare("UPDATE dspace_configs SET detected_version = ?, api_details = ? WHERE id = ?")
            .bind(det.version, det.details, payload.config_id).run();
        }

        return jsonResponse(det);
      }

      // 4. Hierarchy Tree (DSpace 7)
      if (path === "/api/hierarchy" && method === "POST") {
        const payload = await request.json();
        const cfg = await resolveConfig(payload.config_id, payload.url);
        const login = await DSpaceClient.v7Login(cfg.url, cfg.username, cfg.password);
        const treeResult = await DSpaceClient.v7GetCommunityTree(cfg.url, login.token);
        return jsonResponse(treeResult);
      }

      // 5. Fetch Collections
      if (path === "/api/fetch-collections" && method === "POST") {
        const payload = await request.json();
        const cfg = await resolveConfig(payload.config_id, payload.url);
        const det = await DSpaceClient.detectVersion(cfg.url);

        if (det.version === "v7") {
          const login = await DSpaceClient.v7Login(cfg.url, cfg.username, cfg.password);
          if (!login.success) {
            return jsonResponse({ success: false, error: login.error, version: "v7", collections: [] });
          }
          const treeResult = await DSpaceClient.v7GetCommunityTree(cfg.url, login.token);
          const collections = [];
          for (const comm of treeResult.tree || []) {
            for (const col of comm.collections || []) {
              collections.push({ ...col, community_name: comm.name });
            }
          }
          return jsonResponse({ success: true, version: "v7", collections });
        }

        return jsonResponse({ success: true, version: "v6", collections: [] });
      }

      // 6. ISBN Lookup (OpenLibrary)
      if (path === "/api/lookup-isbn" && method === "POST") {
        const payload = await request.json();
        const cleanIsbn = (payload.isbn || "").replace(/[^0-9X-]/gi, "");
        if (!cleanIsbn) return jsonResponse({ success: false, error: "Invalid ISBN" }, 400);

        try {
          const olResp = await fetch(`https://openlibrary.org/isbn/${cleanIsbn}.json`);
          if (olResp.ok) {
            const data = await olResp.json();
            let author = "";
            if (data.authors && data.authors.length > 0) {
              try {
                const aResp = await fetch(`https://openlibrary.org${data.authors[0].key}.json`);
                if (aResp.ok) {
                  const aData = await aResp.json();
                  author = aData.name || "";
                }
              } catch (e) {}
            }

            return jsonResponse({
              success: true,
              metadata: {
                title: data.title || "",
                author: author,
                publisher: (data.publishers && data.publishers[0]) || "",
                date: data.publish_date || "",
                isbn: cleanIsbn,
                doc_type: "Book"
              }
            });
          }
        } catch (e) {
          // Fallback
        }

        return jsonResponse({ success: false, error: `No metadata found for ISBN ${cleanIsbn}` });
      }

      // 7. Upload Single / Bulk Ebook Item
      if (path === "/api/upload-ebook" && method === "POST") {
        const contentType = request.headers.get("content-type") || "";
        let payload = {};
        let fileBytes = null;
        let fileName = "ebook.pdf";

        if (contentType.includes("multipart/form-data")) {
          const formData = await request.formData();
          const metadataStr = formData.get("metadata") || "{}";
          payload = JSON.parse(metadataStr);
          const file = formData.get("file");
          if (file && typeof file === "object" && file.arrayBuffer) {
            fileBytes = await file.arrayBuffer();
            fileName = file.name || payload.filename || "ebook.pdf";
          }
        } else {
          payload = await request.json();
          fileName = payload.filename || "ebook.pdf";
        }

        // Optional: Cloudflare R2 Staging for large files (> 25MB or on-demand)
        const r2 = env.BUCKET || env.R2_BUCKET;
        let r2ObjectKey = null;
        if (r2 && fileBytes && fileBytes.byteLength > 0) {
          try {
            r2ObjectKey = `staging/${Date.now()}-${encodeURIComponent(fileName)}`;
            await r2.put(r2ObjectKey, fileBytes, {
              httpMetadata: { contentType: "application/pdf" },
              customMetadata: { title: payload.title || fileName, uploader: "dspace-worker" }
            });
          } catch (r2Err) {
            console.warn("R2 Staging Warning (proceeding with direct stream):", r2Err);
          }
        }

        const cfg = await resolveConfig(payload.config_id, payload.url);
        const version = payload.version || cfg.version || "v7";
        const collIdentifier = payload.collection_identifier;

        let uploadRes = { success: false, error: "Unsupported version" };

        if (version === "v7") {
          const login = await DSpaceClient.v7Login(cfg.url, cfg.username, cfg.password);
          if (!login.success) {
            uploadRes = { success: false, error: `DSpace 7 authentication failed: ${login.error}` };
          } else {
            uploadRes = await DSpaceClient.v7UploadItem(
              cfg.url,
              login.token,
              collIdentifier,
              payload,
              fileBytes,
              fileName
            );
          }
        } else if (version === "v6") {
          uploadRes = await DSpaceClient.v6SwordUploadItem(
            cfg.url,
            cfg.username,
            cfg.password,
            collIdentifier,
            payload,
            fileBytes,
            fileName
          );
        }

        // Record to D1 Database
        if (db) {
          const status = uploadRes.success ? "success" : "failed";
          const itemHandleOrUuid = uploadRes.item_handle || uploadRes.item_uuid || "";
          const responseMsg = uploadRes.message || uploadRes.error || "";

          await db.prepare(`
            INSERT INTO upload_logs 
            (filename, filepath, title, author, isbn, department, dspace_version, file_size_bytes, status, item_handle_or_uuid, response_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            fileName,
            payload.filepath || fileName,
            payload.title || fileName,
            payload.author || "",
            payload.isbn || "",
            payload.department || "General",
            version,
            fileBytes ? fileBytes.byteLength : (payload.file_size || 0),
            status,
            itemHandleOrUuid,
            responseMsg
          ).run();
        }

        return jsonResponse(uploadRes, uploadRes.success ? 200 : 400);
      }

      // 8. Upload History API
      if (path === "/api/history" && method === "GET") {
        if (!db) return jsonResponse({ success: true, logs: [] });
        const { results } = await db.prepare(
          "SELECT id, filename, title, author, department, dspace_version, status, item_handle_or_uuid as item_identifier, response_message, uploaded_at FROM upload_logs ORDER BY id DESC LIMIT 50"
        ).all();

        return jsonResponse({ success: true, logs: results || [] });
      }

      // 9. Active Uploads Status API
      if (path === "/api/active-uploads" && method === "GET") {
        if (!db) return jsonResponse({ success: true, active_count: 0, logs: [] });
        const { results } = await db.prepare(
          "SELECT id, filename, title, department, status, uploaded_at FROM upload_logs WHERE status IN ('pending', 'uploading') ORDER BY id DESC"
        ).all();

        return jsonResponse({ success: true, active_count: (results || []).length, logs: results || [] });
      }

      // 10. Fallback: Serve static UI files from env.ASSETS (Cloudflare Pages / Workers Assets)
      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("Worker Execution Error:", err);
      return jsonResponse({ success: false, error: err.message, stack: err.stack }, 500);
    }
  }
};
