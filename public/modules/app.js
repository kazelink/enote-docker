import { Utils, State } from "./dom.js";
import { API, authHeaders } from "./api.js";
import { UI } from "./ui.js";
import { swalConfirm, swalAlert, swalPrompt } from "./swal.js";
import { Editor } from "./editor.js?v=5.3";
import { Auth } from "./auth.js";

const MAX_RESTORE_FILE_BYTES = 100 * 1024 * 1024;
const STATUS_RESET_DELAY_MS = 2e3;
const TAG_PREVIEW_LIMIT = 5;
const ENTITY_ESCAPE_RE = /[&<>"']/g;
const ENTITY_ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function nextFrame() { return new Promise(r => requestAnimationFrame(r)); }
function escapeHtml(val) { return String(val ?? "").replace(ENTITY_ESCAPE_RE, c => ENTITY_ESCAPE_MAP[c] || c); }
function encodeInlineParam(val) { return encodeURIComponent(String(val ?? "")).replace(/'/g, "%27"); }
function ensureLazyMedia(content) { return String(content || "").replace(/<img (?![^>]*\bloading=["']?lazy)/gi, '<img loading="lazy" '); }

function renderNotesHomeState() {
  return `
    <div class="notes-home-state" aria-label="Open notes from folders">
      <div class="notes-home-icon" aria-hidden="true">
        <svg class="notes-home-glyph" viewBox="0 0 24 24">
          <path d="M4.75 6.25h4.2c.37 0 .73.13 1.01.37l1.16.98c.14.11.31.18.49.18h6.64A1.75 1.75 0 0 1 20 9.53v7.22A1.75 1.75 0 0 1 18.25 18.5H5.75A1.75 1.75 0 0 1 4 16.75V8a1.75 1.75 0 0 1 1.75-1.75Z"></path>
          <path d="M8 11.25h8"></path><path d="M8 14.25h5"></path><path d="M6.75 10.75v3"></path>
        </svg>
      </div>
      <p>Open a folder to browse notes.</p>
    </div>`;
}

function getRestoreInput() { return Utils.$("restore-input"); }
function clearRestoreInput() { const i = getRestoreInput(); if (i) i.value = ""; }
function showRestoreMessage(kind, text) {
  const box = Utils.$("restore-msg");
  if (!box) return;
  box.innerHTML = "";
  if (text) {
    const el = document.createElement("div");
    el.className = kind === "error" ? "auth-err" : "auth-ok";
    el.textContent = text;
    box.appendChild(el);
  }
}

function getDownloadFilename(disposition) {
  const utf = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf?.[1]) { try { return decodeURIComponent(utf[1]); } catch { } }
  return disposition.match(/filename="([^"]+)"/i)?.[1] || `note-backup-${new Date().toISOString().slice(0, 10)}.json`;
}

async function saveResponseToFile(res, filename) {
  if (typeof window.showSaveFilePicker === "function" && res.body) {
    const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: "JSON Backup", accept: { "application/json": [".json"] } }] });
    await res.body.pipeTo(await handle.createWritable());
    return;
  }
  const blobUrl = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = blobUrl; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
}

function applyActiveView(views, activeView) {
  Object.entries(views).forEach(([name, el]) => el?.classList.toggle("active", name === activeView));
}

function normalizeState() {
  if (State.view === "backup") {
    Object.assign(State, { category: "", subcategory: "", note: "", q: "", tag: "", page: 1 });
    return;
  }
  ['category', 'subcategory', 'note', 'q', 'tag'].forEach(k => State[k] = String(State[k] || "").trim());
  State.page = Number.isFinite(State.page) && State.page > 0 ? State.page : 1;

  if (!State.category) {
    State.subcategory = "";
    State.view = State.note ? "note" : (State.view === "list" || State.q || State.tag ? "list" : "index");
    if (State.view === "index") State.q = State.tag = "";
  } else if (!State.subcategory) {
    State.view = State.note ? "note" : "category";
  } else {
    State.view = State.note ? "note" : "list";
  }
}

function syncStateFromLocation() {
  const p = new URLSearchParams(location.search);
  ['category', 'subcategory', 'note', 'q', 'tag'].forEach(k => State[k] = p.get(k) || "");
  State.page = parseInt(p.get("page") || "1", 10);
  State.view = ["index", "category", "list", "note", "backup"].includes(p.get("view")) ? p.get("view") : "index";
  normalizeState();
}

function buildLocationSearch() {
  const p = new URLSearchParams();
  if (State.view !== "index") p.set("view", State.view);
  ['category', 'subcategory', 'note', 'q', 'tag'].forEach(k => State[k] && p.set(k, State[k]));
  if (State.page > 1) p.set("page", String(State.page));
  const query = p.toString();
  return query ? `?${query}` : location.pathname;
}

function resetStatusLater(statusKind) {
  setTimeout(() => { if (statusKind !== "err" || !App._restoreInFlight) UI.setStatus(""); }, STATUS_RESET_DELAY_MS);
}

const COLLAPSE_STORAGE_KEY = "enote_collapsed_categories";

const App = {
  _views: {}, _popstateHandler: null, _restoreInFlight: false, _searchPanelOpen: false, _folderTreeCache: null, _tagCloudCache: null, _tagCloudExpanded: false, _collapsedCategories: new Set(), _collapsedStateLoaded: false, _folderPanelCollapsed: false, _currentNote: null, _notePathHint: null, _treeContextState: { scope: "root", category: "" },

  _resetListContent() {
    ["home-entry-list", "category-entry-list", "entry-list"].forEach(id => {
      const el = Utils.$(id);
      if (el) {
        el.innerHTML = id === "home-entry-list" ? renderNotesHomeState() : '<div class="loading-hint">Loading...</div>';
        const pg = el.closest(".view-container")?.querySelector("[data-pagination]");
        if (pg) pg.style.display = "none";
      }
    });
  },
  _loadCollapsedState() {
    try {
      const arr = JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY));
      if (Array.isArray(arr)) { this._collapsedCategories = new Set(arr); this._collapsedStateLoaded = true; }
    } catch { }
  },
  _saveCollapsedState() {
    try { localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...this._collapsedCategories])); } catch { }
  },

  async init() {
    Auth.init(); Editor.init();
    Editor.bindSuggestion(Utils.$("backup-category"), "category");
    this._loadCollapsedState();['index', 'category', 'list', 'note', 'backup'].forEach(v => this._views[v] = Utils.$(`v-${v}`));
    window.App = this;
    this._setupHtmxListeners();
    this._setupTreeContextMenu();
    UI.initGlobalEvents();

    const footerYear = Utils.$("footer-year");
    if (footerYear) footerYear.textContent = new Date().getFullYear();

    if (sessionStorage.getItem("session_nonce") && await API.checkAuth().catch(() => false)) {
      await this.loadView();
    } else {
      sessionStorage.removeItem("session_nonce");
      UI.showAuth();
    }
    document.body.classList.add("ready");
    if (!this._popstateHandler) window.addEventListener("popstate", (this._popstateHandler = () => this.loadView()));
  },

  async route(nextState, options = {}) {
    if (!await Editor.close()) return;
    this.closeTreeContextMenu();
    Object.assign(State, nextState);
    normalizeState();
    history.pushState(null, "", buildLocationSearch());
    this.loadView(options);
  },

  async loadView(options = {}) {
    if (!options.quiet) this._resetListContent();
    syncStateFromLocation();
    if (State.view !== "note") this._currentNote = this._notePathHint = null;

    applyActiveView(this._views, State.view);
    UI.renderBreadcrumb();

    const backBtn = Utils.$("btn-header-back");
    if (backBtn) { backBtn.classList.toggle("visible", State.view !== "index"); backBtn.disabled = State.view === "index"; }

    const input = Utils.$("note-search");
    if (input) input.value = State.q || "";
    const resetSearch = Utils.$("search-reset");
    if (resetSearch) resetSearch.style.display = State.q || State.tag ? "inline-flex" : "none";

    Utils.$("btn-search-toggle")?.classList.toggle("active", this._searchPanelOpen || !!State.q);
    Utils.$("global-note-tools")?.classList.toggle("active", State.view !== "backup" && (this._searchPanelOpen || !!State.q));

    if (State.view === "backup") {
      try {
        await this._loadFolderTree();
      } catch (e) {
        console.error("Folder tree load failed:", e);
      }
      return;
    }
    if (!options.quiet) UI.setStatus("loading");

    try {
      await Promise.all([
        this._loadFolderTree(),
        this._loadTagCloud().catch(e => { console.error(e); const t = Utils.$("tag-cloud"); if (t) t.innerHTML = '<div class="tag-cloud-empty">Tags unavailable.</div>'; })
      ]);

      if (State.view === "index") {
        const el = Utils.$("home-entry-list");
        if (el) el.innerHTML = renderNotesHomeState();
      } else if (State.view === "category" || State.view === "list") {
        await this._loadNoteCollection({
          listId: State.view === "category" ? "category-entry-list" : "entry-list",
          params: { category: State.category, subcategory: State.view === "category" ? "" : State.subcategory, q: State.q, tag: State.tag, page: State.page },
          options
        });
      } else if (State.view === "note") {
        await this._loadNote();
      }
      UI.setStatus("");
    } catch (e) {
      console.error("View load failed:", e);
      UI.setStatus("err");
    }
  },

  async _loadNoteCollection({ listId, params = {}, options = {} }) {
    const el = Utils.$(listId);
    if (!el) return;
    const viewEl = el.closest(".view-container");
    const pg = viewEl?.querySelector("[data-pagination]");
    if (!options.quiet || !el.children.length) {
      el.innerHTML = '<div class="loading-hint">Loading...</div>';
      if (pg) pg.style.display = "none";
    }
    el.innerHTML = await API.html("list", params);
    State.data.totalPg = parseInt(viewEl?.querySelector(".pg-data")?.dataset.total, 10) || 1;
  },

  async _loadFolderTree(force = false) {
    const target = Utils.$("folder-tree");
    if (!target) return;
    if (!force && this._folderTreeCache) return (this._renderFolderTree(), this._updateDatalists());
    if (!target.querySelector('.tree-group')) target.innerHTML = '<div class="loading-hint">Loading...</div>';

    const tree = await API.req("folders/tree");
    this._folderTreeCache = Array.isArray(tree) ? tree : [];
    this._renderFolderTree();
    this._updateDatalists();
  },

  async _loadTagCloud(force = false) {
    const target = Utils.$("tag-cloud");
    if (!target) return;
    if (!force && this._tagCloudCache) return this._renderTagCloud();
    if (!target.querySelector('.tag-cloud-list')) target.innerHTML = '<div class="tag-cloud-empty">Loading...</div>';

    const tags = await API.req("tags");
    this._tagCloudCache = Array.isArray(tags) ? tags : [];
    this._renderTagCloud();
  },

  _renderTagCloud() {
    const target = Utils.$("tag-cloud");
    if (!target) return;
    const rows = this._tagCloudCache || [];
    if (!rows.length) return target.innerHTML = '<div class="tag-cloud-empty"><em>No tags yet.</em></div>';

    const activeTag = String(State.tag || "").trim();
    const hasOverflow = rows.length > TAG_PREVIEW_LIMIT;
    let visibleRows = rows;

    if (!this._tagCloudExpanded && hasOverflow) {
      visibleRows = rows.slice(0, TAG_PREVIEW_LIMIT);
      if (activeTag && !visibleRows.some(r => String(r?.tag || "").trim() === activeTag)) {
        const activeRow = rows.find(r => String(r?.tag || "").trim() === activeTag);
        if (activeRow) visibleRows = [...rows.slice(0, TAG_PREVIEW_LIMIT - 1), activeRow];
      }
    }

    const chipsHtml = visibleRows.map(r => {
      const tag = String(r?.tag || "").trim();
      return tag ? `<button class="tag-cloud-chip${activeTag === tag ? " active" : ""}" type="button" onclick="App.openSidebarTagByEncoded('${encodeInlineParam(tag)}')">#${escapeHtml(tag)}</button>` : "";
    }).join("");

    const footerMarkup = hasOverflow ? `<div class="tag-cloud-footer"><button class="tag-cloud-more${this._tagCloudExpanded ? " is-expanded" : ""}" type="button" aria-label="${this._tagCloudExpanded ? "Show fewer tags" : "Show more tags"}" onclick="App.toggleTagCloudExpanded()"><i class="ri-arrow-right-s-line"></i></button></div>` : "";
    target.innerHTML = `<div class="tag-cloud-list">${chipsHtml}</div>${footerMarkup}`;
    target.querySelector(".tag-cloud-more")?.removeAttribute("title");
  },

  _invalidateSidebarCaches() { this._folderTreeCache = this._tagCloudCache = null; this._tagCloudExpanded = false; },
  toggleTagCloudExpanded() { if ((this._tagCloudCache || []).length > TAG_PREVIEW_LIMIT) { this._tagCloudExpanded = !this._tagCloudExpanded; this._renderTagCloud(); } },

  _syncFolderPanelControls() {
    Utils.$("folder-tree-shell")?.classList.toggle("collapsed", this._folderPanelCollapsed);
    const folderToggle = Utils.$("btn-folder-dom-toggle");
    if (folderToggle) {
      folderToggle.setAttribute("aria-label", this._folderPanelCollapsed ? "Show folder panel content" : "Hide folder panel content");
      folderToggle.dataset.state = this._folderPanelCollapsed ? "collapsed" : "expanded";
    }
    const categories = (this._folderTreeCache || []).map(r => String(r?.category || "").trim()).filter(Boolean);
    const treeToggle = Utils.$("btn-tree-toggle");
    if (treeToggle) {
      const allCollapsed = categories.length > 0 && categories.every(c => this._collapsedCategories.has(c));
      treeToggle.setAttribute("aria-label", allCollapsed ? "Expand all folders" : "Collapse all folders");
      treeToggle.dataset.state = allCollapsed ? "collapsed" : "expanded";
      treeToggle.disabled = categories.length === 0;
    } ["folder-dom-toggle-label", "tree-toggle-label"].forEach(id => { const el = Utils.$(id); if (el) el.textContent = ""; });
  },

  _renderFolderTree() {
    const target = Utils.$("folder-tree");
    if (!target) return;
    const tree = this._folderTreeCache || [];
    const aCat = State.view === "note" && !State.category ? String(this._currentNote?.category || "") : State.category;
    const aSub = State.view === "note" && !State.subcategory ? String(this._currentNote?.subcategory || "") : State.subcategory;

    if (!tree.length) {
      target.innerHTML = '<div class="loading-hint">No folders yet. Save a note to create one.</div>';
      return this._syncFolderPanelControls();
    }

    if (!this._collapsedStateLoaded) {
      tree.forEach(r => { if (r?.category) this._collapsedCategories.add(String(r.category).trim()); });
      this._collapsedStateLoaded = true; this._saveCollapsedState();
    }

    target.innerHTML = tree.map(r => {
      const cat = String(r?.category || ""), encCat = encodeInlineParam(cat), subs = Array.isArray(r?.subfolders) ? r.subfolders : [];
      const isOpen = !this._collapsedCategories.has(cat);
      const isActCat = cat === aCat && !aSub, isActSub = cat === aCat && !!aSub;

      return `
        <div class="tree-group ${isOpen ? "open" : ""}">
          <div class="tree-node tree-category ${isActSub ? "active-parent" : isActCat ? "active" : ""}" onclick="App.openCategoryByEncoded('${encCat}')" oncontextmenu="return App.openTreeContextMenu(event, 'category', '${encCat}')">
            <button class="tree-toggle" type="button" onclick="event.stopPropagation(); App.toggleCategoryFoldByEncoded('${encCat}')"><svg class="ri-icon" viewBox="0 0 24 24"><path d="M10 6l6 6-6 6"></path></svg></button>
            <span class="tree-label">${escapeHtml(cat || "Imported")}</span><span class="tree-count">${Number(r?.count || 0)}</span>
            <span class="tree-delete-slot"><button class="tree-delete-btn" type="button" onclick="event.stopPropagation(); App.deleteCategoryByEncoded('${encCat}')"><i class="ri-close-line"></i></button></span>
          </div>
          <div class="tree-children">
            ${subs.length ? subs.map(s => {
        const sub = String(s?.subcategory || "General"), encSub = encodeInlineParam(sub);
        return `
                <div class="tree-node tree-subcategory ${cat === aCat && sub === aSub ? "active" : ""}" onclick="App.openSubcategoryByEncoded('${encCat}', '${encSub}')" oncontextmenu="return App.openTreeContextMenu(event, 'subcategory', '${encCat}', '${encSub}')">
                  <span class="tree-leaf"></span><span class="tree-label">${escapeHtml(sub)}</span><span class="tree-count">${Number(s?.count || 0)}</span>
                  <span class="tree-delete-slot"><button class="tree-delete-btn" type="button" onclick="event.stopPropagation(); App.deleteSubcategoryByEncoded('${encCat}', '${encSub}')"><i class="ri-close-line"></i></button></span>
                </div>`;
      }).join("") : '<div class="tree-empty">No subfolders yet.</div>'}
          </div>
        </div>`;
    }).join("");
    this._syncFolderPanelControls();
  },

  primeSavedNote(note) {
    if (!note?.id) return null;
    this._currentNote = { ...note, id: String(note.id || ""), title: String(note.title || ""), category: String(note.category || ""), subcategory: String(note.subcategory || ""), content: typeof note.content === "string" ? note.content : "", tags: Array.isArray(note.tags) ? note.tags.map(t => String(t || "").trim()).filter(Boolean) : [] };
    this._notePathHint = { category: this._currentNote.category, subcategory: this._currentNote.subcategory };
    return this._currentNote;
  },

  async _loadNote() {
    const el = Utils.$("note-detail");
    if (!el) return;
    const id = String(State.note || "").trim();
    if (this._currentNote?.id === id) {
      UI.renderBreadcrumb(); el.innerHTML = this._renderNoteDetail(this._currentNote); this._renderFolderTree();
    } else el.innerHTML = '<div class="loading-hint">Loading...</div>';

    const note = await API.req("list", { id });
    if (String(State.note || "").trim() !== id) return;

    if (!note?.id) { el.innerHTML = '<div class="loading-hint">Note not found.</div>'; this._currentNote = null; return; }
    this.primeSavedNote(note);
    UI.renderBreadcrumb(); el.innerHTML = this._renderNoteDetail(note); this._renderFolderTree();
  },

  _renderNoteDetail(note) {
    const sId = escapeHtml(note.id), tags = Array.isArray(note.tags) ? note.tags : [];
    return `
      <article class="note-detail-shell" tabindex="0">
        <div class="note-detail-header"><div class="note-title-block">
          <div class="note-title note-detail-title">${escapeHtml(note.title || "Untitled Note")}</div>
          <div class="note-detail-meta">
            <div class="note-date-muted">${escapeHtml(String(note.updatedAt || "").slice(0, 10))}</div>
            <div class="item-actions">
              <span class="btn-icon-s edit" onclick="App.editEntry(this, '${sId}')"><i class="ri-edit-line"></i></span>
              <span class="btn-del" onclick="App.deleteEntry('${sId}')"><i class="ri-delete-bin-line"></i></span>
            </div>
          </div>
        </div></div>
        <div class="dc-text note-detail-body">${ensureLazyMedia(note.content)}</div>
        ${tags.length ? `<div class="note-detail-footer"><div class="note-detail-tags">${tags.map(t => `<button class="note-detail-tag" type="button" onclick="App.toggleTagByEncoded('${encodeInlineParam(t)}')">#${escapeHtml(t)}</button>`).join("")}</div></div>` : ""}
      </article>`;
  },

  _setupTreeContextMenu() {
    const tree = Utils.$("folder-tree");
    if (tree) tree.addEventListener("contextmenu", e => { if (!e.target.closest(".tree-node")) this.openTreeContextMenu(e, "root", ""); });
    document.addEventListener("click", () => this.closeTreeContextMenu());
    document.addEventListener("contextmenu", e => { if (!e.target.closest("#folder-tree") && !e.target.closest("#tree-context-menu")) this.closeTreeContextMenu(); });
    window.addEventListener("scroll", () => this.closeTreeContextMenu(), { passive: true });
    window.addEventListener("resize", () => this.closeTreeContextMenu());
  },

  openTreeContextMenu(event, scope = "root", encodedCategory = "", encodedSubcategory = "") {
    event.preventDefault(); event.stopPropagation();
    const menu = Utils.$("tree-context-menu"), subBtn = Utils.$("tree-context-subfolder"), renBtn = Utils.$("tree-context-rename");
    if (!menu || !subBtn) return false;

    const category = decodeURIComponent(encodedCategory || ""), subcategory = decodeURIComponent(encodedSubcategory || "");
    this._treeContextState = { scope, category, subcategory };

    if (scope === "root") {
      subBtn.style.display = "none"; if (renBtn) renBtn.style.display = "none";
    } else {
      subBtn.style.display = scope === "category" ? "flex" : "none";
      subBtn.textContent = `NEW SUBFOLDER IN ${category || "CATEGORY"}`;
      if (renBtn) { renBtn.style.display = "flex"; renBtn.textContent = `RENAME ${scope === "category" ? category : subcategory}`; }
    }
    menu.style.display = "flex";
    requestAnimationFrame(() => {
      menu.style.left = `${Math.min(event.clientX, Math.max(8, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.min(event.clientY, Math.max(8, window.innerHeight - menu.offsetHeight - 8))}px`;
    });
    return false;
  },
  closeTreeContextMenu() { const m = Utils.$("tree-context-menu"); if (m) m.style.display = "none"; },

  openCategoryByEncoded(e) { this.route({ view: "category", category: decodeURIComponent(e || ""), subcategory: "", note: "", q: "", tag: "", page: 1 }); },
  openSubcategoryByEncoded(eC, eS) { this.route({ view: "list", category: decodeURIComponent(eC || ""), subcategory: decodeURIComponent(eS || ""), note: "", q: "", tag: "", page: 1 }); },

  toggleCategoryFoldByEncoded(e) {
    const c = decodeURIComponent(e || "");
    if (!c) return;
    if (this._collapsedCategories.has(c)) this._collapsedCategories.delete(c); else this._collapsedCategories.add(c);
    this._saveCollapsedState(); this._renderFolderTree();
  },
  toggleAllFolders() {
    const cats = (this._folderTreeCache || []).map(r => String(r?.category || "").trim()).filter(Boolean);
    if (!cats.length) return this._syncFolderPanelControls();
    if (cats.every(c => this._collapsedCategories.has(c))) this._collapsedCategories.clear(); else cats.forEach(c => this._collapsedCategories.add(c));
    this._saveCollapsedState(); this._renderFolderTree();
  },
  toggleFolderPanel() { this._folderPanelCollapsed = !this._folderPanelCollapsed; this._syncFolderPanelControls(); },
  openNoteById(id, eC = "", eS = "") {
    if (String(id || "").trim()) { this._notePathHint = { category: decodeURIComponent(eC), subcategory: decodeURIComponent(eS) }; this.route({ view: "note", note: String(id).trim() }); }
  },

  async _handleFolderAction(method, params, promptTitle, promptMsg, promptLabel, routeCallback, oldName = "") {
    this.closeTreeContextMenu();
    const newName = await swalPrompt(promptTitle, promptMsg, promptLabel, oldName, oldName ? "Rename" : "OK");
    if (!newName || newName === oldName) return;

    UI.setStatus("loading");
    try {
      const res = await API.req("folders", { ...params, [method === "PUT" ? "newName" : (params.subcategory !== undefined ? "subcategory" : "category")]: newName }, method);
      this._folderTreeCache = null;
      const nextRoute = routeCallback ? routeCallback(res, newName) : null;
      if (nextRoute) this.route(nextRoute); else await this.loadView();
      UI.setStatus("ok"); resetStatusLater("ok");
    } catch (e) {
      UI.setStatus("err"); resetStatusLater("err");
      swalAlert(`${oldName ? 'Rename' : 'Create'} Failed`, e?.message || "Operation failed.", "error");
    }
  },
  async createCategory() { this._handleFolderAction("POST", { category: "" }, "New Category", "Create a top-level folder for your notes.", "Major category", (res) => ({ view: "category", category: res.category, subcategory: "", note: "", q: "", tag: "", page: 1 })); },
  async createSubcategory(override = "") {
    const cat = String(override || State.category || "").trim();
    if (cat) this._handleFolderAction("POST", { category: cat, subcategory: "" }, "New Subfolder", `Create a subfolder inside "${cat}".`, "Minor category", (res) => ({ view: "list", category: res.category, subcategory: res.subcategory, note: "", q: "", tag: "", page: 1 }));
  },
  createCategoryFromContextMenu() { this.createCategory(); },
  createSubcategoryFromContextMenu() { const c = String(this._treeContextState?.category || "").trim(); if (c) this.createSubcategory(c); },
  async renameFromContextMenu() {
    const { scope, category, subcategory } = this._treeContextState;
    if (!category) return;
    const isCat = scope === "category", oldName = isCat ? category : subcategory;
    this._handleFolderAction("PUT", { oldCategory: category, oldSubcategory: isCat ? "" : subcategory }, "Rename", `Enter a new name for "${oldName}"`, "", (res, newName) => {
      if (State.category === category && (isCat || State.subcategory === subcategory)) {
        return { category: isCat ? newName : category, subcategory: !isCat ? newName : State.subcategory, page: 1 };
      }
      return null;
    }, oldName);
  },

  async _deleteFolder(params, name, isCategory, successRoute) {
    if (!await swalConfirm(`Delete ${isCategory ? 'Category' : 'Subfolder'}?`, `This will delete "${name}" and all notes inside it.`)) return;
    UI.setStatus("loading");
    try {
      await API.req("folders", params, "DELETE");
      this._invalidateSidebarCaches();
      if (successRoute) this.route(successRoute); else await this.loadView();
      UI.setStatus("ok"); resetStatusLater("ok");
    } catch (e) {
      UI.setStatus("err"); resetStatusLater("err");
      swalAlert("Delete Failed", e?.message || "Unable to delete folder.", "error");
    }
  },
  deleteCategoryByEncoded(e) { const c = decodeURIComponent(e || ""); if (c) this._deleteFolder({ category: c }, c, true, State.category === c ? { view: "index", category: "", subcategory: "", note: "", q: "", tag: "", page: 1 } : null); },
  deleteSubcategoryByEncoded(eC, eS) { const c = decodeURIComponent(eC || ""), s = decodeURIComponent(eS || ""); if (c && s) this._deleteFolder({ category: c, subcategory: s }, s, false, State.category === c && State.subcategory === s ? { view: "category", category: c, subcategory: "", note: "", q: "", tag: "", page: 1 } : null); },

  toggleTagByEncoded(e) {
    const tag = decodeURIComponent(e || ""); this._searchPanelOpen = false;
    this.route({ note: "", tag: State.tag === tag ? "" : tag, page: 1 });
  },
  openSidebarTagByEncoded(e) {
    const t = decodeURIComponent(e || ""), n = State.tag === t ? "" : t; this._searchPanelOpen = false;
    this.route({ category: "", subcategory: "", note: "", q: "", tag: n, page: 1 });
  },
  applySearch() {
    const q = String(Utils.$("note-search")?.value || "").trim();
    if (!q) return this.clearSearch();
    this._searchPanelOpen = true; this.route({ category: "", subcategory: "", note: "", q, tag: "", page: 1 });
  },
  toggleSearchBox() {
    if (State.view === "backup") return;
    const input = Utils.$("note-search");
    if ((State.q || State.tag) && !String(input?.value || "").trim()) return this.clearSearch();
    this._searchPanelOpen = (State.q || State.tag) ? true : !this._searchPanelOpen;
    Utils.$("btn-search-toggle")?.classList.toggle("active", this._searchPanelOpen || !!State.q);
    Utils.$("global-note-tools")?.classList.toggle("active", this._searchPanelOpen || !!State.q);
    if (this._searchPanelOpen || State.q || State.tag) requestAnimationFrame(() => input?.focus({ preventScroll: true }));
  },
  clearSearch() {
    const i = Utils.$("note-search"); if (i) i.value = "";
    this._searchPanelOpen = false;
    this.route({ note: "", q: "", tag: "", page: 1 });
  },
  handleSearchKeydown(e) { if (e.key === "Enter") { e.preventDefault(); this.applySearch(); } },
  toggleJump(show) {
    const scopeEl = Object.values(this._views).find(v => v?.classList.contains("active"));
    const txt = scopeEl?.querySelector(".pg-status-txt"), inp = scopeEl?.querySelector(".pg-inp");
    if (!txt || !inp) return;
    if (show) { txt.style.display = "none"; inp.style.display = "inline-block"; inp.value = State.page; requestAnimationFrame(() => inp.focus({ preventScroll: true })); }
    else {
      txt.style.display = "inline"; inp.style.display = "none";
      const next = parseInt(inp.value, 10);
      if (next && next !== State.page && next <= State.data.totalPg) this.route({ page: next });
    }
  },

  async newEntry() { if (await Editor.close()) await Editor.open("new", { title: "", category: State.category || "", subcategory: State.subcategory || "", tags: [], content: "", createdAt: "", updatedAt: "" }); },
  async editEntry(btn, id) {
    if (!await Editor.close()) return;
    const row = btn?.closest(".note-detail-shell, .archive-row, .d-item") || (State.view === "note" ? Utils.$("note-detail")?.querySelector(".note-detail-shell") : null);
    await Editor.open("edit", this._currentNote?.id === id ? this._currentNote : await API.req("list", { id }), row);
  },
  async deleteEntry(id) {
    if (!await swalConfirm("Delete Note?", "This note and its unused local media will be removed.")) return;
    UI.setStatus("loading");
    const d = Utils.$("note-detail"); if (d) d.innerHTML = '<div class="loading-hint">Loading...</div>';
    document.querySelectorAll(`.archive-row[data-id="${CSS.escape(id)}"]`).forEach(el => el.remove());
    try {
      await API.req("delete", { id }, "DELETE");
      this._invalidateSidebarCaches();
      if (State.view === "note" && State.note === id) {
        this.route({ note: "" }, { quiet: true });
      } else await this.loadView({ quiet: true });
      UI.setStatus("ok"); resetStatusLater("ok");
    } catch (e) { UI.setStatus("err"); resetStatusLater("err"); }
  },

  changePage(dir) { const n = State.page + dir; if (n >= 1 && n <= State.data.totalPg) this.route({ page: n }); },
  async goBack() {
    if (State.view === "note") this.route({ note: "" });
    else if (State.view === "list" && State.category && State.subcategory) this.route({ subcategory: "", page: 1 });
    else this.route({ view: "index", category: "", subcategory: "", note: "", q: "", tag: "", page: 1 });
  },
  closeEditor: () => Editor.close(),
  pickRestoreFile() { const i = getRestoreInput(); if (i) { try { if (typeof i.showPicker === "function") i.showPicker(); else i.click(); } catch { i.click(); } } },

  async restoreBackup(file) {
    if (!file || this._restoreInFlight) return;
    this._restoreInFlight = true; UI.setStatus("loading"); showRestoreMessage("info", "Uploading backup...");
    try {
      if (file.size > MAX_RESTORE_FILE_BYTES) throw new Error("Backup file too large (max 100MB).");
      await nextFrame();
      const res = await fetch("/api/backup/restore", { method: "POST", headers: authHeaders({ "Content-Type": "application/json", "X-Backup-Upload": "file", "X-Backup-Size": String(file.size) }), body: file, credentials: "include", cache: "no-store" });
      if (res.status === 401) { sessionStorage.removeItem("session_nonce"); UI.showAuth(); throw new Error("Unauthorized"); }
      showRestoreMessage("info", "Restoring backup...");
      const payload = (res.headers.get("content-type") || "").toLowerCase().includes("application/json") ? await res.json().catch(() => null) : { error: await res.text().catch(() => "") };
      if (!res.ok) throw new Error(payload?.error || "Restore failed.");

      const count = Number(payload?.count ?? 0), skipped = Number(payload?.skipped ?? 0);
      showRestoreMessage("success", `Restore successful. Processed ${count} notes, skipped ${skipped} invalid notes.`);
      UI.setStatus("ok"); resetStatusLater("ok"); this._invalidateSidebarCaches(); await this.loadView();
      swalAlert("Restore Complete", `Notes processed: ${count}\nInvalid skipped: ${skipped}`, "success");
    } catch (e) {
      showRestoreMessage("error", `Restore Failed: ${e?.message || "Restore failed."}`); UI.setStatus("err"); resetStatusLater("err");
    } finally { clearRestoreInput(); this._restoreInFlight = false; }
  },
  async downloadBackup() {
    UI.setStatus("loading");
    try {
      const cat = Utils.$("backup-category")?.value?.trim() === '(All Categories)' ? '' : Utils.$("backup-category")?.value?.trim() || "";
      const res = await fetch(`/api/backup/export${cat ? `?category=${encodeURIComponent(cat)}` : ""}`, { headers: authHeaders() });
      if (res.status === 401) { sessionStorage.removeItem("session_nonce"); UI.showAuth(); throw new Error("Unauthorized"); }
      if (!res.ok) throw new Error((await res.json().catch(() => { })).error || "Download failed");
      await saveResponseToFile(res, getDownloadFilename(res.headers.get("content-disposition") || ""));
      UI.setStatus("");
    } catch (e) { if (e?.name !== "AbortError") { console.error("Download failed:", e); UI.setStatus("err"); } else UI.setStatus(""); }
  },

  _updateDatalists() {
    const catList = Utils.$("category-options"), subList = Utils.$("subcategory-options");
    if (!catList || !subList) return;
    const catSeen = new Set(), subSeen = new Set(), catHtml = [], subHtml = [];
    (this._folderTreeCache || []).forEach(r => {
      const cat = String(r?.category || "").trim();
      if (cat && !catSeen.has(cat)) { catSeen.add(cat); catHtml.push(`<option value="${escapeHtml(cat)}"></option>`); }
      (Array.isArray(r?.subfolders) ? r.subfolders : []).forEach(s => {
        const sub = String(s?.subcategory || "").trim();
        if (sub && !subSeen.has(sub)) { subSeen.add(sub); subHtml.push(`<option value="${escapeHtml(sub)}"></option>`); }
      });
    });
    catList.innerHTML = catHtml.join(''); subList.innerHTML = subHtml.join('');
  },

  _setupHtmxListeners() {
    document.addEventListener("htmx:configRequest", e => { const nonce = sessionStorage.getItem("session_nonce"); if (nonce) e.detail.headers["X-Session-Nonce"] = nonce; });
    document.addEventListener("htmx:beforeRequest", e => { if (e.target.id !== "auth-form") UI.setStatus("loading"); });
    document.addEventListener("change", async e => {
      const inp = e.target;
      if (inp?.id === "restore-input" && inp.files?.[0]) {
        if (!await swalConfirm("Restore Backup?", "This will overwrite notes with matching IDs.")) inp.value = "";
        else await this.restoreBackup(inp.files[0]);
      }
    });
  }
};

App.init();
