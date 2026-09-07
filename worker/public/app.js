/* agent-track UI. No build step, no dependencies. */
(() => {
  "use strict";

  // ---------- constants ----------
  const STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"];
  const STATUS_LABEL = { todo: "Todo", in_progress: "In progress", blocked: "Blocked", done: "Done", cancelled: "Cancelled" };
  const TYPES = ["bug", "feature", "improvement", "chore", "research"];
  const COLUMNS = ["todo", "in_progress", "blocked", "done"];
  const TOKEN_KEY = "agentTrackToken";

  // ---------- state ----------
  const S = {
    token: null,
    projects: [],
    showArchived: false,
    route: { view: "home" },
    project: null, // ProjectDetail
    tasks: [], // tasks of the current initiative
    lastRender: 0,
    drawerTaskId: null,
    showCancelled: false,
    filter: "",
    descOpen: false,
    es: null,
    esErrors: 0,
    pollTimer: null,
    esProject: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- api ----------
  async function api(path, opts = {}) {
    const headers = { Authorization: `Bearer ${S.token}` };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(path, { method: opts.method || (opts.body !== undefined ? "POST" : "GET"), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    if (r.status === 401) {
      signOut(true);
      throw new Error("Token rejected");
    }
    if (!r.ok) {
      let msg = `${r.status}`;
      try { msg = (await r.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    return r.status === 204 ? null : r.json();
  }
  const patch = (path, body) => api(path, { method: "PATCH", body });

  function toast(msg, kind = "") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), kind === "error" ? 5000 : 2500);
  }
  const fail = (e) => toast(e.message || String(e), "error");

  // ---------- helpers ----------
  function rel(ts) {
    const d = Date.now() - ts;
    const m = Math.round(d / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.round(h / 24);
    if (days < 14) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }
  function md(text) {
    // tiny, safe markdown: escape, then `code`, **bold**, links, line breaks.
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    return s;
  }
  const chip = (type) => `<span class="chip ${esc(type)}">${esc(type)}</span>`;
  const prio = (p) => `<span class="prio p${p}">P${p}</span>`;
  const statusSelect = (current, cls = "") =>
    `<select class="${cls}" data-status-select>${STATUSES.map((s) => `<option value="${s}" ${s === current ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}</select>`;
  const typeSelect = (current) => `<select data-type-select>${TYPES.map((t) => `<option value="${t}" ${t === current ? "selected" : ""}>${t}</option>`).join("")}</select>`;
  const prioSelect = (current) => `<select data-prio-select>${[0, 1, 2, 3, 4].map((p) => `<option value="${p}" ${p === current ? "selected" : ""}>P${p}${p === 0 ? " urgent" : p === 4 ? " someday" : ""}</option>`).join("")}</select>`;

  // Long descriptions collapse to one line so the board below stays visible.
  const DESC_LIMIT = 140;
  function descBlock(text, editAttr, placeholder) {
    if (!text) return `<p class="desc editable" ${editAttr} title="Click to edit"><span class="hint">${placeholder}</span></p>`;
    const long = text.length > DESC_LIMIT || text.includes("\n");
    if (!long) return `<p class="desc editable" ${editAttr} title="Click to edit">${md(text)}</p>`;
    return `<div class="desc-wrap ${S.descOpen ? "open" : ""}">
      <p class="desc editable clamp" ${editAttr} title="Click to edit">${md(text)}</p>
      <button class="link desc-toggle" data-toggle-desc>${S.descOpen ? "Show less" : "Read more"}</button>
    </div>`;
  }

  // ---------- routing ----------
  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, "");
    const parts = h.split("/").filter(Boolean);
    if (parts[0] === "p" && parts[1]) {
      if (parts[2] === "i" && parts[3]) return { view: "initiative", slug: decodeURIComponent(parts[1]), initiative: parts[3] };
      return { view: "project", slug: decodeURIComponent(parts[1]) };
    }
    return { view: "home" };
  }
  async function navigate() {
    S.route = parseRoute();
    S.descOpen = false;
    closeDrawer();
    try {
      await loadForRoute();
      render();
    } catch (e) {
      fail(e);
      $("#main").innerHTML = `<div class="empty"><h2>Not found</h2><p>${esc(e.message)}</p></div>`;
    }
  }
  async function loadForRoute() {
    if (S.route.view === "home") {
      S.project = null;
      S.tasks = [];
      stopLive();
      return;
    }
    S.project = await api(`/api/projects/${encodeURIComponent(S.route.slug)}`);
    if (S.route.view === "initiative") {
      S.tasks = await api(`/api/initiatives/${S.route.initiative}/tasks`);
    }
    startLive(S.project.id);
  }
  async function refresh() {
    // Re-fetch what is on screen without touching the drawer state.
    try {
      const prevTasks = new Map(S.tasks.map((t) => [t.id, t.updated_at]));
      await loadProjects();
      if (S.route.view !== "home") {
        S.project = await api(`/api/projects/${encodeURIComponent(S.route.slug)}`);
        if (S.route.view === "initiative") S.tasks = await api(`/api/initiatives/${S.route.initiative}/tasks`);
      }
      render();
      // flash changed cards
      for (const t of S.tasks) {
        const before = prevTasks.get(t.id);
        if (before === undefined || before !== t.updated_at) {
          const el = $(`[data-task="${t.id}"]`);
          if (el) {
            el.classList.add("flash");
            setTimeout(() => el.classList.remove("flash"), 1500);
          }
        }
      }
      if (S.drawerTaskId) renderDrawer();
    } catch (e) {
      fail(e);
    }
  }

  // ---------- live (SSE with polling fallback) ----------
  function startLive(projectId) {
    if (S.esProject === projectId && (S.es || S.pollTimer)) return;
    stopLive();
    S.esProject = projectId;
    if (!("EventSource" in window)) return startPolling();
    const es = new EventSource(`/api/events?project=${projectId}&token=${encodeURIComponent(S.token)}`);
    S.es = es;
    es.addEventListener("hello", () => setLive("on"));
    es.addEventListener("change", () => refresh());
    es.addEventListener("bye", () => {}); // browser reconnects automatically
    es.onerror = () => {
      S.esErrors++;
      setLive("");
      if (S.esErrors >= 2) {
        es.close();
        S.es = null;
        startPolling();
      }
    };
  }
  function startPolling() {
    setLive("poll");
    S.pollTimer = setInterval(refresh, 5000);
  }
  function stopLive() {
    if (S.es) S.es.close();
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.es = null;
    S.pollTimer = null;
    S.esProject = null;
    S.esErrors = 0;
    setLive("");
  }
  function setLive(mode) {
    const el = $("#live");
    el.className = `live ${mode}`;
    el.title = mode === "on" ? "Live: connected" : mode === "poll" ? "Live: polling every 5s" : "Live: connecting…";
  }

  // ---------- render ----------
  function render() {
    renderProjects();
    const main = $("#main");
    if (S.route.view === "home") main.innerHTML = renderHome();
    else if (S.route.view === "project") main.innerHTML = renderProject();
    else main.innerHTML = renderInitiative();
    S.lastRender = Date.now();
  }

  function renderProjects() {
    const nav = $("#projects");
    const list = S.projects.filter((p) => S.showArchived || !p.archived);
    nav.innerHTML =
      list
        .map(
          (p) => `<a href="#/p/${encodeURIComponent(p.slug)}" class="${S.route.slug === p.slug ? "active" : ""} ${p.archived ? "archived" : ""}">
            <span class="name">${esc(p.name)}</span>
            <span class="count ${p.blocked_tasks ? "blocked" : ""}" title="${p.open_tasks} open, ${p.blocked_tasks} blocked">${p.blocked_tasks ? "⚠ " : ""}${p.open_tasks}</span>
          </a>`,
        )
        .join("") || `<p class="hint" style="padding:8px 10px">No projects yet.</p>`;
  }

  function renderHome() {
    if (S.projects.length === 0) {
      return `<div class="empty"><h2>Nothing tracked yet</h2><p>Create a project on the left, or let your agent do it:</p>
        <code>create_project { "name": "my-repo" }
create_initiative { "project": "my-repo", "name": "Ship v1" }
create_tasks { "initiative": "…", "tasks": [{ "title": "…", "type": "feature" }] }</code></div>`;
    }
    return `<div class="empty"><h2>Pick a project</h2><p>Projects hold initiatives; initiatives hold typed tasks. Agents and people edit the same board.</p></div>`;
  }

  function renderProject() {
    const p = S.project;
    const active = p.initiatives.filter((i) => i.status === "active");
    const closed = p.initiatives.filter((i) => i.status !== "active");
    const card = (i) => {
      const c = i.counts;
      const total = c.todo + c.in_progress + c.blocked + c.done + c.cancelled;
      const denom = total - c.cancelled || 1;
      const pct = (n) => `${(100 * n) / denom}%`;
      return `<article class="init-card ${i.status}" data-initiative="${i.id}">
        <a href="#/p/${encodeURIComponent(p.slug)}/i/${i.id}"><h3>${esc(i.name)}</h3></a>
        ${i.description ? `<div class="desc">${md(i.description)}</div>` : ""}
        <div class="progress" title="${c.done} of ${denom} done">
          <span class="p-done" style="width:${pct(c.done)}"></span><span class="p-in_progress" style="width:${pct(c.in_progress)}"></span><span class="p-blocked" style="width:${pct(c.blocked)}"></span>
        </div>
        <div class="pills">
          <span class="pill">${c.done}/${denom} done</span>
          ${c.in_progress ? `<span class="pill">${c.in_progress} in progress</span>` : ""}
          ${c.blocked ? `<span class="pill blocked">⚠ ${c.blocked} blocked</span>` : ""}
          ${c.todo ? `<span class="pill">${c.todo} todo</span>` : ""}
          <span class="pill">by ${esc(i.created_by)} · ${rel(i.created_at)}</span>
        </div>
        <div class="menu"><select data-init-status="${i.id}" class="btn small">
          ${["active", "done", "cancelled"].map((s) => `<option value="${s}" ${s === i.status ? "selected" : ""}>${s}</option>`).join("")}
        </select></div>
      </article>`;
    };
    return `
      <div class="crumbs"><a href="#/">Projects</a><span>/</span><span>${esc(p.name)}</span></div>
      <div class="page-head">
        <div>
          <h1 class="editable" data-edit-project="name" title="Click to rename">${esc(p.name)}</h1>
          ${descBlock(p.description, 'data-edit-project="description"', "Add a description…")}
        </div>
        <div class="head-actions">
          <span class="hint">slug <code>${esc(p.slug)}</code></span>
          <button class="btn small ghost" data-archive-project="${p.archived ? 0 : 1}">${p.archived ? "Unarchive" : "Archive"}</button>
        </div>
      </div>
      <form class="init-add" id="new-initiative">
        <input name="name" placeholder="New initiative — a goal-sized chunk of work" maxlength="200" required />
        <input name="description" placeholder="Goal / context (optional)" />
        <button class="btn primary" type="submit">Add initiative</button>
      </form>
      <div class="section-title">Active <span class="line"></span></div>
      ${active.length ? `<div class="init-grid">${active.map(card).join("")}</div>` : `<p class="hint">No active initiatives. Add one above or let the agent create it.</p>`}
      ${closed.length ? `<details style="margin-top:18px"><summary class="section-title" style="cursor:pointer">Done &amp; cancelled (${closed.length})</summary><div class="init-grid" style="margin-top:10px">${closed.map(card).join("")}</div></details>` : ""}
    `;
  }

  function renderInitiative() {
    const p = S.project;
    const i = p.initiatives.find((x) => x.id === S.route.initiative);
    if (!i) return `<div class="empty"><h2>Initiative not found</h2></div>`;
    const f = S.filter.trim().toLowerCase();
    const tasks = f ? S.tasks.filter((t) => t.title.toLowerCase().includes(f) || t.notes.toLowerCase().includes(f)) : S.tasks;
    const byStatus = (s) => tasks.filter((t) => t.status === s).sort((a, b) => a.priority - b.priority || a.position - b.position);
    const cardHtml = (t) => `<div class="card ${t.status}" draggable="true" data-task="${t.id}">
        <div class="title">${esc(t.title)}</div>
        ${t.status === "blocked" && t.blocked_reason ? `<div class="reason">⚠ ${esc(t.blocked_reason)}</div>` : ""}
        <div class="meta">${chip(t.type)} ${prio(t.priority)} ${t.assignee ? `<span class="who">${esc(t.assignee)}</span>` : ""}<span class="status-menu">${statusSelect(t.status)}</span></div>
      </div>`;
    const col = (s) => {
      const items = s === "done" && S.showCancelled ? [...byStatus("done"), ...byStatus("cancelled")] : byStatus(s);
      const cancelled = byStatus("cancelled").length;
      return `<section class="col" data-col="${s}">
        <div class="col-head"><span class="swatch" style="background:var(--st-${s})"></span>${STATUS_LABEL[s]} <span class="n">${items.length}</span>
          ${s === "done" && cancelled ? `<label class="check toggle hint"><input type="checkbox" id="show-cancelled" ${S.showCancelled ? "checked" : ""}/> +${cancelled} cancelled</label>` : ""}
        </div>
        ${s === "todo" ? `<form class="add-task" id="add-task"><input name="title" placeholder="Add a task… (n)" maxlength="500" required /><select name="type">${TYPES.map((t) => `<option value="${t}">${t}</option>`).join("")}</select></form>` : ""}
        <div class="card-list">${items.map(cardHtml).join("")}</div>
      </section>`;
    };
    return `
      <div class="crumbs"><a href="#/">Projects</a><span>/</span><a href="#/p/${encodeURIComponent(p.slug)}">${esc(p.name)}</a><span>/</span><span>${esc(i.name)}</span></div>
      <div class="page-head">
        <div>
          <h1 class="editable" data-edit-initiative="name" title="Click to rename">${esc(i.name)}</h1>
          ${descBlock(i.description, 'data-edit-initiative="description"', "Add the goal…")}
        </div>
        <div class="head-actions">
          <select data-init-status="${i.id}" class="btn small">${["active", "done", "cancelled"].map((s) => `<option value="${s}" ${s === i.status ? "selected" : ""}>${s}</option>`).join("")}</select>
        </div>
      </div>
      <div class="toolbar">
        <input id="filter" placeholder="Filter tasks… ( / )" value="${esc(S.filter)}" />
        <span class="spacer"></span>
        <span class="hint">${S.tasks.length} tasks · drag cards between columns · click a card for details</span>
      </div>
      <div class="board">${COLUMNS.map(col).join("")}</div>
    `;
  }

  // ---------- drawer ----------
  async function openDrawer(taskId) {
    S.drawerTaskId = taskId;
    $("#drawer").hidden = false;
    $("#drawer-backdrop").hidden = false;
    await renderDrawer();
  }
  function closeDrawer() {
    S.drawerTaskId = null;
    $("#drawer").hidden = true;
    $("#drawer-backdrop").hidden = true;
  }
  async function renderDrawer() {
    const id = S.drawerTaskId;
    if (!id) return;
    let t = S.tasks.find((x) => x.id === id);
    let events;
    try {
      [t, events] = await Promise.all([t ? Promise.resolve(t) : api(`/api/tasks/${id}`), api(`/api/tasks/${id}/events?limit=200`)]);
    } catch (e) {
      return fail(e);
    }
    if (S.drawerTaskId !== id) return;
    const initiatives = S.project ? S.project.initiatives : [];
    const eventLine = (e) => {
      const d = e.data || {};
      let body = "";
      if (e.kind === "note") body = md(d.text);
      else if (e.kind === "status") body = `${STATUS_LABEL[d.from] || d.from} → <b>${STATUS_LABEL[d.to] || d.to}</b>${d.reason ? `: ${esc(d.reason)}` : ""}`;
      else if (e.kind === "created") body = `created${d.type ? ` as ${chip(d.type)}` : ""}`;
      else if (e.kind === "updated") body = `changed ${(d.changed || []).join(", ")}`;
      return `<div class="log-item ${e.kind}"><div class="head"><b>${esc(e.actor)}</b><span>${e.kind}</span><span>·</span><span title="${new Date(e.created_at).toLocaleString()}">${rel(e.created_at)}</span></div><div class="body">${body}</div></div>`;
    };
    $("#drawer").innerHTML = `
      <div class="drawer-head">${chip(t.type)} ${prio(t.priority)} <span class="hint">${STATUS_LABEL[t.status]}${t.assignee ? ` · ${esc(t.assignee)}` : ""}</span><span class="spacer"></span>
        <button class="btn small ghost" data-copy-id title="Copy task id">${esc(t.id)}</button>
        <button class="btn small ghost" data-close-drawer>✕</button></div>
      <input class="title-input" data-field="title" value="${esc(t.title)}" />
      <div class="row">
        <div class="field"><label>Status</label>${statusSelect(t.status, "btn")}</div>
        <div class="field"><label>Type</label>${typeSelect(t.type)}</div>
        <div class="field"><label>Priority</label>${prioSelect(t.priority)}</div>
      </div>
      ${t.status === "blocked" ? `<div class="reason">⚠ ${esc(t.blocked_reason)}</div>` : ""}
      <div class="field"><label>Initiative</label><select data-move>${initiatives.map((i) => `<option value="${i.id}" ${i.id === t.initiative_id ? "selected" : ""}>${esc(i.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Notes</label><div class="notes-view" data-notes-view>${t.notes ? md(t.notes) : ""}</div><textarea data-notes-edit hidden>${esc(t.notes)}</textarea></div>
      <div class="field add-note"><label>Add a note</label><textarea data-note placeholder="Progress, findings, links… (⌘/Ctrl+Enter to save)"></textarea><div><button class="btn small primary" data-add-note>Add note</button></div></div>
      <div class="field"><label>History</label><div class="log">${events.map(eventLine).join("") || '<p class="hint">Nothing yet.</p>'}</div></div>
      <p class="hint">Created by ${esc(t.created_by)} ${rel(t.created_at)}${t.completed_at ? ` · completed ${rel(t.completed_at)}` : ""}</p>
    `;
  }

  // ---------- actions ----------
  async function setStatus(taskId, status) {
    const t = S.tasks.find((x) => x.id === taskId);
    if (!t || t.status === status) return;
    let reason;
    if (status === "blocked") {
      reason = prompt("Why is it blocked?", t.blocked_reason || "");
      if (!reason) return render();
    }
    try {
      await patch(`/api/tasks/${taskId}`, { status, reason });
      await refresh();
    } catch (e) {
      fail(e);
      render();
    }
  }
  async function editTask(taskId, body) {
    try {
      await patch(`/api/tasks/${taskId}`, body);
      await refresh();
    } catch (e) {
      fail(e);
    }
  }
  function inlineEdit(el, current, onSave, multiline = false) {
    const input = document.createElement(multiline ? "textarea" : "input");
    input.value = current;
    input.style.width = "100%";
    el.replaceWith(input);
    input.focus();
    let done = false;
    const save = async () => {
      if (done) return;
      done = true;
      if (input.value.trim() !== current) {
        try { await onSave(input.value.trim()); } catch (e) { fail(e); }
      }
      await refresh();
    };
    input.addEventListener("blur", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { done = true; refresh(); }
      if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    });
  }

  // ---------- events ----------
  function bind() {
    window.addEventListener("hashchange", navigate);

    $("#gate-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = $("#gate-token").value.trim();
      if (!token) return;
      S.token = token;
      $("#gate-error").hidden = true;
      try {
        await loadProjects();
        localStorage.setItem(TOKEN_KEY, token);
        $("#gate").hidden = true;
        $("#app").hidden = false;
        navigate();
      } catch {
        S.token = null;
        $("#gate-error").hidden = false;
      }
    });
    $("#sign-out").addEventListener("click", () => signOut(false));
    $("#show-archived").addEventListener("change", (e) => {
      S.showArchived = e.target.checked;
      loadProjects().then(renderProjects).catch(fail);
    });
    $("#new-project").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = $("#new-project-name").value.trim();
      if (!name) return;
      try {
        const p = await api("/api/projects", { body: { name } });
        $("#new-project-name").value = "";
        await loadProjects();
        location.hash = `#/p/${encodeURIComponent(p.slug)}`;
      } catch (err) {
        fail(err);
      }
    });

    const main = $("#main");
    main.addEventListener("submit", async (e) => {
      if (e.target.id === "new-initiative") {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          await api(`/api/projects/${S.project.id}/initiatives`, { body: { name: fd.get("name"), description: fd.get("description") } });
          await refresh();
        } catch (err) { fail(err); }
      }
      if (e.target.id === "add-task") {
        e.preventDefault();
        const fd = new FormData(e.target);
        const title = String(fd.get("title") || "").trim();
        if (!title) return;
        try {
          await api(`/api/initiatives/${S.route.initiative}/tasks`, { body: { title, type: fd.get("type") } });
          await refresh();
          const inp = $("#add-task input");
          if (inp) inp.focus();
        } catch (err) { fail(err); }
      }
    });
    main.addEventListener("change", async (e) => {
      const t = e.target;
      if (t.matches("[data-init-status]")) {
        try { await patch(`/api/initiatives/${t.dataset.initStatus}`, { status: t.value }); await refresh(); } catch (err) { fail(err); render(); }
      }
      if (t.matches("[data-status-select]")) {
        const card = t.closest("[data-task]");
        if (card) setStatus(card.dataset.task, t.value);
      }
      if (t.id === "show-cancelled") { S.showCancelled = t.checked; render(); }
    });
    main.addEventListener("input", (e) => {
      if (e.target.id === "filter") {
        S.filter = e.target.value;
        const pos = e.target.selectionStart;
        render();
        const f = $("#filter");
        f.focus();
        f.setSelectionRange(pos, pos);
      }
    });
    main.addEventListener("click", (e) => {
      const t = e.target;
      if (t.matches("[data-toggle-desc]")) {
        S.descOpen = !S.descOpen;
        render();
        return;
      }
      if (t.closest("select, input, a, form, button") && !t.matches("[data-archive-project]")) return;
      if (t.matches("[data-archive-project]")) {
        patch(`/api/projects/${S.project.id}`, { archived: t.dataset.archiveProject === "1" }).then(refresh).catch(fail);
        return;
      }
      const ep = t.closest("[data-edit-project]");
      if (ep) {
        const field = ep.dataset.editProject;
        return inlineEdit(ep, S.project[field], (v) => patch(`/api/projects/${S.project.id}`, { [field]: v }), field === "description");
      }
      const ei = t.closest("[data-edit-initiative]");
      if (ei) {
        const field = ei.dataset.editInitiative;
        const i = S.project.initiatives.find((x) => x.id === S.route.initiative);
        return inlineEdit(ei, i[field], (v) => patch(`/api/initiatives/${i.id}`, { [field]: v }), field === "description");
      }
      const card = t.closest("[data-task]");
      if (card) openDrawer(card.dataset.task);
    });

    // drag & drop
    main.addEventListener("dragstart", (e) => {
      const card = e.target.closest?.("[data-task]");
      if (!card) return;
      e.dataTransfer.setData("text/plain", card.dataset.task);
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });
    main.addEventListener("dragend", (e) => e.target.closest?.("[data-task]")?.classList.remove("dragging"));
    main.addEventListener("dragover", (e) => {
      const col = e.target.closest?.("[data-col]");
      if (!col) return;
      e.preventDefault();
      $$(".col.over").forEach((c) => c !== col && c.classList.remove("over"));
      col.classList.add("over");
    });
    main.addEventListener("dragleave", (e) => {
      const col = e.target.closest?.("[data-col]");
      if (col && !col.contains(e.relatedTarget)) col.classList.remove("over");
    });
    main.addEventListener("drop", (e) => {
      const col = e.target.closest?.("[data-col]");
      if (!col) return;
      e.preventDefault();
      col.classList.remove("over");
      setStatus(e.dataTransfer.getData("text/plain"), col.dataset.col);
    });

    // drawer
    $("#drawer-backdrop").addEventListener("click", closeDrawer);
    const drawer = $("#drawer");
    drawer.addEventListener("click", async (e) => {
      const t = e.target;
      const id = S.drawerTaskId;
      if (t.matches("[data-close-drawer]")) return closeDrawer();
      if (t.matches("[data-copy-id]")) { navigator.clipboard?.writeText(id); return toast("Task id copied"); }
      if (t.matches("[data-notes-view]")) {
        t.hidden = true;
        const ta = $("[data-notes-edit]", drawer);
        ta.hidden = false;
        ta.focus();
        return;
      }
      if (t.matches("[data-add-note]")) {
        const ta = $("[data-note]", drawer);
        const text = ta.value.trim();
        if (!text) return;
        ta.value = "";
        return editTask(id, { note: text });
      }
    });
    drawer.addEventListener("change", (e) => {
      const t = e.target;
      const id = S.drawerTaskId;
      if (t.matches("[data-status-select]")) return setStatus(id, t.value);
      if (t.matches("[data-type-select]")) return editTask(id, { type: t.value });
      if (t.matches("[data-prio-select]")) return editTask(id, { priority: Number(t.value) });
      if (t.matches("[data-move]")) return editTask(id, { initiative: t.value });
      if (t.matches("[data-field='title']")) return editTask(id, { title: t.value });
    });
    drawer.addEventListener("focusout", (e) => {
      if (e.target.matches("[data-notes-edit]")) {
        const cur = S.tasks.find((x) => x.id === S.drawerTaskId);
        if (cur && e.target.value.trim() !== cur.notes) editTask(S.drawerTaskId, { notes: e.target.value });
        else renderDrawer();
      }
    });
    drawer.addEventListener("keydown", (e) => {
      if (e.target.matches("[data-note]") && e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("[data-add-note]", drawer).click();
      if (e.target.matches("[data-field='title']") && e.key === "Enter") e.target.blur();
    });

    // keyboard
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, textarea, select")) {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      if (e.key === "Escape") closeDrawer();
      if (e.key === "n") { const i = $("#add-task input"); if (i) { e.preventDefault(); i.focus(); } }
      if (e.key === "/") { const f = $("#filter"); if (f) { e.preventDefault(); f.focus(); } }
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && S.project) refresh(); });
  }

  async function loadProjects() {
    S.projects = await api(`/api/projects${S.showArchived ? "?archived=1" : ""}`);
  }
  function signOut(rejected) {
    localStorage.removeItem(TOKEN_KEY);
    S.token = null;
    stopLive();
    $("#app").hidden = true;
    $("#gate").hidden = false;
    $("#gate-error").hidden = !rejected;
    $("#gate-token").value = "";
    $("#gate-token").focus();
  }

  // ---------- boot ----------
  async function boot() {
    bind();
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) {
      S.token = saved;
      try {
        await loadProjects();
        $("#app").hidden = false;
        return navigate();
      } catch {
        S.token = null;
      }
    }
    $("#gate").hidden = false;
    $("#gate-token").focus();
  }
  boot();
})();
