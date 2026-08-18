/**
 * DSpace 6.x (SWORD 2.0) and DSpace 7.x (REST API) Integration Client for Cloudflare Workers.
 */

export class DSpaceClient {
  static cleanUrl(url) {
    return (url || "").trim().replace(/\/+$/, "");
  }

  static async detectVersion(baseUrl) {
    const clean = this.cleanUrl(baseUrl);
    // 1. Probe DSpace 7 REST API root
    try {
      const resp7 = await fetch(`${clean}/server/api`, {
        headers: { Accept: "application/json" },
        cf: { cacheTtl: 0 }
      });
      if (resp7.ok) {
        const data = await resp7.json();
        if (data && (data.dspaceUI || data.dspaceName || data.dspaceServer || data.dspaceVersion)) {
          return {
            version: "v7",
            details: `DSpace 7.x REST API verified at /server/api (Name: ${data.dspaceName || "DSpace"})`,
            api_base: `${clean}/server/api`
          };
        }
      }
    } catch (e) {
      // Continue to v6 check
    }

    // 2. Probe DSpace 6 SWORD 2.0 root
    try {
      const resp6 = await fetch(`${clean}/swordv2/servicedocument`, {
        cf: { cacheTtl: 0 }
      });
      if (resp6.status === 200 || resp6.status === 401) {
        return {
          version: "v6",
          details: "DSpace 6.x SWORD 2.0 endpoint detected at /swordv2",
          api_base: `${clean}/swordv2`
        };
      }
    } catch (e) {
      // Ignored
    }

    return {
      version: "unknown",
      details: "Could not automatically determine DSpace version.",
      api_base: clean
    };
  }

  static async v7Login(baseUrl, user, password) {
    const clean = this.cleanUrl(baseUrl);
    const body = new URLSearchParams({ user, password });

    try {
      const resp = await fetch(`${clean}/server/api/authn/login`, {
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
    const clean = this.cleanUrl(baseUrl);
    const headers = { Accept: "application/json" };
    if (token) headers["Authorization"] = token;

    const tree = [];
    let page = 0;
    const size = 50;

    try {
      while (true) {
        const url = `${clean}/server/api/core/communities?page=${page}&size=${size}`;
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
    const clean = this.cleanUrl(baseUrl);
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
      const itemUrl = `${clean}/server/api/core/items?owningCollection=${encodeURIComponent(collectionUuid)}`;
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
        const uploadBundleUrl = `${clean}/server/api/core/items/${itemUuid}/bundles`;
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
          const bitstreamUrl = `${clean}/server/api/core/bundles/${originalBundleUuid}/bitstreams?name=${encodeURIComponent(fileName)}`;
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
