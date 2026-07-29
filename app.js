const STORAGE_KEY = "coursePlannerV2";

const TERM_DEFS = [
  { id: "Y1S1", label: "Y1 · Sem 1" },
  { id: "Y1S2", label: "Y1 · Sem 2" },
  { id: "Y2S1", label: "Y2 · Sem 1" },
  { id: "Y2S2", label: "Y2 · Sem 2" },
];
const ALWAYS_CATEGORIES = ["core", "coreChoice", "generalInterest", "generalBroadening", "thesis"];

let catalog = null;
let curriculum = {};
let flatCourses = [];
let courseIndex = new Map();
let plan = {};            // id -> termId ("Y1S1" | "Y1S2" | "Y2S1" | "Y2S2")
let compareModuleId = "";
let searchText = "";
let filterKey = "";
let slideId = null;

init();

async function init() {
  loadState();
  try {
    const res = await fetch("data/courses.json");
    catalog = await res.json();
  } catch (e) {
    document.getElementById("statusbar").textContent = "Failed to load data/courses.json — " + e.message;
    return;
  }
  try {
    const curRes = await fetch("data/curriculum.json");
    if (curRes.ok) curriculum = await curRes.json();
  } catch (e) {
    // non-fatal
  }

  buildFlatIndex();
  normalizePlan();
  buildModuleSelect();
  buildFilterSelect();
  wireEvents();
  renderAll();
}

function buildFlatIndex() {
  flatCourses = [];
  courseIndex = new Map();
  for (const [key, cat] of Object.entries(catalog.categories)) {
    for (const c of cat.courses) {
      const entry = { ...c, sourceType: "category", sourceKey: key, sourceLabel: cat.label };
      flatCourses.push(entry);
      courseIndex.set(c.id, entry);
    }
  }
  for (const mod of catalog.modules) {
    for (const c of mod.courses) {
      const entry = { ...c, sourceType: "module", sourceKey: mod.id, sourceLabel: mod.name };
      flatCourses.push(entry);
      courseIndex.set(c.id, entry);
    }
  }
}

function normalizePlan() {
  let changed = false;
  for (const id of Object.keys(plan)) {
    const course = courseIndex.get(id);
    if (!course) { delete plan[id]; changed = true; continue; }
    const allowed = validTermsForCourse(course);
    if (!allowed.includes(plan[id])) { plan[id] = defaultTerm(course); changed = true; }
  }
  if (changed) saveState();
}

function buildModuleSelect() {
  const sel = document.getElementById("moduleSelect");
  for (const mod of catalog.modules) {
    const opt = document.createElement("option");
    opt.value = mod.id;
    opt.textContent = mod.name;
    sel.appendChild(opt);
  }
  sel.value = compareModuleId;
}

function buildFilterSelect() {
  const sel = document.getElementById("filterSelect");
  const defs = [
    ...Object.entries(catalog.categories).map(([key, cat]) => ({ key, label: cat.label })),
    ...catalog.modules.map((m) => ({ key: m.id, label: m.name })),
  ];
  for (const d of defs) {
    const opt = document.createElement("option");
    opt.value = d.key;
    opt.textContent = d.label;
    sel.appendChild(opt);
  }
}

function wireEvents() {
  document.getElementById("moduleSelect").addEventListener("change", (e) => {
    compareModuleId = e.target.value;
    saveState();
    renderAll();
  });

  document.getElementById("searchBox").addEventListener("input", (e) => {
    searchText = e.target.value.trim().toLowerCase();
    renderCatalog();
  });

  document.getElementById("filterSelect").addEventListener("change", (e) => {
    filterKey = e.target.value;
    renderCatalog();
  });

  document.getElementById("commitBtn").addEventListener("click", commitCompulsoryCourses);

  document.getElementById("timeline").addEventListener("click", (e) => {
    const mv = e.target.closest("[data-move]");
    if (mv) { moveChip(mv.dataset.move, mv.dataset.dir); return; }
    const rm = e.target.closest("[data-remove]");
    if (rm) { removeCourse(rm.dataset.remove); return; }
    const chip = e.target.closest("[data-chip]");
    if (chip) { openSlide(chip.dataset.chip); return; }
  });

  document.getElementById("catList").addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    if (add) { placeCourse(add.dataset.add); return; }
    const nm = e.target.closest("[data-open]");
    if (nm) { openSlide(nm.dataset.open); return; }
  });

  document.getElementById("closeSlide").addEventListener("click", closeSlide);
  document.getElementById("scrim").addEventListener("click", closeSlide);
}

/* ---------------- state ops ---------------- */

function defaultTerm(course) {
  if (course.ects >= 20) return "Y2S1";
  if (course.semester === 1) return "Y1S1";
  if (course.semester === 2) return "Y1S2";
  return "Y1S1";
}

function validTermsForCourse(course) {
  if (course.ects >= 20) return TERM_DEFS.map((t) => t.id);
  if (course.semester === 1) return ["Y1S1", "Y2S1"];
  if (course.semester === 2) return ["Y1S2", "Y2S2"];
  return TERM_DEFS.map((t) => t.id);
}

function placeCourse(id) {
  if (plan[id]) return;
  const course = courseIndex.get(id);
  plan[id] = defaultTerm(course);
  saveState();
  renderAll();
}

function removeCourse(id) {
  delete plan[id];
  saveState();
  renderAll();
  if (slideId === id) closeSlide();
}

function moveChip(id, dir) {
  const course = courseIndex.get(id);
  const allowed = validTermsForCourse(course);
  const idx = allowed.indexOf(plan[id]);
  const next = idx + (dir === "next" ? 1 : -1);
  if (next < 0 || next >= allowed.length) return;
  plan[id] = allowed[next];
  saveState();
  renderAll();
}

function universalCompulsoryCourses() {
  return flatCourses.filter(
    (c) => c.sourceType === "category" && ALWAYS_CATEGORIES.includes(c.sourceKey) && c.compulsory
  );
}
function moduleCompulsoryCourses(moduleId) {
  return flatCourses.filter((c) => c.sourceType === "module" && c.sourceKey === moduleId && c.compulsory);
}
function missingCompulsoryCourses() {
  if (!compareModuleId) return [];
  const needed = [...universalCompulsoryCourses(), ...moduleCompulsoryCourses(compareModuleId)];
  return needed.filter((c) => !plan[c.id]);
}
function commitCompulsoryCourses() {
  const missing = missingCompulsoryCourses();
  if (!missing.length) return;
  for (const c of missing) plan[c.id] = defaultTerm(c);
  saveState();
  renderAll();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ plan, compareModuleId }));
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    plan = data.plan || {};
    compareModuleId = data.compareModuleId || "";
  } catch (e) {
    plan = {};
    compareModuleId = "";
  }
}

/* ---------------- derived data ---------------- */

function planItemsFor(sourceType, sourceKey) {
  return Object.keys(plan)
    .map((id) => courseIndex.get(id))
    .filter((c) => c && c.sourceType === sourceType && c.sourceKey === sourceKey);
}
function overflowModuleEcts() {
  if (!compareModuleId) return 0;
  let total = 0;
  for (const mod of catalog.modules) {
    if (mod.id === compareModuleId) continue;
    total += planItemsFor("module", mod.id).reduce((s, c) => s + (c.ects || 0), 0);
  }
  return total;
}
function statusClass(sum, min, max) {
  if (max != null && sum > max) return "over";
  if (min != null && sum < min) return "under";
  return "ok";
}
function reqText(min, max) {
  if (min != null && max != null) return `${min}–${max}`;
  if (max != null) return `up to ${max}`;
  if (min != null) return `min ${min}`;
  return "flexible";
}

/* ---------------- render ---------------- */

function renderAll() {
  renderTitleblock();
  renderTimeline();
  renderReqPanel();
  renderCatalog();
  updateCommitButton();
  renderStatusbar();
}

function renderTitleblock() {
  const coreSum = planItemsFor("category", "core").reduce((s, c) => s + (c.ects || 0), 0);
  const coreMin = catalog.categories.core.minEcts;
  document.getElementById("coreStat").textContent = `${coreSum}/${coreMin}`;

  const modStatEl = document.getElementById("modStat");
  if (compareModuleId) {
    const mod = catalog.modules.find((m) => m.id === compareModuleId);
    const sum = planItemsFor("module", compareModuleId).reduce((s, c) => s + (c.ects || 0), 0);
    modStatEl.textContent = `${sum}/${mod.minEcts}`;
  } else {
    modStatEl.textContent = "—/—";
  }

  const total = Object.keys(plan).reduce((s, id) => s + (courseIndex.get(id)?.ects || 0), 0);
  document.getElementById("totalStat").textContent = `${total}/${catalog.totalEcts}`;
}

function renderTimeline() {
  const wrap = document.getElementById("timeline");
  wrap.innerHTML = TERM_DEFS.map((t) => {
    const items = Object.entries(plan)
      .filter(([, term]) => term === t.id)
      .map(([id]) => courseIndex.get(id))
      .filter(Boolean);
    const sum = items.reduce((s, c) => s + (c.ects || 0), 0);
    const pct = Math.min(100, (sum / 30) * 100);
    return `<div class="sem-col">
      <div class="sem-head">
        <span class="lbl">${t.label}</span>
        <div class="gauge"><div class="gauge-fill ${sum > 32 ? "over" : ""}" style="width:${pct}%"></div></div>
        <div class="num tnum">${sum} ECTS</div>
      </div>
      <div class="chips">${
        items.length ? items.map((c) => chipHtml(c, t.id)).join("") : `<div class="empty-slot">Nothing placed here</div>`
      }</div>
    </div>`;
  }).join("");
}

function chipHtml(c, termId) {
  const allowed = validTermsForCourse(c);
  const idx = allowed.indexOf(termId);
  const canPrev = idx > 0;
  const canNext = idx < allowed.length - 1;
  return `<div class="chip" data-chip="${c.id}">
    <span class="code">${escapeHtml(c.code || "")}</span>
    <span class="ec tnum">${c.ects != null ? c.ects : "?"}</span>
    <span class="nm">${escapeHtml(c.name)}</span>
    <div class="mv">
      <button data-move="${c.id}" data-dir="prev" ${canPrev ? "" : "disabled"}>&larr;</button>
      <button data-move="${c.id}" data-dir="next" ${canNext ? "" : "disabled"}>&rarr;</button>
      <button class="rm" data-remove="${c.id}" style="margin-left:auto">remove</button>
    </div>
  </div>`;
}

function renderReqPanel() {
  const panel = document.getElementById("reqPanel");
  const rows = [];

  for (const key of ALWAYS_CATEGORIES) {
    const cat = catalog.categories[key];
    const items = planItemsFor("category", key);
    const sum = items.reduce((s, c) => s + (c.ects || 0), 0);
    rows.push(reqRow(cat.label, sum, cat.minEcts ?? null, cat.maxEcts ?? null));
  }

  if (compareModuleId) {
    const mod = catalog.modules.find((m) => m.id === compareModuleId);
    const sum = planItemsFor("module", compareModuleId).reduce((s, c) => s + (c.ects || 0), 0);
    rows.push(reqRow(mod.name, sum, mod.minEcts, null, "primary module"));
  } else {
    rows.push(`<div class="req-row"><div class="rlbl"><b>Module</b><span>none selected</span></div><div class="req-note">Pick a module in the titleblock above.</div></div>`);
  }

  const electivesCat = catalog.categories.electives;
  const ownElectives = planItemsFor("category", "electives").reduce((s, c) => s + (c.ects || 0), 0);
  const overflow = overflowModuleEcts();
  rows.push(reqRow(electivesCat.label, ownElectives + overflow, null, electivesCat.targetEcts ?? null, overflow > 0 ? `includes ${overflow} ECTS from non-primary modules` : null));

  panel.innerHTML = rows.join("");
}

function reqRow(label, sum, min, max, note) {
  const cls = statusClass(sum, min, max);
  const target = max || min || sum || 1;
  const pct = Math.max(4, Math.min(100, (sum / target) * 100));
  return `<div class="req-row">
    <div class="rlbl"><b>${escapeHtml(label)}</b><span class="tnum">${sum} / ${reqText(min, max)} ECTS</span></div>
    <div class="req-bar"><div class="req-bar-fill ${cls}" style="width:${pct}%"></div></div>
    ${note ? `<div class="req-note">${escapeHtml(note)}</div>` : ""}
  </div>`;
}

function renderCatalog() {
  const list = document.getElementById("catList");
  const filtered = flatCourses.filter((c) => {
    if (plan[c.id]) return false;
    if (searchText && !c.name.toLowerCase().includes(searchText)) return false;
    if (filterKey && c.sourceKey !== filterKey) return false;
    return true;
  });

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-slot">No matching courses.</div>`;
    return;
  }

  list.innerHTML = filtered
    .map(
      (c) => `<div class="cat-row">
      <span class="nm" data-open="${c.id}">${escapeHtml(c.name)}<span class="meta">${escapeHtml(c.sourceLabel)} · ${semesterLabel(c.semester)}</span></span>
      <span class="ec tnum">${c.ects != null ? c.ects + " ECTS" : "?"}</span>
      <button class="add-btn" data-add="${c.id}">Place</button>
    </div>`
    )
    .join("");
}

function semesterLabel(sem) {
  if (sem === 1) return "Sem 1";
  if (sem === 2) return "Sem 2";
  if (sem === "either") return "Either sem";
  return "Sem ?";
}

function updateCommitButton() {
  const btn = document.getElementById("commitBtn");
  if (!compareModuleId) { btn.hidden = true; return; }
  const mod = catalog.modules.find((m) => m.id === compareModuleId);
  const missing = missingCompulsoryCourses();
  btn.hidden = false;
  if (!missing.length) {
    btn.textContent = "✓ Compulsory placed";
    btn.disabled = true;
  } else {
    btn.textContent = `+ Place ${missing.length} compulsory`;
    btn.disabled = false;
    btn.title = `Core + Thesis + ${mod.name}`;
  }
}

function renderStatusbar() {
  const count = Object.keys(plan).length;
  document.getElementById("statusbar").textContent =
    `${count} course${count === 1 ? "" : "s"} on the sheet · data sourced from KU Leuven onderwijsaanbod (verify against the official catalogue before enrolling)`;
}

/* ---------------- slide-over ---------------- */

function openSlide(id) {
  slideId = id;
  const c = courseIndex.get(id);
  const info = c.code ? curriculum[c.code] : null;
  const fields = info
    ? [
        ["Content", info.content],
        ["Learning outcomes", info.learningOutcomes],
        ["Prerequisites", info.prerequisites],
        ["Evaluation", info.evaluation],
        ["Teaching methods", info.teachingMethods],
        ["Language", info.language],
        ["Lecturer", info.lecturer],
      ].filter(([, v]) => v)
    : [];

  const inPlan = !!plan[id];
  document.getElementById("slideContent").innerHTML = `
    <span class="slide-code">${escapeHtml(c.code || "")}</span>
    <h3 class="slide-title">${escapeHtml(c.name)}</h3>
    <p class="slide-sub">${c.ects != null ? c.ects + " ECTS" : "?"} · ${semesterLabel(c.semester)} · ${escapeHtml(c.sourceLabel)}</p>
    ${
      fields.length
        ? fields.map(([label, val]) => `<div class="slide-field"><b>${escapeHtml(label)}</b>${escapeHtml(val)}</div>`).join("")
        : `<div class="slide-field"><b>Curriculum info</b><em>Not available for this course.</em></div>`
    }
    ${info && info.sourceUrl ? `<a class="slide-link" href="${info.sourceUrl}" target="_blank" rel="noopener">View official syllabus &#8599;</a>` : ""}
    <div class="slide-action">
      <button class="${inPlan ? "rm" : ""}" data-slide-toggle="${id}">${inPlan ? "Remove from sheet" : "Place on sheet"}</button>
    </div>
  `;
  document.querySelector("[data-slide-toggle]").addEventListener("click", () => {
    inPlan ? removeCourse(id) : placeCourse(id);
    if (!inPlan) openSlide(id);
  });

  document.getElementById("slideover").classList.add("open");
  document.getElementById("scrim").classList.add("open");
}

function closeSlide() {
  slideId = null;
  document.getElementById("slideover").classList.remove("open");
  document.getElementById("scrim").classList.remove("open");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[m]));
}
