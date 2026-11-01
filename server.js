// 小红书预览 + 取页服务 · 容器内监听 0.0.0.0:8790
// 请求头 x-xhs-token 或 ?token= 与 XHS_TOKEN 一致才放行；/health 不校验
const http = require("http");

const PORT = 8790;
const TOKEN = process.env.XHS_TOKEN || "";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const XHS_REFERER = "https://www.xiaohongshu.com/";
const MAX_IMAGES = 12;
const IMAGE_TIMEOUT = 12000;
const FETCH_LIMIT = 60000;

const BLOCKED_HOST = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/i
];

function sendJSON(res, code, obj) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-xhs-token",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

function authorized(req, urlObj) {
  if (!TOKEN) return true;
  const h = req.headers["x-xhs-token"];
  const q = urlObj.searchParams.get("token");
  return h === TOKEN || q === TOKEN;
}

function stripHTML(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractState(html) {
  const key = "window.__INITIAL_STATE__=";
  const start = html.indexOf(key);
  if (start < 0) throw new Error("页面里没有 __INITIAL_STATE__，可能是风控页或结构变了");
  let end = html.indexOf("</script>", start);
  if (end < 0) end = html.length;
  let raw = html.slice(start + key.length, end).trim();
  raw = raw
    .replace(/:\s*undefined/g, ":null")
    .replace(/\[\s*undefined/g, "[null")
    .replace(/,\s*undefined/g, ",null")
    .replace(/;\s*$/, "");
  return JSON.parse(raw);
}

function fixURL(u) {
  let s = String(u || "").replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
  if (s.startsWith("//")) s = "https:" + s;
  if (s.startsWith("http://")) s = "https://" + s.slice(7);
  return s;
}

function pickNote(state) {
  const d = state.noteData || {};
  const note =
    (d.data && d.data.noteData) ||
    d.normalNotePreloadData ||
    d.noteData ||
    d.note ||
    d;
  const user = (d.data && d.data.user) || state.user || note.user || {};
  const interact = note.interactInfo || note.interact_info || {};

  const images = []
    .concat(note.imageList || note.image_list || [])
    .map((it) => fixURL(it && (it.urlDefault || it.url || it.urlPre || (it.infoList && it.infoList[0] && it.infoList[0].url))))
    .filter(Boolean);

  const comments = []
    .concat(state.commentList || note.comments || [])
    .slice(0, 10)
    .map((c) => ({
      user: (c.userInfo && c.userInfo.nickname) || c.nickname || "",
      content: c.content || "",
      ipLocation: c.ipLocation || ""
    }))
    .filter((c) => c.content);

  return {
    title: note.title || "",
    author: user.nickname || user.nickName || "",
    desc: note.desc || note.description || "",
    images,
    imageCount: images.length,
    likedCount: String(interact.likedCount || interact.liked_count || "0"),
    collectedCount: String(interact.collectedCount || interact.collected_count || "0"),
    commentCount: String(interact.commentCount || interact.comment_count || "0"),
    comments
  };
}

async function handleCard(req, res) {
  const { url } = await readBody(req);
  if (!url || typeof url !== "string") return sendJSON(res, 400, { ok: false, error: "缺少 url" });

  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9", referer: XHS_REFERER },
      redirect: "follow",
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return sendJSON(res, 502, { ok: false, error: "抓取失败 HTTP " + r.status });

    const html = await r.text();
    const note = pickNote(extractState(html));
    if (!note.title && !note.desc && !note.images.length)
      return sendJSON(res, 422, { ok: false, error: "解析出来是空的，页面结构可能变了" });

    sendJSON(res, 200, { ok: true, note: Object.assign({}, note, { url: r.url || url }) });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

async function oneImage(u) {
  const r = await fetch(u, {
    headers: {
      "user-agent": UA,
      referer: XHS_REFERER,
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
    },
    signal: AbortSignal.timeout(IMAGE_TIMEOUT)
  });
  if (!r.ok) throw new Error("image " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error("image too large");
  return {
    url: u,
    mime: (r.headers.get("content-type") || "image/jpeg").split(";")[0],
    base64: buf.toString("base64")
  };
}

async function handleImages(req, res) {
  const { urls } = await readBody(req);
  if (!Array.isArray(urls) || !urls.length) return sendJSON(res, 400, { ok: false, error: "缺少 urls" });

  const list = urls.slice(0, MAX_IMAGES).map(fixURL);
  const settled = await Promise.all(
    list.map((u) => oneImage(u).catch((e) => ({ url: u, error: String((e && e.message) || e) })))
  );
  sendJSON(res, 200, {
    ok: true,
    images: settled.filter((x) => x.base64),
    failed: settled.filter((x) => x.error)
  });
}

// 取页：把任意公开网页变成可读文本，给 AI 当眼睛用
async function handleFetch(req, res, urlObj) {
  let target = urlObj.searchParams.get("url");
  let raw = urlObj.searchParams.get("raw") === "1";
  if (!target) {
    const body = await readBody(req);
    target = body.url;
    if (body.raw) raw = true;
  }
  if (!target || typeof target !== "string") return sendJSON(res, 400, { ok: false, error: "缺少 url" });

  let u;
  try {
    u = new URL(target);
  } catch {
    return sendJSON(res, 400, { ok: false, error: "url 不合法" });
  }
  if (!/^https?:$/.test(u.protocol)) return sendJSON(res, 400, { ok: false, error: "只支持 http/https" });
  if (BLOCKED_HOST.some((re) => re.test(u.hostname))) return sendJSON(res, 403, { ok: false, error: "不抓内网地址" });

  try {
    const r = await fetch(u.href, {
      headers: {
        "user-agent": UA,
        "accept-language": "zh-CN,zh;q=0.9",
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000)
    });
    const ct = (r.headers.get("content-type") || "").split(";")[0];
    const body = await r.text();
    const text = ct.includes("html") && !raw ? stripHTML(body) : body;
    sendJSON(res, 200, {
      ok: r.ok,
      status: r.status,
      url: r.url,
      contentType: ct,
      length: text.length,
      text: text.slice(0, FETCH_LIMIT)
    });
  } catch (e) {
    sendJSON(res, 502, { ok: false, error: String((e && e.message) || e) });
  }
}

http
  .createServer(async (req, res) => {
    const urlObj = new URL(req.url || "/", "http://127.0.0.1");
    const path = urlObj.pathname;
    if (req.method === "OPTIONS") return sendJSON(res, 204, {});
    if (path === "/health") return sendJSON(res, 200, { ok: true, uptime: process.uptime() });
    if (!authorized(req, urlObj)) return sendJSON(res, 401, { ok: false, error: "unauthorized" });
    if (req.method === "POST" && path === "/api/xhs-card") return handleCard(req, res);
    if (req.method === "POST" && path === "/api/xhs-images") return handleImages(req, res);
    if ((req.method === "POST" || req.method === "GET") && path === "/api/fetch") return handleFetch(req, res, urlObj);
    sendJSON(res, 404, { ok: false, error: "not found" });
  })
  .listen(PORT, "0.0.0.0", () => console.log("eye on 0.0.0.0:" + PORT + (TOKEN ? " (token required)" : " (no token)")));
