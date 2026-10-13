// On-page SEO audit using Cloudflare's streaming HTMLRewriter.
// The page is parsed as it streams in — no DOM library, no headless browser.

export interface PageSignals {
  url: string;
  finalUrl: string;
  status: number;
  ttfbMs: number;
  bytes: number;
  title: string;
  metaDescription: string;
  canonical: string;
  robots: string;
  lang: string;
  viewport: boolean;
  h1: string[];
  h2Count: number;
  images: number;
  imagesMissingAlt: number;
  internalLinks: number;
  externalLinks: number;
  ogTitle: string;
  ogImage: string;
  schemaTypes: string[];
  wordCount: number;
}

export interface Check {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface AuditResult {
  signals: PageSignals;
  checks: Check[];
  score: number;
  auditedAt: string;
}

const BLOCKED_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

export function validateTarget(raw: string | null): URL {
  if (!raw) throw new HttpError(400, "Missing ?url= parameter");
  let u: URL;
  try {
    u = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, "Invalid URL");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new HttpError(400, "Only http(s) URLs are allowed");
  if (BLOCKED_HOST.test(u.hostname)) throw new HttpError(400, "Private or local hosts are not allowed");
  u.hash = "";
  return u;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function auditUrl(target: URL): Promise<AuditResult> {
  const started = Date.now();
  const res = await fetch(target.toString(), {
    redirect: "follow",
    headers: {
      "User-Agent": "EdgeSEOToolkit/1.0 (+https://github.com/Zimtech-Business-Solutions/edge-seo-toolkit)",
      Accept: "text/html,application/xhtml+xml",
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  const ttfbMs = Date.now() - started;

  const type = res.headers.get("content-type") || "";
  if (!type.includes("html")) throw new HttpError(422, `Target did not return HTML (${type || "unknown type"})`);

  const finalUrl = new URL(res.url || target.toString());
  const s: PageSignals = {
    url: target.toString(),
    finalUrl: finalUrl.toString(),
    status: res.status,
    ttfbMs,
    bytes: 0,
    title: "",
    metaDescription: "",
    canonical: "",
    robots: "",
    lang: "",
    viewport: false,
    h1: [],
    h2Count: 0,
    images: 0,
    imagesMissingAlt: 0,
    internalLinks: 0,
    externalLinks: 0,
    ogTitle: "",
    ogImage: "",
    schemaTypes: [],
    wordCount: 0,
  };

  let inTitle = false;
  let h1Buf: string | null = null;
  let ldBuf: string | null = null;
  let skipDepth = 0;
  const ldBlocks: string[] = [];
  let bodyText = "";

  const rewriter = new HTMLRewriter()
    .on("html", { element: (el) => { s.lang = el.getAttribute("lang") || ""; } })
    .on("title", {
      element: (el) => { inTitle = true; el.onEndTag(() => { inTitle = false; }); },
      text: (t) => { if (inTitle) s.title += t.text; },
    })
    .on("meta", {
      element: (el) => {
        const name = (el.getAttribute("name") || "").toLowerCase();
        const prop = (el.getAttribute("property") || "").toLowerCase();
        const content = el.getAttribute("content") || "";
        if (name === "description") s.metaDescription = content;
        if (name === "robots") s.robots = content;
        if (name === "viewport") s.viewport = true;
        if (prop === "og:title") s.ogTitle = content;
        if (prop === "og:image") s.ogImage = content;
      },
    })
    .on('link[rel="canonical"]', { element: (el) => { s.canonical = el.getAttribute("href") || ""; } })
    .on("h1", {
      element: (el) => { h1Buf = ""; el.onEndTag(() => { s.h1.push((h1Buf || "").trim()); h1Buf = null; }); },
      text: (t) => { if (h1Buf !== null) h1Buf += t.text; },
    })
    .on("h2", { element: () => { s.h2Count++; } })
    .on("img", {
      element: (el) => {
        s.images++;
        const alt = el.getAttribute("alt");
        if (alt === null || alt.trim() === "") s.imagesMissingAlt++;
      },
    })
    .on("a[href]", {
      element: (el) => {
        const href = el.getAttribute("href") || "";
        if (/^(#|mailto:|tel:|javascript:)/i.test(href)) return;
        try {
          const u = new URL(href, finalUrl);
          if (u.hostname === finalUrl.hostname) s.internalLinks++;
          else s.externalLinks++;
        } catch { /* ignore malformed */ }
      },
    })
    .on('script[type="application/ld+json"]', {
      // HTMLRewriter keeps one onEndTag per element, so this handler also owns skipDepth for JSON-LD
      element: (el) => {
        ldBuf = "";
        skipDepth++;
        el.onEndTag(() => { ldBlocks.push(ldBuf || ""); ldBuf = null; skipDepth--; });
      },
      text: (t) => { if (ldBuf !== null) ldBuf += t.text; },
    })
    .on('script:not([type="application/ld+json"]), style, noscript, svg', {
      element: (el) => { skipDepth++; el.onEndTag(() => { skipDepth--; }); },
    })
    .on("body", {
      text: (t) => { if (skipDepth === 0 && bodyText.length < 400_000) bodyText += t.text + " "; },
    });

  const html = await rewriter.transform(res).arrayBuffer();
  s.bytes = html.byteLength;
  s.title = s.title.trim();
  s.wordCount = bodyText.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
  s.schemaTypes = extractSchemaTypes(ldBlocks);

  const checks = scoreChecks(s);
  const weights = { pass: 1, warn: 0.5, fail: 0 };
  const score = Math.round((checks.reduce((n, c) => n + weights[c.status], 0) / checks.length) * 100);

  return { signals: s, checks, score, auditedAt: new Date().toISOString() };
}

function extractSchemaTypes(blocks: string[]): string[] {
  const types = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const t = obj["@type"];
      if (typeof t === "string") types.add(t);
      if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.add(x));
      Object.values(obj).forEach(walk);
    }
  };
  for (const b of blocks) {
    try { walk(JSON.parse(b)); } catch { /* invalid JSON-LD is itself a finding, but skip here */ }
  }
  return [...types];
}

function scoreChecks(s: PageSignals): Check[] {
  const c: Check[] = [];
  const add = (id: string, label: string, status: Check["status"], detail: string) => c.push({ id, label, status, detail });

  add("status", "HTTP status", s.status === 200 ? "pass" : s.status < 400 ? "warn" : "fail", `Returned ${s.status}`);

  const tl = s.title.length;
  add("title", "Title tag",
    tl === 0 ? "fail" : tl >= 30 && tl <= 60 ? "pass" : "warn",
    tl === 0 ? "No <title> found" : `${tl} characters (target 30–60)`);

  const dl = s.metaDescription.length;
  add("meta", "Meta description",
    dl === 0 ? "fail" : dl >= 70 && dl <= 160 ? "pass" : "warn",
    dl === 0 ? "Missing" : `${dl} characters (target 70–160)`);

  add("h1", "Single H1",
    s.h1.length === 1 ? "pass" : s.h1.length === 0 ? "fail" : "warn",
    s.h1.length === 0 ? "No H1 found" : `${s.h1.length} H1 tag(s)`);

  add("canonical", "Canonical URL", s.canonical ? "pass" : "warn", s.canonical || "No canonical link");

  const noindex = /noindex/i.test(s.robots);
  add("indexable", "Indexable", noindex ? "fail" : "pass", noindex ? `robots: ${s.robots}` : "No noindex directive");

  add("viewport", "Mobile viewport", s.viewport ? "pass" : "fail", s.viewport ? "Viewport meta present" : "Missing viewport meta");

  add("lang", "HTML lang", s.lang ? "pass" : "warn", s.lang || "No lang attribute");

  add("alt", "Image alt text",
    s.images === 0 || s.imagesMissingAlt === 0 ? "pass" : s.imagesMissingAlt / s.images > 0.25 ? "fail" : "warn",
    s.images === 0 ? "No images" : `${s.imagesMissingAlt} of ${s.images} missing alt`);

  add("schema", "Structured data", s.schemaTypes.length ? "pass" : "warn",
    s.schemaTypes.length ? s.schemaTypes.join(", ") : "No JSON-LD found");

  add("og", "Open Graph", s.ogTitle && s.ogImage ? "pass" : "warn",
    s.ogTitle && s.ogImage ? "og:title and og:image set" : "Missing og:title or og:image");

  add("content", "Content depth", s.wordCount >= 300 ? "pass" : s.wordCount >= 150 ? "warn" : "fail", `${s.wordCount} words`);

  add("links", "Internal linking", s.internalLinks >= 5 ? "pass" : "warn", `${s.internalLinks} internal, ${s.externalLinks} external`);

  add("ttfb", "Server response", s.ttfbMs < 800 ? "pass" : s.ttfbMs < 1800 ? "warn" : "fail", `${s.ttfbMs} ms from edge`);

  return c;
}
