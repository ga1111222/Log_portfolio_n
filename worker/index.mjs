const encoder = new TextEncoder();
const apiHeaders = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"};
const fields = ["name", "major", "job", "email", "headline", "intro", "career", "cert", "activity", "motive", "skill", "strength", "goal", "note"];
const cookie = "logon_session";
const pageSize = 25;
const tracked = ["major","job","headline","intro","career","cert","activity","motive","skill","goal"];
const lifetime = 7 * 24 * 60 * 60;
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
const random = length => hex(crypto.getRandomValues(new Uint8Array(length)));
const sha256 = async value => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({
    name: "PBKDF2", hash: "SHA-256", iterations: 100000, salt: encoder.encode(salt)
  }, key, 256));
}

function equal(left, right) {
  let mismatch = left.length ^ right.length;
  for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

function reply(data, status = 200, headers = {}) {
  return Response.json(data, {status, headers: {...apiHeaders, ...headers}});
}

function error(message, status) {
  return reply({error: message}, status);
}

function normalized(value) {
  return typeof value === "string" ? value.normalize("NFC").trim() : "";
}

function normalizedName(value) {
  return normalized(value).replace(/\s+/g, " ");
}

async function throttle(db, request, action, now) {
  const windowSeconds = 900;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const bucket = await sha256(action + ":" + ip + ":" + Math.floor(now / windowSeconds));
  const [, result] = await db.batch([
    db.prepare("DELETE FROM attempts WHERE expires <= ?").bind(now),
    db.prepare("INSERT INTO attempts VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count").bind(bucket, now + windowSeconds)
  ]);
  return result.results[0].count <= (action === "register" ? 8 : 30);
}

async function createSession(db, member, now) {
  const token = random(32);
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires <= ?").bind(now),
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").bind(await sha256(token), member.id, now + lifetime)
  ]);
  return reply({name: member.name}, 200, {
    "Set-Cookie": cookie + "=" + token + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=" + lifetime
  });
}

function adminIds(env) {
  return new Set(normalized(env.LOGON_ADMIN_MEMBER_IDS).split(",").map(id => id.trim()).filter(Boolean));
}

async function authenticate(db, request, action, body, now) {
  if (!await throttle(db, request, action, now)) return error("요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", 429);
  const name = normalizedName(body.name);
  const password = typeof body.password === "string" ? body.password : "";
  if (name.length < 2 || name.length > 50 || password.length < 8 || password.length > 128) {
    return error(action === "register" ? "이름은 2~50자, 비밀번호는 8~128자로 입력해 주세요." : "이름 또는 비밀번호를 확인해 주세요.", 400);
  }
  if (action === "login") {
    const member = await db.prepare("SELECT id, name, active, salt, password_hash FROM members WHERE name = ?").bind(name).first();
    const hash = await passwordHash(password, member?.salt || "unused-account-placeholder");
    if (!member || !member.active || !equal(hash, member.password_hash)) return error("이름 또는 비밀번호를 확인해 주세요.", 401);
    return createSession(db, member, now);
  }
  const phone = normalized(body.phone).replace(/[\s()-]/g, "");
  const student = normalized(body.student).toUpperCase();
  if (!/^\+?\d{8,15}$/.test(phone) || !/^[A-Z0-9-]{2,30}$/.test(student)) {
    return error("전화번호와 학번을 확인해 주세요.", 400);
  }
  const code = normalized(body.invite);
  if (!/^[a-f0-9]{36}$/.test(code)) {
    return error("가입할 이름과 초대 코드를 확인해 주세요.", 403);
  }
  const member = {id: crypto.randomUUID(), name};
  const salt = random(16);
  const hash = await passwordHash(password, salt);
  const inviteHash = await sha256(code);
  const result = await db.prepare(`INSERT INTO members (id, name, student_number, phone, password_hash, salt, invite_hash)
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM member_invites WHERE token_hash = ? AND name = ? AND expires > ?)
    ON CONFLICT DO NOTHING`).bind(member.id, name, student, phone, hash, salt, inviteHash, inviteHash, name, now).run();
  if (!result.meta.changes) return error("초대 코드가 유효하지 않거나 이미 등록된 이름 또는 학번입니다.", 409);
  return createSession(db, member, now);
}

const sectors = {"물류":/물류|SCM|공급망/i,"무역":/무역|수출입|통상/,"유통":/유통|리테일/,"해운":/해운|선박/,"항만":/항만|항구/};
const recruitment = /공모전|아이디어 공모|서포터즈|대학생 기자단|해커톤|챌린지|교육생 모집|참가자 모집|인턴십/;
const freshness = 180000;
const day = 86400000;
const activityCache = new Map();
const campusTopics = {...sectors,"물류":/물류|SCM|공급망|포워딩|물류관리/i,"무역":/무역|수출입|통상|관세|FTA/i,
  "유통":/유통|리테일|이커머스|전자상거래/,"해운":/해운|선박|선사|해사/,"항만":/항만|항구|항만공사/};

function officialLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function dateOnly(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function dateTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

async function remoteFeed(url, format, timeout = 6500) {
  const response = await fetch(url, {signal:AbortSignal.timeout(timeout)});
  if (!response.ok) throw new Error("feed_unavailable");
  return format === "json" ? response.json() : response.text();
}

async function moyeobom() {
  const data = await remoteFeed("https://moyeobom-campus.gayoungk1.chatgpt.site/api/activities?school=ks", "json");
  if (!Array.isArray(data.items) || !Array.isArray(data.sources)) throw new Error("feed_invalid");
  return data;
}

function commonItem(item) {
  const url = officialLink(item.url);
  const title = normalized(item.title).slice(0, 250);
  if (!url || !title) return null;
  return {url,title,date:dateOnly(item.date),deadline:dateOnly(item.deadline_end),start:dateOnly(item.deadline_start),
    category:normalized(item.category).slice(0, 60),source:normalized(item.source).slice(0, 150)};
}

async function campusFeed() {
  const data = await moyeobom();
  const sources = data.sources.filter(source => source.scope !== "교외");
  const items = data.items.filter(item => item.scope === "교내" || item.scope === "교내외").map(item => {
    const entry = commonItem(item);
    return entry && {...entry,scope:item.scope};
  }).filter(Boolean);
  return {items,partial:!sources.length || sources.some(source => !["live","provided"].includes(source.state)),
    sources:sources.map(source => ({name:normalized(source.name),url:officialLink(source.url),
      checkedAt:dateTime(source.checked_at),state:source.state}))};
}

function campusNoticeKey(value) {
  const url = new URL(value);
  if (url.hostname !== "kscms.ks.ac.kr" || url.pathname !== "/kor/CMS/Board/Board.do") return null;
  const id = url.searchParams.get("board_seq");
  return /^\d+$/.test(id || "") ? id : null;
}

function campusItemDetails(item) {
  return {
    ...item,
    key:campusNoticeKey(item.url) || item.url,
    topics:Object.entries(campusTopics).filter(([, pattern]) => pattern.test(item.title)).map(([name]) => name)
  };
}

async function campusFavorites(db, memberId, method, body, now) {
  if (method === "GET") {
    const {results} = await db.prepare("SELECT data FROM campus_favorites WHERE member_id = ? ORDER BY saved_at DESC, notice_key")
      .bind(memberId).all();
    return reply({items:results.map(row => campusItemDetails(JSON.parse(row.data)))});
  }
  const input = body.item;
  if (typeof body.saved !== "boolean" || !input || typeof input !== "object") {
    return error("즐겨찾기 요청을 확인해 주세요.", 400);
  }
  const item = commonItem({...input,deadline_end:input.deadline});
  if (!item || item.url.length > 2000 || !["교내","교내외"].includes(input.scope)) {
    return error("교내활동 공고를 확인해 주세요.", 400);
  }
  item.scope = input.scope;
  const key = campusItemDetails(item).key;
  if (body.saved) {
    await db.prepare(`INSERT INTO campus_favorites (member_id, notice_key, data, saved_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (member_id, notice_key) DO UPDATE SET data = excluded.data`)
      .bind(memberId,key,JSON.stringify(item),now).run();
  } else {
    await db.prepare("DELETE FROM campus_favorites WHERE member_id = ? AND notice_key = ?").bind(memberId,key).run();
  }
  return reply({});
}

function rssText(xml, tag) {
  const value = xml.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i"))?.[1] || "";
  return value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, key) => ({amp:"&",lt:"<",gt:">",quot:'"',apos:"'","#39":"'"}[key])).trim();
}

async function industryNews() {
  const url = new URL("https://news.google.com/rss/search");
  url.search = new URLSearchParams({q:"(물류 OR 무역 OR 유통 OR 해운 OR 항만) (공모전 OR 서포터즈 OR 대학생 OR 해커톤) when:60d",hl:"ko",gl:"KR",ceid:"KR:ko"});
  const xml = await remoteFeed(url, "text");
  if (!/<rss[\s>]/i.test(xml)) throw new Error("feed_invalid");
  return Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/gi), ([, item]) => {
    const source = rssText(item, "source");
    const title = rssText(item, "title");
    const suffix = " - " + source;
    const published = dateTime(rssText(item, "pubDate"));
    if (!published || Date.now() - Date.parse(published) > 60 * day) return null;
    return commonItem({url:rssText(item, "link"),title:source && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title,
      date:published.slice(0,10),category:"모집 관련 보도",source});
  }).filter(Boolean);
}

async function externalFeed() {
  const results = await Promise.allSettled([
    moyeobom().then(data => data.items.filter(item => item.scope === "교외").map(commonItem).filter(Boolean)),
    industryNews()
  ]);
  if (results.every(result => result.status === "rejected")) throw new Error("feed_unavailable");
  const titles = new Set();
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0,10);
  const items = results.flatMap(result => result.status === "fulfilled" ? result.value : []).flatMap(item => {
    const topics = Object.entries(sectors).filter(([, pattern]) => pattern.test(item.title)).map(([name]) => name);
    if (!topics.length || !recruitment.test(item.title) || (item.deadline && item.deadline < today)) return [];
    if (/성료|시상식|수상작|최종 결과|모집 마감/.test(item.title)) return [];
    const key = item.title.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
    if (titles.has(key)) return [];
    titles.add(key);
    return [{...item,topics}];
  });
  items.sort((left, right) => (right.date || "").localeCompare(left.date || ""));
  return {items:items.slice(0,60),partial:results.some(result => result.status === "rejected")};
}

async function readActivityFeed(request, route, db) {
  const params = new URL(request.url).searchParams;
  const school = params.get("school");
  if (route === "campus" && school !== null && school !== "ks") return error("경성대학교 공고만 제공됩니다.", 400);
  const key = route;
  const current = Date.now();
  let snapshot = activityCache.get(key);
  if (!snapshot) {
    try {
      const stored = await db.prepare("SELECT checked_at, content FROM activity_snapshots WHERE route = ?").bind(key).first();
      if (stored) snapshot = {...JSON.parse(stored.content),checkedAt:new Date(stored.checked_at).toISOString()};
    } catch {
      // A temporary storage error does not prevent a fresh fetch.
    }
  }
  const checked = snapshot && Date.parse(snapshot.checkedAt);
  const present = (data, stale = false) => reply({
    ...data, stale, items:route === "campus" ? data.items.map(campusItemDetails) : data.items
  });
  if (snapshot && current - checked < freshness) return present(snapshot);
  try {
    const data = route === "campus" ? await campusFeed() : await externalFeed();
    if (route === "external" && data.partial && !data.items.length) return present(snapshot?.items.length ? snapshot : bundledExternalFeed, true);
    const timestamp = Date.now();
    const latest = {...data,checkedAt:new Date(timestamp).toISOString()};
    activityCache.set(key, latest);
    try {
      await db.prepare(`INSERT INTO activity_snapshots (route, checked_at, content) VALUES (?, ?, ?)
        ON CONFLICT(route) DO UPDATE SET checked_at = excluded.checked_at, content = excluded.content
        WHERE excluded.checked_at >= activity_snapshots.checked_at`).bind(key,timestamp,JSON.stringify(data)).run();
    } catch {
      // The latest results can still be returned to this request.
    }
    return present(latest);
  } catch {
    if (snapshot && (route === "external" || current - checked <= day)) return present(snapshot, true);
    if (route === "external") return present(bundledExternalFeed, true);
    return error("학교 공지를 다시 확인하지 못했습니다. 경성대학교 교내소식에서 원문을 확인해 주세요.", 503);
  }
}

async function handleApi(request, env, path) {
  const method = request.method;
  if (method !== "GET" && request.headers.get("Origin") !== new URL(request.url).origin) {
    return error("요청 출처를 확인할 수 없습니다.", 403);
  }
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  let body;
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const raw = await request.text();
    if (raw.length > 100000) return error("입력 내용이 너무 깁니다.", 413);
    try { body = JSON.parse(raw); } catch { return error("요청 내용을 확인해 주세요.", 400); }
    if (!body || typeof body !== "object") return error("요청 내용을 확인해 주세요.", 400);
  }
  if (method === "POST" && (path === "/api/login" || path === "/api/register")) {
    return authenticate(db, request, path.slice(5), body, now);
  }
  const token = request.headers.get("Cookie")?.match(/(?:^|;\s*)logon_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return error("로그인해 주세요.", 401);
  const tokenHash = await sha256(token);
  if (method === "POST" && path === "/api/logout") {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return reply({}, 200, {"Set-Cookie": cookie + "=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"});
  }
  const member = await db.prepare("SELECT members.id, members.name, members.profile, members.version FROM sessions JOIN members ON members.id = sessions.member_id WHERE token_hash = ? AND expires > ? AND members.active = 1")
    .bind(tokenHash, now).first();
  if (!member) return error("다시 로그인해 주세요.", 401);
  if (method === "GET" && path === "/api/activities/external") return readActivityFeed(request, "external", db);
  if ((method === "GET" || method === "POST") && path === "/api/activities/favorites") {
    return campusFavorites(db, member.id, method, body, now);
  }
  if (method === "GET" && path === "/api/activities/campus") return readActivityFeed(request, "campus", db);
  const administrators = adminIds(env);
  const admin = administrators.has(member.id);
  if (method === "GET" && path === "/api/profile") {
    return reply({
      name:member.name, profile:{...JSON.parse(member.profile),name:member.name}, version:member.version,
      admin, role:admin ? "admin" : "member"
    });
  }
  const targetId = path.match(/^\/api\/admin\/members\/([a-f0-9-]{36})$/)?.[1];
  if (path === "/api/admin/members" || targetId) {
    if (!admin) return error("관리자 권한이 필요합니다.", 403);
  }
  if (path === "/api/admin/members" && method === "GET") {
    const requested = Number(new URL(request.url).searchParams.get("page") || 0);
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > Math.floor(Number.MAX_SAFE_INTEGER / pageSize) - 1) {
      return error("페이지를 확인해 주세요.", 400);
    }
    const [entries, totals] = await db.batch([
      db.prepare("SELECT id, name, active, profile FROM members ORDER BY name, id LIMIT ? OFFSET ?").bind(pageSize, requested * pageSize),
      db.prepare("SELECT count(*) AS count FROM members")
    ]);
    return reply({
      members:entries.results.map(({id, name, active, profile}) => {
        const content = JSON.parse(profile);
        return {id,name,active:Boolean(active),role:administrators.has(id) ? "admin" : "member",
          progress:tracked.filter(key => typeof content[key] === "string" && content[key].trim()).length * 10};
      }),
      pages:Math.max(1,Math.ceil(totals.results[0].count / pageSize))
    });
  }
  if (path === "/api/admin/members" && method === "POST") {
    const name = normalizedName(body.name);
    if (name.length < 2 || name.length > 50) return error("이름은 2~50자로 입력해 주세요.", 400);
    const code = random(18);
    const expiry = now + lifetime;
    const result = await db.prepare(`INSERT INTO member_invites (token_hash, name, expires)
      SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM members WHERE name = ?)`)
      .bind(await sha256(code), name, expiry, name).run();
    return result.meta.changes ? reply({code,expires:expiry}, 201) : error("이미 등록된 이름입니다.", 409);
  }
  let target = member;
  if (targetId) {
    target = await db.prepare("SELECT id, name, profile, version FROM members WHERE id = ?").bind(targetId).first();
    if (!target) return error("회원을 찾을 수 없습니다.", 404);
    if (method === "PATCH") {
      if (typeof body.active !== "boolean") return error("회원 상태를 확인해 주세요.", 400);
      if (administrators.has(target.id)) {
        return error("관리자 계정은 비활성화할 수 없습니다.", 403);
      }
      await db.batch([
        db.prepare("UPDATE members SET active = ? WHERE id = ?").bind(Number(body.active), target.id),
        db.prepare("DELETE FROM sessions WHERE member_id = ? AND ? = 0").bind(target.id, Number(body.active))
      ]);
      return reply({});
    }
    if (method === "GET") return reply({name:target.name,profile:{...JSON.parse(target.profile),name:target.name},version:target.version});
  }
  if (method === "PUT" && (path === "/api/profile" || targetId)) {
    if (!Number.isSafeInteger(body.version)) return error("저장 버전을 확인해 주세요.", 400);
    const profile = Object.fromEntries(fields.map(key => [key, typeof body[key] === "string" ? body[key].slice(0, 5000) : ""]));
    profile.name = target.name;
    const saved = await db.prepare(`UPDATE members SET profile = ?, version = version + 1 WHERE id = ? AND version = ?
      AND EXISTS (SELECT 1 FROM members AS editor WHERE editor.id = ? AND editor.active = 1)
      RETURNING version`).bind(JSON.stringify(profile), target.id, body.version, member.id).first();
    return saved ? reply(saved) : error("다른 기기에서 저장됐거나 접근 권한이 해제됐습니다. 작성 내용을 백업한 뒤 새로고침해 주세요.", 409);
  }
  return error("페이지를 찾을 수 없습니다.", 404);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/" || path === "/app.js") {
      const script = path === "/app.js";
      return new Response(script ? appScript : page, {headers: {
        "Content-Type": script ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
        ...apiHeaders
      }});
    }
    if (!path.startsWith("/api/")) return error("페이지를 찾을 수 없습니다.", 404);
    try {
      return await handleApi(request, env, path);
    } catch (cause) {
      console.error("LOG:ON API failure", cause?.name);
      return error("요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.", 500);
    }
  }
};
