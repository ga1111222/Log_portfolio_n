const encoder = new TextEncoder();
const apiHeaders = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"};
const fields = ["name", "major", "job", "email", "headline", "intro", "career", "cert", "activity", "motive", "skill", "strength", "goal", "note"];
const cookie = "logon_session";
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

async function validAdminInvite(value, env) {
  const code = normalized(value);
  return /^[a-f0-9]{36}$/.test(code) && Boolean(env.LOGON_PARK_INVITE_HASH) &&
    equal(await sha256(code), env.LOGON_PARK_INVITE_HASH);
}

async function authenticate(db, request, action, body, now, env) {
  if (!await throttle(db, request, action, now)) return error("요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", 429);
  const name = normalized(body.name).replace(/\s+/g, " ");
  const password = typeof body.password === "string" ? body.password : "";
  if (name.length < 2 || name.length > 50 || password.length < 8 || password.length > 128) {
    return error(action === "register" ? "이름은 2~50자, 비밀번호는 8~128자로 입력해 주세요." : "이름 또는 비밀번호를 확인해 주세요.", 400);
  }
  if (action === "login") {
    const member = await db.prepare("SELECT id, name, salt, password_hash FROM members WHERE name = ?").bind(name).first();
    const hash = await passwordHash(password, member?.salt || "unused-account-placeholder");
    if (!member || !equal(hash, member.password_hash)) return error("이름 또는 비밀번호를 확인해 주세요.", 401);
    return createSession(db, member, now);
  }
  const phone = normalized(body.phone).replace(/[\s()-]/g, "");
  const student = normalized(body.student).toUpperCase();
  if (!/^\+?\d{8,15}$/.test(phone) || !/^[A-Z0-9-]{2,30}$/.test(student)) {
    return error("전화번호와 학번을 확인해 주세요.", 400);
  }
  const invited = name === env.LOGON_INVITED_ADMIN_NAME;
  if (invited && !await validAdminInvite(body.invite, env)) {
    return error("관리자 초대 코드를 확인해 주세요.", 403);
  }
  const member = {id: crypto.randomUUID(), name};
  const salt = random(16);
  const result = await db.prepare("INSERT INTO members (id, name, student_number, phone, password_hash, salt, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(member.id, name, student, phone, await passwordHash(password, salt), salt, Number(invited)).run();
  if (!result.meta.changes) return error("이미 등록된 이름 또는 학번입니다.", 409);
  return createSession(db, member, now);
}

async function handleApi(request, env, path) {
  const method = request.method;
  if (method !== "GET" && request.headers.get("Origin") !== new URL(request.url).origin) {
    return error("요청 출처를 확인할 수 없습니다.", 403);
  }
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  let body;
  if (method === "POST" || method === "PUT") {
    const raw = await request.text();
    if (raw.length > 100000) return error("입력 내용이 너무 깁니다.", 413);
    try { body = JSON.parse(raw); } catch { return error("요청 내용을 확인해 주세요.", 400); }
    if (!body || typeof body !== "object") return error("요청 내용을 확인해 주세요.", 400);
  }
  if (method === "POST" && (path === "/api/login" || path === "/api/register")) {
    return authenticate(db, request, path.slice(5), body, now, env);
  }
  const token = request.headers.get("Cookie")?.match(/(?:^|;\s*)logon_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return error("로그인해 주세요.", 401);
  const tokenHash = await sha256(token);
  if (method === "POST" && path === "/api/logout") {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return reply({}, 200, {"Set-Cookie": cookie + "=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"});
  }
  const member = await db.prepare("SELECT members.id, members.name, members.profile, members.is_admin FROM sessions JOIN members ON members.id = sessions.member_id WHERE token_hash = ? AND expires > ?")
    .bind(tokenHash, now).first();
  if (!member) return error("다시 로그인해 주세요.", 401);
  const adminEligible = member.name === env.LOGON_ADMIN_NAME && Boolean(env.LOGON_ADMIN_EMAIL);
  const verifiedEmail = request.headers.get("oai-authenticated-user-email");
  const admin = Boolean(member.is_admin) || (adminEligible &&
    Boolean(request.headers.get("oai-authenticated-user-id")) &&
    verifiedEmail?.toLowerCase() === env.LOGON_ADMIN_EMAIL.toLowerCase());
  const inviteEligible = member.name === env.LOGON_INVITED_ADMIN_NAME && !admin;
  if (method === "POST" && path === "/api/admin/activate") {
    if (!inviteEligible || !await validAdminInvite(body.invite, env)) {
      return error("관리자 초대 코드를 확인해 주세요.", 403);
    }
    await db.prepare("UPDATE members SET is_admin = 1 WHERE id = ?").bind(member.id).run();
    return reply({admin: true});
  }
  if (method === "GET" && path === "/api/profile") {
    return reply({name: member.name, profile: {...JSON.parse(member.profile), name: member.name}, admin, adminEligible, inviteEligible});
  }
  if (path === "/api/admin/members" && method === "GET") {
    if (!admin) return error("관리자 권한이 필요합니다.", 403);
    const {results} = await db.prepare("SELECT id, name FROM members ORDER BY name").all();
    return reply({members: results});
  }
  let target = member;
  const targetId = path.match(/^\/api\/admin\/members\/([a-f0-9-]{36})$/)?.[1];
  if (targetId && (method === "GET" || method === "PUT")) {
    if (!admin) return error("관리자 권한이 필요합니다.", 403);
    target = await db.prepare("SELECT id, name, profile FROM members WHERE id = ?").bind(targetId).first();
    if (!target) return error("회원을 찾을 수 없습니다.", 404);
    if (method === "GET") return reply({name: target.name, profile: {...JSON.parse(target.profile), name: target.name}});
  }
  if (method === "PUT" && (path === "/api/profile" || targetId)) {
    const profile = Object.fromEntries(fields.map(key => [key, typeof body[key] === "string" ? body[key].slice(0, 5000) : ""]));
    profile.name = target.name;
    await db.prepare("UPDATE members SET profile = ? WHERE id = ?").bind(JSON.stringify(profile), target.id).run();
    return reply({profile});
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
