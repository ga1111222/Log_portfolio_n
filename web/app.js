const byId = id => document.getElementById(id);
const sections = [
  ["기본 프로필", [
    ["name", "이름", "이름"], ["major", "학교 / 전공", "학교 및 전공"],
    ["job", "희망 직무", "예: SCM, 항만물류, 국제물류"], ["email", "이메일", "example@email.com", "email"],
    ["headline", "나를 소개하는 한 줄", "나의 강점과 관심 분야를 한 문장으로", "wide"],
    ["intro", "자기소개", "관심 분야, 강점, 성장 방향 등을 작성하세요.", "textarea"]
  ]],
  ["경력 및 실무 경험", [["career", "회사 / 기관 / 활동명 · 기간 · 담당 업무 · 성과", "기업명 | 2026.01~2026.02\n담당 업무와 구체적인 성과를 작성하세요.", "textarea"]]],
  ["자격증 및 어학", [["cert", "자격증 · 어학 성적 · 취득일", "물류관리사 | 2026.07\nTOEIC | 850점 | 2026.12", "textarea"]]],
  ["대외활동 · 공모전 · 프로젝트", [["activity", "활동명 · 역할 · 주요 결과", "동아리, 공모전, 대외활동, 프로젝트 및 수상 내역", "textarea"]]],
  ["자기소개서", [
    ["motive", "지원 동기 및 직무 관심", "해당 산업과 직무에 관심을 갖게 된 계기", "textarea"],
    ["skill", "직무 역량 및 경험", "직무와 연결되는 경험, 문제 해결, 성과", "textarea"],
    ["strength", "성격의 장단점 및 협업 경험", "나의 강점과 보완점, 팀 활동 사례", "textarea"],
    ["goal", "입사 후 포부", "앞으로의 성장 목표와 기여 방향", "textarea"]
  ]],
  ["활동 기록 및 메모", [["note", "학기별 목표 / 활동 회고 / 다음 계획", "이번 학기 목표, 참여한 로그온 활동, 배운 점, 다음 계획", "textarea"]]]
];

const profileForm = byId("profileForm");
const loginForm = byId("loginForm");
const fields = new Map();
const registerForm = byId("registerForm");
let activeMember = null;
let editingMemberId = "";
let savedProfile = "";
let profileVersion = 0;
let page = 0;
let adminView = 0;
let portfolioRequest = 0;
let saving = false;
const roleNames = {admin:"관리자", member:"일반 부원"};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

for (const [title, definitions] of sections) {
  const section = element("section", undefined, "section");
  const grid = element("div", undefined, "grid");
  section.append(element("h3", title), grid);
  for (const [key, label, placeholder, type] of definitions) {
    const multiline = type === "textarea";
    const input = element(multiline ? "textarea" : "input");
    if (type === "email") input.type = type;
    input.name = key;
    input.maxLength = 5000;
    if (key === "name") input.readOnly = true;
    input.placeholder = placeholder;
    const field = element("label", label, multiline || type === "wide" ? "field full" : "field");
    field.append(input);
    grid.append(field);
    fields.set(key, input);
  }
  profileForm.append(section);
}

const trackedFields = ["major", "job", "headline", "intro", "career", "cert", "activity", "motive", "skill", "goal"];
function hasValue(profile, key) {
  return typeof profile[key] === "string" && profile[key].trim().length > 0;
}
function completion(profile) {
  return trackedFields.filter(key => hasValue(profile, key)).length * 10;
}
function readForm() {
  return Object.fromEntries([...fields].map(([key, input]) => [key, input.value]));
}
function updateStats() {
  const profile = readForm();
  byId("statCareer").textContent = ["career", "activity"].filter(key => hasValue(profile, key)).length;
  byId("statCert").textContent = Number(hasValue(profile, "cert"));
  byId("statProgress").textContent = completion(profile) + "%";
}
function status(message) {
  const node = byId("saveStatus");
  node.hidden = !message;
  node.textContent = message;
}
async function api(path, method = "GET", data) {
  const response = await fetch("/api/" + path, {
    method,
    headers: data === undefined ? undefined : {"Content-Type": "application/json"},
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  const payload = await response.json();
  if (!response.ok) {
    const failure = new Error(payload.error);
    failure.status = response.status;
    throw failure;
  }
  return payload;
}

function showLoginError(message) {
  byId("loginError").textContent = message;
  byId("loginError").hidden = !message;
}

function loadPortfolio({name, profile, version}) {
  profileVersion = version;
  activeMember = name;
  for (const [key, input] of fields) input.value = profile[key] || "";
  savedProfile = JSON.stringify(readForm());
  byId("profileTitle").textContent = name + "의 포트폴리오";
  byId("profileSub").textContent = editingMemberId ? "관리자 모드 · 회원 포트폴리오" : "나의 경력과 활동을 정리하세요.";
  status("");
  updateStats();
}

const appViews = {
  hub: [byId("hubView"), byId("hubHeading")],
  portfolio: [byId("portfolioView"), byId("portfolioHeading")],
  resources: [byId("resourcesView"), byId("resourcesHeading")],
  campus: [byId("campusView"), byId("campusHeading")]
};

function openView(view) {
  if (!activeMember) return;
  for (const [name, [section]] of Object.entries(appViews)) section.hidden = name !== view;
  window.scrollTo(0, 0);
  appViews[view][1].focus({preventScroll:true});
  if (view === "portfolio" && !byId("adminControls").hidden) loadMembers();
  if (view === "resources") loadFeed("external");
  if (view === "campus") loadFeed("campus");
}

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => openView(button.dataset.view));
}

const feedState = {external:{},campus:{}};
const feedDate = new Intl.DateTimeFormat("ko-KR",{timeZone:"Asia/Seoul",dateStyle:"medium",timeStyle:"short"});

function feedLink(title, href) {
  const link = element("a", title);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function renderFeed(kind) {
  const {data} = feedState[kind];
  if (!data) return;
  const external = kind === "external";
  const query = byId(kind + "Query").value.trim().toLowerCase();
  const category = byId(external ? "externalTopic" : "campusCategory").value;
  const items = data.items.filter(item => item.title.toLowerCase().includes(query) &&
    (!category || (external ? item.topics.includes(category) : item.category === category)));
  byId(kind + "Items").replaceChildren(...items.map(item => {
    const row = element("li", undefined, "feed-item");
    const meta = [external ? item.topics.join(" · ") : item.scope, item.category, item.source, item.date && "게시 " + item.date, item.deadline && "마감 " + item.deadline];
    row.append(feedLink(item.title, item.url), element("p",meta.filter(Boolean).join(" / "),"sub"));
    return row;
  }));
  const details = data.stale ? "이전 수집 자료" : data.partial ? "일부 출처의 최신 자료를 확인하지 못했습니다." : "";
  byId(kind + "Status").textContent = [
    "확인 " + feedDate.format(new Date(data.checkedAt)), details,
    items.length ? items.length + "건" : kind === "campus" && byId("campusOpenOnly").checked ? "모집 중으로 확인된 공고가 없습니다." : "조건에 맞는 공고가 없습니다."
  ].filter(Boolean).join(" · ");
}

function updateCampusSources(data) {
  const select = byId("campusCategory");
  const last = select.value;
  const categories = [...new Set(data.items.map(item => item.category).filter(Boolean))].sort();
  select.replaceChildren(new Option("전체 분류",""),...categories.map(name => new Option(name,name)));
  if (categories.includes(last)) select.value = last;
  byId("campusSources").replaceChildren(...data.sources.map(source => {
    const row = element("li");
    row.append(source.url ? feedLink(source.name,source.url) : element("span",source.name));
    const status = source.state === "live" ? "원본 확인" : source.state === "provided" ? "제공 자료" : "최신 확인 안 됨";
    row.append(" · " + status + (source.checkedAt ? " · " + feedDate.format(new Date(source.checkedAt)) : ""));
    return row;
  }));
}

async function loadFeed(kind) {
  const state = feedState[kind];
  const campus = kind === "campus";
  const openOnly = campus && byId("campusOpenOnly").checked;
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  if (state.openOnly !== openOnly) {
    state.openOnly = openOnly;
    state.data = null;
    byId(kind + "Items").replaceChildren();
  }
  byId(kind + "Status").textContent = openOnly ? "원문에서 모집 기간을 확인 중입니다." : "공고를 확인 중입니다.";
  try {
    const response = await fetch("/api/activities/" + kind + (openOnly ? "?open=1" : ""), {signal:controller.signal});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (controller.signal.aborted) return;
    state.data = data;
    if (campus) updateCampusSources(data);
    renderFeed(kind);
  } catch (error) {
    if (controller.signal.aborted) return;
    byId(kind + "Status").textContent = state.data ? "다시 확인하지 못했습니다. 마지막으로 불러온 공고를 표시합니다." :
      (campus ? "학교 공지를 다시 확인하지 못했습니다. 아래 경성대학교 교내소식에서 원문을 확인해 주세요." : "대외활동을 불러오지 못했습니다. 위의 대외활동 사이트에서 원문을 확인해 주세요.");
  }
}

byId("externalTopic").addEventListener("change", () => renderFeed("external"));
byId("externalQuery").addEventListener("input", () => renderFeed("external"));
byId("campusOpenOnly").addEventListener("change", () => loadFeed("campus"));
byId("campusCategory").addEventListener("change", () => renderFeed("campus"));
byId("campusQuery").addEventListener("input", () => renderFeed("campus"));
byId("refreshExternal").addEventListener("click", () => loadFeed("external"));
byId("refreshCampus").addEventListener("click", () => loadFeed("campus"));
setInterval(() => {
  if (!activeMember || document.hidden) return;
  if (!byId("resourcesView").hidden) loadFeed("external");
  if (!byId("campusView").hidden) loadFeed("campus");
}, 180000);

function showProfile(account) {
  editingMemberId = "";
  page = 0;
  byId("userLabel").textContent = account.name + " 로그인";
  byId("rolePill").textContent = roleNames[account.role];
  byId("adminControls").hidden = !account.admin;
  byId("loginView").hidden = true;
  byId("appView").hidden = false;
  byId("logoutBtn").hidden = false;
  loadPortfolio(account);
  openView("hub");
}

function adminStatus(message) {
  byId("adminStatus").textContent = message;
}

async function loadMembers(requestedPage = page) {
  const view = ++adminView;
  try {
    const {members, pages} = await api("admin/members?page=" + requestedPage);
    if (view !== adminView) return;
    if (requestedPage >= pages) return loadMembers(pages - 1);
    page = requestedPage;
    byId("pageNumber").textContent = (page + 1) + " / " + pages;
    byId("prevPage").disabled = page === 0;
    byId("nextPage").disabled = page + 1 >= pages;
    byId("memberRows").replaceChildren(...members.map(member => {
      const row = element("tr");
      const actions = element("td");
      const open = element("button", "열기", "light");
      open.addEventListener("click", () => openPortfolio(member.id));
      actions.append(open);
      if (member.role === "member") {
        const change = element("button", member.active ? "비활성화" : "복구", "light");
        change.addEventListener("click", async () => {
          change.disabled = true;
          try {
            await api("admin/members/" + member.id, "PATCH", {active:!member.active});
            adminStatus(member.name + (member.active ? " 계정을 비활성화했습니다." : " 계정을 복구했습니다."));
            await loadMembers();
          } catch (error) {
            adminStatus(error.message);
          } finally {
            change.disabled = false;
          }
        });
        actions.append(change);
      }
      row.append(element("td", member.name), element("td", roleNames[member.role]), element("td", member.active ? "활성" : "비활성"),
        element("td", member.progress + "%"), actions);
      return row;
    }));
  } catch (error) {
    if (view === adminView) adminStatus(error.message);
  }
}

async function openPortfolio(id) {
  if (saving || savedProfile !== JSON.stringify(readForm())) {
    adminStatus("다른 포트폴리오를 열기 전에 작성 내용을 저장해 주세요.");
    return;
  }
  const request = ++portfolioRequest;
  try {
    const portfolio = await api(id ? "admin/members/" + id : "profile");
    if (request !== portfolioRequest) return;
    editingMemberId = id;
    loadPortfolio(portfolio);
    adminStatus("");
    profileForm.scrollIntoView({block:"nearest"});
  } catch (error) {
    if (request === portfolioRequest) adminStatus(error.message);
  }
}

byId("prevPage").addEventListener("click", () => loadMembers(page - 1));
byId("nextPage").addEventListener("click", () => loadMembers(page + 1));
byId("openOwn").addEventListener("click", () => openPortfolio(""));
byId("inviteForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button");
  submit.disabled = true;
  byId("createdInvite").hidden = true;
  byId("createdCode").value = "";
  try {
    const {code} = await api("admin/members", "POST", Object.fromEntries(new FormData(form)));
    form.reset();
    byId("createdCode").value = code;
    byId("createdInvite").hidden = false;
    adminStatus("가입 링크와 초대 코드를 해당 회원에게 전달해 주세요.");
    byId("createdCode").focus();
    byId("createdCode").select();
  } catch (error) {
    adminStatus(error.message);
  } finally {
    submit.disabled = false;
  }
});

function showLogin() {
  activeMember = null;
  for (const [kind, state] of Object.entries(feedState)) {
    state.controller?.abort();
    state.data = null;
    byId(kind + "Items").replaceChildren();
    byId(kind + "Status").textContent = "";
  }
  byId("campusSources").replaceChildren();
  adminView++;
  portfolioRequest++;
  byId("memberRows").replaceChildren();
  byId("createdCode").value = "";
  byId("createdInvite").hidden = true;
  byId("inviteForm").reset();
  adminStatus("");
  profileForm.reset();
  byId("printProfile").replaceChildren();
  byId("appView").hidden = true;
  byId("loginView").hidden = false;
  byId("logoutBtn").hidden = true;
  byId("userLabel").textContent = "로그인 전";
}

byId("switchAuth").addEventListener("click", () => {
  const registering = registerForm.hidden;
  loginForm.reset();
  registerForm.reset();
  loginForm.hidden = registering;
  registerForm.hidden = !registering;
  byId("switchAuth").textContent = registering ? "로그인으로 돌아가기" : "회원가입";
  showLoginError("");
  (registering ? registerForm : loginForm).elements.namedItem("name").focus();
});

for (const [form, action] of [[loginForm, "login"], [registerForm, "register"]]) {
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = form.querySelector("button");
    submit.disabled = true;
    byId("switchAuth").disabled = true;
    showLoginError("");
    try {
      await api(action, "POST", Object.fromEntries(new FormData(form)));
      const profile = await api("profile");
      form.reset();
      showProfile(profile);
    } catch (error) {
      showLoginError(error.message || "잠시 후 다시 시도해 주세요.");
    } finally {
      submit.disabled = false;
      byId("switchAuth").disabled = false;
      if (activeMember && !registerForm.hidden) byId("switchAuth").click();
    }
  });
}

byId("logoutBtn").addEventListener("click", async () => {
  try {
    await api("logout", "POST", {});
    showLogin();
    loginForm.elements.namedItem("name").focus();
  } catch (error) {
    status(error.message);
  }
});

profileForm.addEventListener("submit", async event => {
  event.preventDefault();
  const submit = document.querySelector('[form="profileForm"]');
  submit.disabled = true;
  try {
    const profile = readForm();
    saving = true;
    portfolioRequest++;
    const {version} = await api(editingMemberId ? "admin/members/" + editingMemberId : "profile", "PUT", {...profile,version:profileVersion});
    profileVersion = version;
    if (!byId("adminControls").hidden) loadMembers();
    savedProfile = JSON.stringify(profile);
    status("포트폴리오를 저장했습니다.");
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      showLoginError(error.message);
    } else {
      status(error.message);
    }
  } finally {
    submit.disabled = false;
    saving = false;
  }
});

api("profile").then(showProfile).catch(error => {
  if (error.status !== 401) showLoginError("사이트에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
});

profileForm.addEventListener("input", () => {
  status("");
  updateStats();
});
byId("backup").addEventListener("click", () => {
  if (!activeMember || !profileForm.reportValidity()) return;
  const data = {member: activeMember, profile: readForm(), exportedAt: new Date().toISOString()};
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: "application/json"}));
  const link = element("a");
  link.href = url;
  link.download = activeMember + "_portfolio_backup.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function preparePrint() {
  const profile = readForm();
  const output = byId("printProfile");
  output.replaceChildren(element("p", "LOG:ON · LOGISTICS PORTFOLIO"), element("h1", activeMember + "의 포트폴리오"));
  for (const [title, definitions] of sections) {
    const populated = definitions.filter(([key]) => hasValue(profile, key));
    if (!populated.length) continue;
    const list = element("dl");
    for (const [key, label] of populated) list.append(element("dt", label), element("dd", profile[key]));
    output.append(element("h2", title), list);
  }
}
window.addEventListener("beforeprint", () => {
  if (activeMember && !byId("portfolioView").hidden) preparePrint();
});
byId("print").addEventListener("click", () => {
  if (!activeMember) return;
  preparePrint();
  const originalTitle = document.title;
  document.title = activeMember + " 포트폴리오";
  window.addEventListener("afterprint", () => { document.title = originalTitle; }, {once: true});
  window.print();
});
