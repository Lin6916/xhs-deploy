// 小红书链接预览卡服务 · 容器内监听 0.0.0.0:8790（宿主机仅 127.0.0.1 映射）
const http = require("http");

const PORT = 8790;
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const XHS_REFERER = "https://www.xiaohongshu.com/";
const MAX_IMAGES = 12;
const IMAGE_TIMEOUT = 12000;

function sendJSON(res, code, obj) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
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

http
  .createServer(async (req, res) => {
    const path = (req.url || "").split("?")[0];
    if (req.method === "OPTIONS") return sendJSON(res, 204, {});
    if (req.method === "POST" && path === "/api/xhs-card") return handleCard(req, res);
    if (req.method === "POST" && path === "/api/xhs-images") return handleImages(req, res);
    if (path === "/health") return sendJSON(res, 200, { ok: true, uptime: process.uptime() });
    sendJSON(res, 404, { ok: false, error: "not found" });
  })
  .listen(PORT, "0.0.0.0", () => console.log("xhs-card on 0.0.0.0:" + PORT));
