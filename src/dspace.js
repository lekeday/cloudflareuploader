/**
 * DSpace 6.x (SWORD 2.0) and DSpace 7.x (REST API) Integration Client for Cloudflare Workers.
 */

export class DSpaceClient {
  static _apiBaseCache = new Map();

  static cleanUrl(url) {
    return (url || "").trim().replace(/\/+$/, "");
  }

  static async resolveApiBase(baseUrl) {
    const clean = this.cleanUrl(baseUrl);
    if (this._apiBaseCache.has(clean)) {
      return this._apiBaseCache.get(clean);
    }

    let urlObj;
    try {
      urlObj = new URL(clean);
    } catch {
      return `${clean}/server/api`;
    }

    const candidates = [];
    if (urlObj.port === "4000" || clean.includes("/home")) {
      const proto = urlObj.protocol;
      const host = urlObj.hostname;
      candidates.push(
        `${proto}//${host}:8080/server/api`,
        `${proto}//${host}:8080/server`,
        `${proto}//${host}:8080/api`
      );
    }

    candidates.push(
      `${clean}/server/api`,
      `${clean}/server`,
      `${clean}/api`,
      clean
    );

    for (const ep of candidates) {
      try {
        const resp = await fetch(ep, {
          headers: { Accept: "application/json" },
          cf: { cacheTtl: 0 }
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && (data.dspaceUI || data.dspaceName || data.dspaceServer || data.dspaceVersion || data._links)) {
            let resolved = ep.replace(/\/+$/, "");
            if (data.dspaceServer) {
              resolved = `${data.dspaceServer.replace(/\/+$/, "")}/api`;
            }
            this._apiBaseCache.set(clean, resolved);
            return resolved;
          }
        }
      } catch {
        // Try next candidate
      }
    }

    const fallback = urlObj.port === "4000"
      ? `${urlObj.protocol}//${urlObj.hostname}:8080/server/api`
      : `${clean}/server/api`;

    this._apiBaseCache.set(clean, fallback);
    return fallback;
  }

  static async detectVersion(baseUrl) {
    const clean = this.cleanUrl(baseUrl);
    let urlObj;
    try {
      urlObj = new URL(clean);
    } catch {
      urlObj = null;
    }

    // 1. Probe DSpace 7+ REST API root endpoints
    const apiCandidates = [];
    if (urlObj && (urlObj.port === "4000" || clean.includes("/home"))) {
      const proto = urlObj.protocol;
      const host = urlObj.hostname;
      apiCandidates.push(
        `${proto}//${host}:8080/server/api`,
        `${proto}//${host}:8080/server`,
        `${proto}//${host}:8080/api`
      );
    }

    apiCandidates.push(
      `${clean}/server/api`,
      `${clean}/server`,
      `${clean}/api`,
      clean
    );

    for (const ep of apiCandidates) {
      try {
        const resp7 = await fetch(ep, {
          headers: { Accept: "application/json" },
          cf: { cacheTtl: 0 }
        });
        if (resp7.ok) {
          const data = await resp7.json();
          if (data && (data.dspaceUI || data.dspaceName || data.dspaceServer || data.dspaceVersion || data._links)) {
            const dName = data.dspaceName || "DSpace Repository";
            const dVer = data.dspaceVersion || "DSpace 7.x/8.x";
            let apiBase = ep.replace(/\/+$/, "");
            if (data.dspaceServer) {
              apiBase = `${data.dspaceServer.replace(/\/+$/, "")}/api`;
            }
            this._apiBaseCache.set(clean, apiBase);
            return {
              version: "v7",
              details: `${dVer} REST API verified at ${apiBase} (${dName})`,
              api_base: apiBase
            };
          }
        }
      } catch {
        // Continue probing
      }
    }

    // 2. Probe DSpace 6 SWORD 2.0 root
    const swordCandidates = [
      `${clean}/swordv2/servicedocument`,
      `${clean}/swordv2`,
      `${clean}/rest`
    ];

    for (const ep of swordCandidates) {
      try {
        const resp6 = await fetch(ep, {
          cf: { cacheTtl: 0 }
        });
        if (resp6.status === 200 || resp6.status === 401) {
          return {
            version: "v6",
            details: `DSpace 6.x SWORD 2.0 endpoint detected at ${ep}`,
            api_base: clean
          };
        }
      } catch {
        // Ignored
      }
    }

    // 3. Probe frontend HTML
    try {
      const respHtml = await fetch(clean, {
        headers: { Accept: "text/html" },
        cf: { cacheTtl: 0 }
      });
      if (respHtml.ok) {
        const html = await respHtml.text();
        const fallbackV7 = (urlObj && urlObj.port === "4000")
          ? `${urlObj.protocol}//${urlObj.hostname}:8080/server/api`
          : `${clean}/server/api`;

        if (html.includes("ds-root") || html.includes("dspace-angular") || html.includes("ds-header") || (html.includes("app-root") && html.toLowerCase().includes("dspace"))) {
          this._apiBaseCache.set(clean, fallbackV7);
          return {
            version: "v7",
            details: "DSpace 7.x/8.x Angular UI detected from web page inspection",
            api_base: fallbackV7
          };
        }

        if (html.toLowerCase().includes("xmlui") || html.toLowerCase().includes("jspui")) {
          return {
            version: "v6",
            details: "DSpace 6.x / XMLUI detected from web page metadata",
            api_base: clean
          };
        }
      }
    } catch {
      // Ignored
    }

    return {
      version: "unknown",
      details: "Could not automatically determine DSpace version.",
      api_base: clean
    };
  }

  static async v7Login(baseUrl, user, password) {
    const apiBase = await this.resolveApiBase(baseUrl);
    const body = new URLSearchParams({ user, password });

    try {
      const resp = await fetch(`${apiBase}/authn/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      });

      const token = resp.headers.get("Authorization") || resp.headers.get("authorization");
      if (token) {
        return { success: true, token };
      }
      const setCookie = resp.headers.get("set-cookie") || "";
      const dspaceXsrf = setCookie.match(/DSPACE-XSRF-COOKIE=([^;]+)/);
      return { 
        success: resp.ok, 
        token: token || (dspaceXsrf ? dspaceXsrf[1] : null),
        error: resp.ok ? null : `HTTP ${resp.status}: Login rejected` 
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  static async v7GetCommunityTree(baseUrl, token = null) {
    const apiBase = await this.resolveApiBase(baseUrl);
    const headers = { Accept: "application/json" };
    if (token) headers["Authorization"] = token;

    const tree = [];
    let page = 0;
    const size = 50;

    try {
      while (true) {
        const url = `${apiBase}/core/communities?page=${page}&size=${size}`;
        const resp = await fetch(url, { headers });
        if (!resp.ok) break;

        const data = await resp.json();
        const communities = data?._embedded?.communities || [];
        if (communities.length === 0) break;

        for (const comm of communities) {
          const commNode = {
            uuid: comm.uuid,
            name: comm.name,
            handle: comm.handle,
            type: "community",
            collections: []
          };

          // Fetch collections inside this community
          if (comm._links?.collections?.href) {
            try {
              const colResp = await fetch(comm._links.collections.href, { headers });
              if (colResp.ok) {
                const colData = await colResp.json();
                const cols = colData?._embedded?.collections || [];
                commNode.collections = cols.map(c => ({
                  uuid: c.uuid,
                  name: c.name,
                  handle: c.handle,
                  type: "collection"
                }));
              }
            } catch (err) {
              console.error("Error fetching community collections:", err);
            }
          }
          tree.push(commNode);
        }

        if (page >= (data?.page?.totalPages || 1) - 1) break;
        page++;
      }

      return { success: true, version: "v7", tree };
    } catch (e) {
      return { success: false, error: e.message, tree: [] };
    }
  }

  static async v7UploadItem(baseUrl, token, collectionUuid, metadata, fileBytes, fileName) {
    const apiBase = await this.resolveApiBase(baseUrl);
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json"
    };
    if (token) headers["Authorization"] = token;

    // 1. Build Dublin Core metadata structure for DSpace 7
    const dcMetadata = {};
    const addMeta = (field, val) => {
      if (!val) return;
      dcMetadata[field] = [{ value: String(val).trim(), language: "en", authority: null, confidence: -1 }];
    };

    addMeta("dc.title", metadata.title || fileName);
    addMeta("dc.contributor.author", metadata.author);
    addMeta("dc.identifier.isbn", metadata.isbn);
    addMeta("dc.type", metadata.doc_type || "Book");
    addMeta("dc.subject", metadata.subject);
    addMeta("dc.publisher", metadata.publisher);
    addMeta("dc.date.issued", metadata.date);
    addMeta("dc.description.abstract", metadata.abstract);
    addMeta("dc.language.iso", metadata.language || "en");

    const itemBody = {
      name: metadata.title || fileName,
      metadata: dcMetadata,
      inArchive: true,
      discoverable: true,
      withdrawn: false,
      type: "item"
    };

    try {
      // Step 1: Create Item in Collection
      const itemUrl = `${apiBase}/core/items?owningCollection=${encodeURIComponent(collectionUuid)}`;
      const createResp = await fetch(itemUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(itemBody)
      });

      if (!createResp.ok) {
        const errorText = await createResp.text();
        return { success: false, error: `Failed to create item (HTTP ${createResp.status}): ${errorText}` };
      }

      const itemData = await createResp.json();
      const itemUuid = itemData.uuid;
      const itemHandle = itemData.handle;

      // Step 2: Upload Bitstream (Attachment)
      let bitstreamSuccess = false;
      let bitstreamMessage = "";

      if (fileBytes && fileBytes.byteLength > 0) {
        const uploadBundleUrl = `${apiBase}/core/items/${itemUuid}/bundles`;
        const bundleResp = await fetch(uploadBundleUrl, { headers });
        let originalBundleUuid = null;

        if (bundleResp.ok) {
          const bundleData = await bundleResp.json();
          const bundles = bundleData?._embedded?.bundles || [];
          const original = bundles.find(b => b.name === "ORIGINAL");
          if (original) originalBundleUuid = original.uuid;
        }

        if (!originalBundleUuid) {
          const createBundleResp = await fetch(uploadBundleUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({ name: "ORIGINAL", metadata: {} })
          });
          if (createBundleResp.ok) {
            const bData = await createBundleResp.json();
            originalBundleUuid = bData.uuid;
          }
        }

        if (originalBundleUuid) {
          const bitstreamUrl = `${apiBase}/core/bundles/${originalBundleUuid}/bitstreams?name=${encodeURIComponent(fileName)}`;
          const formData = new FormData();
          formData.append("file", new Blob([fileBytes], { type: "application/pdf" }), fileName);

          const bitstreamResp = await fetch(bitstreamUrl, {
            method: "POST",
            headers: token ? { "Authorization": token } : {},
            body: formData
          });

          if (bitstreamResp.ok) {
            bitstreamSuccess = true;
          } else {
            bitstreamMessage = `Item created (${itemUuid}), but bitstream upload returned HTTP ${bitstreamResp.status}`;
          }
        }
      }

      return {
        success: true,
        item_uuid: itemUuid,
        item_handle: itemHandle || itemUuid,
        message: bitstreamSuccess ? "Upload successful with bitstream" : (bitstreamMessage || "Item metadata published successfully")
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  static async v6SwordUploadItem(baseUrl, user, password, collectionHandle, metadata, fileBytes, fileName) {
    const clean = this.cleanUrl(baseUrl);
    const authHeader = "Basic " + btoa(`${user}:${password}`);
    const colUrl = `${clean}/swordv2/collection/${collectionHandle}`;

    // Construct Atom Entry XML with Dublin Core metadata
    const atomXml = `<?xml version="1.0" encoding="utf-8"?>
<entry xmlns="http://www.w3.org/2005/Atom" xmlns:dcterms="http://purl.org/dc/terms/">
  <title>${escapeXml(metadata.title || fileName)}</title>
  <author><name>${escapeXml(metadata.author || "Unknown")}</name></author>
  <dcterms:type>${escapeXml(metadata.doc_type || "Book")}</dcterms:type>
  <dcterms:language>${escapeXml(metadata.language || "en")}</dcterms:language>
  ${metadata.isbn ? `<dcterms:identifier>ISBN:${escapeXml(metadata.isbn)}</dcterms:identifier>` : ''}
  ${metadata.publisher ? `<dcterms:publisher>${escapeXml(metadata.publisher)}</dcterms:publisher>` : ''}
  ${metadata.date ? `<dcterms:issued>${escapeXml(metadata.date)}</dcterms:issued>` : ''}
  ${metadata.abstract ? `<summary>${escapeXml(metadata.abstract)}</summary>` : ''}
</entry>`;

    try {
      const resp = await fetch(colUrl, {
        method: "POST",
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/atom+xml;type=entry",
          "Accept": "application/atom+xml"
        },
        body: atomXml
      });

      if (!resp.ok && resp.status !== 201) {
        const errorText = await resp.text();
        return { success: false, error: `SWORD 2.0 error (HTTP ${resp.status}): ${errorText}` };
      }

      const responseXml = await resp.text();
      const handleMatch = responseXml.match(/<id>([^<]+)<\/id>/);
      const identifier = handleMatch ? handleMatch[1] : collectionHandle;

      return {
        success: true,
        item_handle: identifier,
        message: "Successfully submitted via SWORD 2.0"
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

function escapeXml(unsafe) {
  if (!unsafe) return "";
  return String(unsafe).replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}
