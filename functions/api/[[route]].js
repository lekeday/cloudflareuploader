import worker from "../../src/index.js";

/**
 * Cloudflare Pages Functions catch-all API handler for /api/*
 */
export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  return worker.fetch(request, env, { waitUntil: (p) => waitUntil(p) });
}
