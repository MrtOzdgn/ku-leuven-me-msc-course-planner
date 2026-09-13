const STORAGE_KEY = "coursePlannerV4";
const DAY_START = 7;
const DAY_END = 20;
const HOUR_PX = 52;
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const ALWAYS_CATEGORIES = ["core", "coreChoice", "generalInterest", "generalBroadening", "thesis"];
const FIXED_STAGE = { core: 1, coreChoice: 1, thesis: 2 };

let catalog = null;
let curriculum = {};
let schedule = {};
let calendarWeeks = [];
let flatCourses = [];
let courseIndex = new Map();
let plan = {};              // id -> { stage: 1|2, groupChoices: { olaCode: groupKey } }
let compareModuleId = "";
let searchText = "";
let filterKey = "";
let slideId = null;
let activeTab = "catalog";
let weekIdx = 0;

init();

async function init() {
  loadState();
  try {
    const [c, cur, sched, cal] = await Promise.all([
      fetch("data/courses.json").then((r) => r.json()),
      fetch("data/curriculum.json").then((r) => r.json()).catch(() => ({})),
      fetch("data/schedule.json").then((r) => r.json()).catch(() => ({})),
      fetch("data/academic-calendar.json").then((r) => r.json()).catch(() => ({ weeks: [] })),
    ]);
    catalog = c;
    curriculum = cur;
    schedule = sched;
    calendarWeeks = cal.weeks || [];
  } catch (e) {
    document.getElementById("statusbar").textContent = "Failed to load data — " + e.message;
    return;
  }

  buildFlatIndex();
  normalizePlan();
  buildModuleSelect();
  buildFilterSelect();
  wireEvents();
  weekIdx = 0;
  renderAll();
}

/* ---------------- data setup ---------------- */

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
    const fixed = FIXED_STAGE[course.sourceKey];
    if (fixed && plan[id].stage !== fixed) { plan[id].stage = fixed; changed = true; }
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

/* ---------------- events ---------------- */

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

  document.getElementById("weekPrev").addEventListener("click", () => { weekIdx = Math.max(0, weekIdx - 1); renderCalendarArea(); });
  document.getElementById("weekNext").addEventListener("click", () => { weekIdx = Math.min(calendarWeeks.length - 1, weekIdx + 1); renderCalendarArea(); });
  document.getElementById("weekToday").addEventListener("click", () => { weekIdx = closestWeekIndexToToday(); renderCalendarArea(); });

  document.querySelectorAll(".side-tab").forEach((btn) => {
    btn.addEventListener("click", () => { activeTab = btn.dataset.tab; renderSideTabs(); });
  });

  document.getElementById("catList").addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    if (add) { placeCourse(add.dataset.add); return; }
    const nm = e.target.closest("[data-open]");
    if (nm) { openSlide(nm.dataset.open); return; }
  });

  document.getElementById("conflictList").addEventListener("click", (e) => {
    const item = e.target.closest("[data-jump]");
    if (item) {
      const targetMonday = item.dataset.jump;
      const idx = calendarWeeks.findIndex((w) => w.monday === targetMonday);
      if (idx >= 0) { weekIdx = idx; renderCalendarArea(); document.querySelector('[data-tab="catalog"]').click(); }
    }
  });

  document.getElementById("stage2List").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) removeCourse(rm.dataset.remove);
  });

  document.getElementById("closeSlide").addEventListener("click", closeSlide);
  document.getElementById("scrim").addEventListener("click", closeSlide);
}

/* ---------------- plan ops ---------------- */

function defaultStageFor(course) {
  return FIXED_STAGE[course.sourceKey] || 1;
}

function placeCourse(id) {
  if (plan[id]) return;
  const course = courseIndex.get(id);
  plan[id] = { stage: defaultStageFor(course), groupChoices: {} };
  saveState();
  renderAll();
}

function removeCourse(id) {
  delete plan[id];
  saveState();
  renderAll();
  if (slideId === id) closeSlide();
}

function setStage(id, stage) {
  if (!plan[id]) return;
  plan[id].stage = stage;
  saveState();
  renderAll();
}

function universalCompulsoryCourses() {
  return flatCourses.filter((c) => c.sourceType === "category" && ALWAYS_CATEGORIES.includes(c.sourceKey) && c.compulsory);
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
  for (const c of missing) plan[c.id] = { stage: defaultStageFor(c), groupChoices: {} };
  saveState();
  renderAll();
}

function setGroupChoice(courseId, olaCode, groupKey) {
  const entry = plan[courseId];
  if (!entry) return;
  if (!entry.groupChoices) entry.groupChoices = {};
  entry.groupChoices[olaCode] = groupKey;
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

/* ---------------- schedule resolution ---------------- */

// A multi-group activity (e.g. a seminar offered at several alternative times)
// only needs ONE of its listed groups to be satisfied — exactly like KU Loket's
// own checkbox picker. We auto-pick a sensible default the first time an
// activity is seen (preferring the course's own module, then the primary
// module, then whatever comes first) and persist that choice so it stays
// stable and editable — the user can freely switch to any other listed group,
// including ones outside their module, to dodge a conflict.
function isMultiGroup(activity) {
  return !activity.groups._single;
}

function groupOptions(activity) {
  return Object.entries(activity.groups).map(([key, g]) => ({ key, label: g.label || key }));
}

function defaultGroupKey(course, activity) {
  const groups = activity.groups;
  const keys = Object.keys(groups);
  const bySourceModule = keys.find((k) => groups[k].moduleHint === course.sourceKey);
  if (bySourceModule) return bySourceModule;
  const byPrimary = compareModuleId && keys.find((k) => groups[k].moduleHint === compareModuleId);
  if (byPrimary) return byPrimary;
  return keys[0];
}

function resolveActivitySessions(course, activity, courseId) {
  const groups = activity.groups;
  if (groups._single) return groups._single.sessions;

  const entry = plan[courseId];
  let chosen = entry?.groupChoices?.[activity.olaCode];
  if (!chosen || !groups[chosen]) {
    chosen = defaultGroupKey(course, activity);
    if (entry) {
      if (!entry.groupChoices) entry.groupChoices = {};
      entry.groupChoices[activity.olaCode] = chosen;
    }
  }
  return groups[chosen] ? groups[chosen].sessions : [];
}

function getPlacedStage1Sessions() {
  const out = [];
  for (const [id, entry] of Object.entries(plan)) {
    if (entry.stage !== 1) continue;
    const course = courseIndex.get(id);
    if (!course) continue;
    const sched = schedule[id];
    if (!sched) continue;
    for (const activity of sched.activities) {
      const sessions = resolveActivitySessions(course, activity, id);
      for (const s of sessions) {
        out.push({ courseId: id, courseName: course.name, olaCode: activity.olaCode, olaName: activity.olaName, ...s });
      }
    }
  }
  return out;
}

function sessionOverlaps(a, b) {
  return a.begin < b.end && b.begin < a.end;
}

function computeAllConflicts() {
  const sessions = getPlacedStage1Sessions();
  const conflicts = [];
  const seen = new Set();
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i], b = sessions[j];
      if (a.courseId === b.courseId) continue;
      if (a.date !== b.date) continue;
      if (sessionOverlaps(a, b)) {
        const key = [a.courseId, a.olaCode, a.begin, b.courseId, b.olaCode, b.begin].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push({ a, b, date: a.date });
      }
    }
  }
  conflicts.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return conflicts;
}

/* ---------------- week nav helpers ---------------- */

// All date math below is done in UTC-only terms (construct with a "Z" suffix,
// read/write with the UTC getters, format with timeZone:"UTC") so a viewer's
// local timezone can never shift the calendar by a day.

function mondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function closestWeekIndexToToday() {
  if (!calendarWeeks.length) return 0;
  const now = new Date();
  const todayIso = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString().slice(0, 10);
  const todayMonday = mondayOf(todayIso);
  let best = 0;
  for (let i = 0; i < calendarWeeks.length; i++) {
    if (calendarWeeks[i].monday <= todayMonday) best = i;
  }
  return best;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtShort(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
function fmtLong(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
function weekdayLong(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
}

/* ---------------- render ---------------- */

function renderAll() {
  renderTitleblock();
  renderCalendarArea();
  renderSideTabs();
  updateCommitButton();
  renderStatusbar();
  saveState(); // persists any group choices that were just auto-defaulted during resolution
}

function renderTitleblock() {
  const coreSum = flatCourses
    .filter((c) => c.sourceType === "category" && c.sourceKey === "core" && plan[c.id])
    .reduce((s, c) => s + (c.ects || 0), 0);
  document.getElementById("coreStat").textContent = `${coreSum}/${catalog.categories.core.minEcts}`;

  const modStatEl = document.getElementById("modStat");
  if (compareModuleId) {
    const mod = catalog.modules.find((m) => m.id === compareModuleId);
    const sum = flatCourses
      .filter((c) => c.sourceType === "module" && c.sourceKey === compareModuleId && plan[c.id])
      .reduce((s, c) => s + (c.ects || 0), 0);
    modStatEl.textContent = `${sum}/${mod.minEcts}`;
  } else {
    modStatEl.textContent = "—/—";
  }

  const total = Object.keys(plan).reduce((s, id) => s + (courseIndex.get(id)?.ects || 0), 0);
  document.getElementById("totalStat").textContent = `${total}/${catalog.totalEcts}`;
}

function renderCalendarArea() {
  if (!calendarWeeks.length) return;
  const week = calendarWeeks[weekIdx];
  const monday = week.monday;
  const friday = addDays(monday, 4);
  document.getElementById("weekRange").textContent = `${fmtLong(monday)} – ${fmtLong(friday)}`;
  document.getElementById("semBadge").textContent = `Semester ${week.semester}`;
  document.getElementById("weekPrev").disabled = weekIdx === 0;
  document.getElementById("weekNext").disabled = weekIdx === calendarWeeks.length - 1;

  const allSessions = getPlacedStage1Sessions();
  const allConflicts = computeAllConflicts();
  const conflictKeySet = new Set();
  for (const { a, b } of allConflicts) {
    conflictKeySet.add(a.courseId + "|" + a.olaCode + "|" + a.begin);
    conflictKeySet.add(b.courseId + "|" + b.olaCode + "|" + b.begin);
  }

  const totalHeight = (DAY_END - DAY_START) * HOUR_PX;

  const hoursWrap = document.getElementById("calHours");
  hoursWrap.style.height = totalHeight + "px";
  hoursWrap.innerHTML = "";
  for (let h = DAY_START; h <= DAY_END; h++) {
    const lbl = document.createElement("div");
    lbl.className = "cal-hour-label";
    lbl.style.top = (h - DAY_START) * HOUR_PX + "px";
    lbl.textContent = `${h}:00`;
    hoursWrap.appendChild(lbl);
  }

  const daysWrap = document.getElementById("calDays");
  daysWrap.innerHTML = "";
  for (let d = 0; d < 5; d++) {
    const dateStr = addDays(monday, d);
    const daySessions = allSessions.filter((s) => s.date === dateStr).sort((a, b) => (a.begin < b.begin ? -1 : 1));

    const col = document.createElement("div");
    col.className = "cal-day-col";
    const head = document.createElement("div");
    head.className = "cal-day-head";
    head.textContent = `${DAY_NAMES[d].slice(0, 3)} ${fmtShort(dateStr)}`;
    col.appendChild(head);

    const bodyEl = document.createElement("div");
    bodyEl.className = "cal-day-body";
    bodyEl.style.height = totalHeight + "px";

    const clusters = clusterOverlaps(daySessions);
    for (const cluster of clusters) {
      cluster.forEach((s, i) => {
        const block = document.createElement("div");
        const isConflict = conflictKeySet.has(s.courseId + "|" + s.olaCode + "|" + s.begin);
        const isPrimary = courseIndex.get(s.courseId)?.sourceKey === compareModuleId;
        block.className = "cal-block" + (isConflict ? " conflict" : isPrimary ? " primary-mod" : "");
        const top = minutesFromDayStart(s.begin);
        const height = minutesFromDayStart(s.end) - top;
        block.style.top = (top / 60) * HOUR_PX + "px";
        block.style.height = Math.max(16, (height / 60) * HOUR_PX - 2) + "px";
        block.style.width = 100 / cluster.length - 1 + "%";
        block.style.left = (100 / cluster.length) * i + "%";
        block.dataset.open = s.courseId;
        block.innerHTML = `<span class="nm">${escapeHtml(s.courseName)}</span><span class="meta">${timeOf(s.begin)}–${timeOf(s.end)} · ${escapeHtml((s.room || "").split(" ")[0] || "")}</span>`;
        bodyEl.appendChild(block);
      });
    }
    col.appendChild(bodyEl);
    daysWrap.appendChild(col);
  }
  daysWrap.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => openSlide(el.dataset.open)));

  document.getElementById("conflictFlag").hidden = allConflicts.length === 0;
  if (allConflicts.length) document.getElementById("conflictFlag").textContent = `${allConflicts.length} conflict${allConflicts.length === 1 ? "" : "s"} in your plan`;
}

function minutesFromDayStart(iso) {
  const d = new Date(iso);
  return (d.getHours() - DAY_START) * 60 + d.getMinutes();
}
function timeOf(iso) {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function clusterOverlaps(sortedSessions) {
  const clusters = [];
  for (const s of sortedSessions) {
    let placed = false;
    for (const cluster of clusters) {
      if (cluster.some((o) => sessionOverlaps(o, s))) {
        cluster.push(s);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([s]);
  }
  return clusters;
}

/* ---------------- side tabs ---------------- */

function renderSideTabs() {
  document.querySelectorAll(".side-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === activeTab));
  document.getElementById("panelCatalog").hidden = activeTab !== "catalog";
  document.getElementById("panelRequirements").hidden = activeTab !== "requirements";
  document.getElementById("panelConflicts").hidden = activeTab !== "conflicts";
  document.getElementById("panelStage2").hidden = activeTab !== "stage2";

  if (activeTab === "catalog") renderCatalog();
  if (activeTab === "requirements") renderReqPanel();
  if (activeTab === "conflicts") renderConflictList();
  if (activeTab === "stage2") renderStage2List();

  const conflicts = computeAllConflicts();
  const cc = document.getElementById("conflictCount");
  cc.textContent = conflicts.length ? `(${conflicts.length})` : "";
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
    list.innerHTML = `<div class="empty-hint">No matching courses.</div>`;
    return;
  }
  list.innerHTML = filtered
    .map((c) => {
      const hasSched = !!schedule[c.id];
      return `<div class="cat-row">
      <span class="nm" data-open="${c.id}">${escapeHtml(c.name)}<span class="meta">${escapeHtml(c.sourceLabel)} · ${semesterLabel(c.semester)}${hasSched ? "" : ` · <span class="nosched">no published hours</span>`}</span></span>
      <span class="ec tnum">${c.ects != null ? c.ects + " ECTS" : "?"}</span>
      <button class="add-btn" data-add="${c.id}">Add</button>
    </div>`;
    })
    .join("");
}

function semesterLabel(sem) {
  if (sem === 1) return "Sem 1";
  if (sem === 2) return "Sem 2";
  if (sem === "either") return "Either sem";
  return "Sem ?";
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

  const unscheduled = Object.entries(plan)
    .filter(([id, e]) => e.stage === 1 && !schedule[id])
    .map(([id]) => courseIndex.get(id))
    .filter(Boolean);
  let extra = "";
  if (unscheduled.length) {
    extra = `<div class="req-row"><div class="rlbl"><b>Placed, no calendar data</b><span>${unscheduled.length}</span></div><div class="req-note">${unscheduled.map((c) => escapeHtml(c.name)).join(", ")}</div></div>`;
  }
  panel.innerHTML = rows.join("") + extra;
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

function renderConflictList() {
  const el = document.getElementById("conflictList");
  const conflicts = computeAllConflicts();
  if (!conflicts.length) {
    el.innerHTML = `<div class="empty-hint">No conflicts detected in your current plan.</div>`;
    return;
  }
  el.innerHTML = conflicts
    .map(({ a, b, date }) => {
      const monday = mondayOf(date);
      return `<div class="conflict-item" data-jump="${monday}">
      <div class="date">${fmtLong(date)} — ${weekdayLong(date)}</div>
      <div class="pair">${escapeHtml(a.courseName)} <span class="tnum">(${timeOf(a.begin)}–${timeOf(a.end)})</span><br>vs<br>${escapeHtml(b.courseName)} <span class="tnum">(${timeOf(b.begin)}–${timeOf(b.end)})</span></div>
    </div>`;
    })
    .join("");
}

function renderStage2List() {
  const el = document.getElementById("stage2List");
  const items = Object.entries(plan)
    .filter(([, e]) => e.stage === 2)
    .map(([id]) => courseIndex.get(id))
    .filter(Boolean);
  if (!items.length) {
    el.innerHTML = `<div class="empty-hint">No Stage 2 courses in your plan yet. Use the slide-over (click a course) to push a flexible course to Stage 2.</div>`;
    return;
  }
  el.innerHTML = items
    .map(
      (c) => `<div class="stage2-row">
      <span data-open="${c.id}" style="cursor:pointer">${escapeHtml(c.name)}<br><span class="ec">${escapeHtml(c.sourceLabel)}</span></span>
      <span class="ec tnum">${c.ects} ECTS</span>
      <button class="add-btn" data-remove="${c.id}" style="border-color:var(--over);background:var(--over-soft);color:var(--over)">Remove</button>
    </div>`
    )
    .join("");
  el.querySelectorAll("[data-open]").forEach((e) => e.addEventListener("click", () => openSlide(e.dataset.open)));
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
    `${count} course${count === 1 ? "" : "s"} in your plan · schedule data sourced from KU Leuven's official timetable export (verify against KU Loket before finalizing your ISP)`;
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
  const fixedStage = FIXED_STAGE[c.sourceKey];
  const sched = schedule[id];

  let sessionsHtml = "";
  if (sched) {
    const conflicts = computeAllConflicts();
    const conflictKeySet = new Set();
    for (const { a, b } of conflicts) {
      conflictKeySet.add(a.courseId + "|" + a.olaCode + "|" + a.begin);
      conflictKeySet.add(b.courseId + "|" + b.olaCode + "|" + b.begin);
    }
    for (const activity of sched.activities) {
      const allSessions = resolveActivitySessions(c, activity, id);
      const sessions = allSessions.slice(0, 8);
      if (!allSessions.length) continue;

      let pickerHtml = "";
      if (inPlan && isMultiGroup(activity)) {
        const opts = groupOptions(activity);
        const current = plan[id].groupChoices?.[activity.olaCode] || defaultGroupKey(c, activity);
        pickerHtml = `<select class="group-picker" data-group-picker="${activity.olaCode}">
          ${opts.map((o) => `<option value="${escapeHtml(o.key)}" ${o.key === current ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
        </select>
        <div class="req-note">Only one of these needs to work for you — pick whichever avoids a clash.</div>`;
      }

      sessionsHtml += `<div class="slide-field"><b>${escapeHtml(activity.olaName)}</b>
        ${pickerHtml}
        <div class="slide-sessions">${sessions
          .map((s) => {
            const isConf = conflictKeySet.has(id + "|" + activity.olaCode + "|" + s.begin);
            return `<div class="slide-session-row${isConf ? " conflict" : ""}">
              <span>${fmtShort(s.date)} ${s.weekday.slice(0, 3)}</span>
              <span class="tnum">${timeOf(s.begin)}–${timeOf(s.end)}</span>
            </div>`;
          })
          .join("")}</div>
      </div>`;
    }
  }

  document.getElementById("slideContent").innerHTML = `
    <span class="slide-code">${escapeHtml(c.code || "")}</span>
    <h3 class="slide-title">${escapeHtml(c.name)}</h3>
    <p class="slide-sub">${c.ects != null ? c.ects + " ECTS" : "?"} · ${semesterLabel(c.semester)} · ${escapeHtml(c.sourceLabel)}</p>
    ${
      fields.length
        ? fields.map(([label, val]) => `<div class="slide-field"><b>${escapeHtml(label)}</b>${escapeHtml(val)}</div>`).join("")
        : `<div class="slide-field"><b>Curriculum info</b><em>Not available for this course.</em></div>`
    }
    ${sessionsHtml || (sched ? "" : `<div class="slide-field"><b>Weekly schedule</b><em>No published contact hours found for this course in the KU Leuven export.</em></div>`)}
    ${info && info.sourceUrl ? `<a class="slide-link" href="${info.sourceUrl}" target="_blank" rel="noopener">View official syllabus &#8599;</a>` : ""}
    <div class="slide-action">
      <button class="${inPlan ? "rm" : ""}" data-slide-toggle="${id}">${inPlan ? "Remove from plan" : "Add to plan"}</button>
      ${
        inPlan && !fixedStage
          ? `<select data-stage-select="${id}">
              <option value="1" ${plan[id].stage === 1 ? "selected" : ""}>Stage 1</option>
              <option value="2" ${plan[id].stage === 2 ? "selected" : ""}>Stage 2</option>
            </select>`
          : inPlan
          ? `<span class="ec">Stage ${fixedStage} (fixed)</span>`
          : ""
      }
    </div>
  `;
  document.querySelector("[data-slide-toggle]").addEventListener("click", () => {
    inPlan ? removeCourse(id) : placeCourse(id);
    if (!inPlan) openSlide(id);
  });
  const stageSel = document.querySelector("[data-stage-select]");
  if (stageSel) stageSel.addEventListener("change", (e) => setStage(id, Number(e.target.value)));
  document.querySelectorAll("[data-group-picker]").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      setGroupChoice(id, sel.dataset.groupPicker, e.target.value);
      openSlide(id);
    });
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
