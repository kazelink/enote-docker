import { Utils, State } from "./dom.js";
import { API, authHeaders } from "./api.js";
import { UI } from "./ui.js";
import { swalConfirm, swalAlert, swalPrompt } from "./swal.js";
import { Editor } from "./editor.js?v=5.2";
import { Auth } from "./auth.js";
const MAX_RESTORE_FILE_BYTES = 100 * 1024 * 1024;
const RESTORE_REQUEST_TARGET_BYTES = 1024 * 1024;
const RESTORE_REQUEST_MAX_ENTRY_COUNT = 100;
const RESTORE_REQUEST_HARD_LIMIT_BYTES = 4 * 1024 * 1024 - 64 * 1024;
const STATUS_RESET_DELAY_MS = 2e3;
const TAG_PREVIEW_LIMIT = 5;
const textEncoder = new TextEncoder();
const ENTITY_ESCAPE_RE = /[&<>"']/g;
const ENTITY_ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
function escapeHtml(value) {
  return String(value ?? "").replace(ENTITY_ESCAPE_RE, (char) => ENTITY_ESCAPE_MAP[char] || char);
}
function encodeInlineParam(value) {
  return encodeURIComponent(String(value ?? "")).replace(/'/g, "%27");
}
function ensureLazyMedia(content) {
  return String(content || "").replace(/<img (?![^>]*\bloading=["']?lazy)/gi, '<img loading="lazy" ');
}
function getRestoreInput() {
  return Utils.$("restore-input");
}
function clearRestoreInput() {
  const input = getRestoreInput();
  if (input) input.value = "";
}
function showRestoreMessage(kind, text) {
  const box = Utils.$("restore-msg");
  if (!box) return;
  box.innerHTML = "";
  if (!text) return;
  const messageEl = document.createElement("div");
  messageEl.className = kind === "error" ? "auth-err" : "auth-ok";
  messageEl.textContent = text;
  box.appendChild(messageEl);
}
function extractRestoreEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.notes)) return payload.notes;
    if (Array.isArray(payload.diaries)) return payload.diaries;
    if (Array.isArray(payload.entries)) return payload.entries;
    if (Array.isArray(payload.list)) return payload.list;
  }
  return null;
}
function extractRestoreFolders(payload) {
  if (payload && typeof payload === "object" && Array.isArray(payload.folders)) {
    return payload.folders;
  }
  return [];
}
function buildRestoreChunks(entries) {
  const chunks = [];
  let currentChunk = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const entryBytes = textEncoder.encode(JSON.stringify(entry)).length;
    if (entryBytes > RESTORE_REQUEST_HARD_LIMIT_BYTES) {
      throw new Error("A note is too large to restore safely.");
    }
    const nextBytes = currentBytes + entryBytes + (currentChunk.length ? 1 : 0);
    if (currentChunk.length && (nextBytes > RESTORE_REQUEST_TARGET_BYTES || currentChunk.length >= RESTORE_REQUEST_MAX_ENTRY_COUNT)) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentBytes = 0;
    }
    currentChunk.push(entry);
    currentBytes += entryBytes + (currentChunk.length > 1 ? 1 : 0);
  }
  if (currentChunk.length) chunks.push(currentChunk);
  return chunks;
}
function applyActiveView(views, activeView) {
  if (views.index) views.index.classList.toggle("active", activeView === "index");
  if (views.category) views.category.classList.toggle("active", activeView === "category");
  if (views.list) views.list.classList.toggle("active", activeView === "list");
  if (views.note) views.note.classList.toggle("active", activeView === "note");
  if (views.backup) views.backup.classList.toggle("active", activeView === "backup");
}
function normalizeState() {
  if (State.view === "backup") {
    State.category = "";
    State.subcategory = "";
    State.note = "";
    State.q = "";
    State.tag = "";
    State.page = 1;
    return;
  }
  State.category = String(State.category || "").trim();
  State.subcategory = String(State.subcategory || "").trim();
  State.note = String(State.note || "").trim();
  State.q = String(State.q || "").trim();
  State.tag = String(State.tag || "").trim();
  State.page = Number.isFinite(State.page) && State.page > 0 ? State.page : 1;
  if (!State.category) {
    State.subcategory = "";
    if (State.note) {
      State.view = "note";
      return;
    }
    if (State.view === "list" || State.q || State.tag) {
      State.view = "list";
      return;
    }
    State.view = "index";
    State.q = "";
    State.tag = "";
    return;
  }
  if (!State.subcategory) {
    if (State.note) {
      State.view = "note";
      return;
    }
    State.view = "category";
    return;
  }
  State.view = State.note ? "note" : "list";
}
function syncStateFromLocation() {
  const params = new URLSearchParams(location.search);
  const view = params.get("view") || "index";
  State.view = ["index", "category", "list", "note", "backup"].includes(view) ? view : "index";
  State.category = params.get("category") || "";
  State.subcategory = params.get("subcategory") || "";
  State.note = params.get("note") || "";
  State.q = params.get("q") || "";
  State.tag = params.get("tag") || "";
  State.page = parseInt(params.get("page") || "1", 10);
  normalizeState();
}
function buildLocationSearch() {
  const params = new URLSearchParams();
  if (State.view !== "index") params.set("view", State.view);
  if (State.category) params.set("category", State.category);
  if (State.subcategory) params.set("subcategory", State.subcategory);
  if (State.note) params.set("note", State.note);
  if (State.q) params.set("q", State.q);
  if (State.tag) params.set("tag", State.tag);
  if (State.page > 1) params.set("page", String(State.page));
  const query = params.toString();
  return query ? `?${query}` : location.pathname;
}
function resetStatusLater(statusKind) {
  setTimeout(() => {
    if (statusKind !== "err" || !App._restoreInFlight) UI.setStatus("");
  }, STATUS_RESET_DELAY_MS);
}
const COLLAPSE_STORAGE_KEY = "enote_collapsed_categories";
const App = {
  _views: {}, _popstateHandler: null, _restoreInFlight: false, _searchPanelOpen: false, _folderTreeCache: null, _tagCloudCache: null, _tagCloudExpanded: false, _collapsedCategories: /* @__PURE__ */ new Set(), _collapsedStateLoaded: false, _folderPanelCollapsed: false, _currentNote: null, _notePathHint: null, _treeContextState: { scope: "root", category: "" }, _loadCollapsedState() {
    try {
      const stored = localStorage.getItem(COLLAPSE_STORAGE_KEY);
      if (stored) {
        const arr = JSON.parse(stored);
        if (Array.isArray(arr)) {
          this._collapsedCategories = new Set(arr);
          this._collapsedStateLoaded = true;
        }
      }
    } catch { }
  }, _saveCollapsedState() {
    try {
      localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...this._collapsedCategories]));
    } catch { }
  }, async init() {
    Auth.init();
    Editor.init();
    this._loadCollapsedState();
    this._views = { index: Utils.$("v-index"), category: Utils.$("v-category"), list: Utils.$("v-list"), note: Utils.$("v-note"), backup: Utils.$("v-backup") };
    window.App = this;
    this._setupHtmxListeners();
    this._setupTreeContextMenu();
    UI.initGlobalEvents();
    const footerYear = Utils.$("footer-year");
    if (footerYear) footerYear.textContent = String((/* @__PURE__ */ new Date()).getFullYear());
    const hasNonce = !!sessionStorage.getItem("session_nonce");
    const authed = hasNonce && await API.checkAuth().catch(() => false);
    if (authed) {
      await this.loadView();
    } else {
      sessionStorage.removeItem("session_nonce");
      UI.showAuth();
    }
    document.body.classList.add("ready");
    if (!this._popstateHandler) {
      this._popstateHandler = () => this.loadView();
      window.addEventListener("popstate", this._popstateHandler);
    }
  }, async route(nextState) {
    if (!await Editor.close()) return;
    this.closeTreeContextMenu();
    Object.assign(State, nextState);
    normalizeState();
    history.pushState(null, "", buildLocationSearch());
    this.loadView();
  }, async loadView() {
    syncStateFromLocation();
    if (State.view !== "note") {
      this._currentNote = null;
      this._notePathHint = null;
    }
    applyActiveView(this._views, State.view);
    UI.renderBreadcrumb();
    this._syncHeaderBackButton();
    this._syncSearchBar();
    this._syncSearchBarVisibility();
    const isBackup = State.view === "backup";
    if (!isBackup) UI.setStatus("loading");
    try {
      await Promise.all([this._loadFolderTree(), this._loadTagCloud().catch((e) => {
        console.error("Tag cloud load failed:", e);
        this._renderTagCloudError();
      })]);
      if (isBackup) {
        this._populateExportScope();
        UI.setStatus("");
        return;
      }
      if (State.view === "index") {
        await this._loadHomeNotes();
      } else if (State.view === "category") {
        await this._loadCategoryNotes();
      } else if (State.view === "list") {
        await this._loadNotes();
      } else if (State.view === "note") {
        await this._loadNote();
      }
      UI.setStatus("");
    } catch (e) {
      console.error("View load failed:", e);
      UI.setStatus("err");
    }
  }, async _loadHomeNotes() {
    await this._loadNoteCollection({ listId: "home-entry-list", params: { page: State.page, size: 10 } });
  }, async _loadCategoryNotes() {
    await this._loadNoteCollection({ listId: "category-entry-list", params: { category: State.category, q: State.q, tag: State.tag, page: State.page } });
  }, async _loadNotes() {
    await this._loadNoteCollection({ listId: "entry-list", params: { category: State.category, subcategory: State.subcategory, q: State.q, tag: State.tag, page: State.page } });
  }, async _loadNoteCollection({ listId, params = {}, showPagination = true }) {
    const entryListEl = Utils.$(listId);
    if (!entryListEl) return;
    const viewEl = entryListEl.closest(".view-container");
    const paginationEl = viewEl?.querySelector("[data-pagination]");
    entryListEl.innerHTML = '<div class="loading-hint">Loading...</div>';
    if (paginationEl) paginationEl.style.display = "none";
    const listHtml = await API.html("list", params);
    entryListEl.innerHTML = listHtml;
    if (!showPagination) {
      entryListEl.querySelector("[data-pagination]")?.remove();
      State.data.totalPg = 1;
      return;
    }
    this._syncPaginationFromDom(viewEl);
  }, async _loadFolderTree(force = false) {
    const target = Utils.$("folder-tree");
    if (!target) return;
    if (!force && this._folderTreeCache) {
      this._renderFolderTree();
      return;
    }
    if (!target.querySelector('.tree-group')) {
      target.innerHTML = '<div class="loading-hint">Loading...</div>';
    }
    const tree = await API.req("folders/tree");
    this._folderTreeCache = Array.isArray(tree) ? tree : [];
    this._renderFolderTree();
  }, async _loadTagCloud(force = false) {
    const target = Utils.$("tag-cloud");
    if (!target) return;
    if (!force && this._tagCloudCache) {
      this._renderTagCloud();
      return;
    }
    if (!target.querySelector('.tag-cloud-list')) {
      target.innerHTML = '<div class="tag-cloud-empty">Loading...</div>';
    }
    const tags = await API.req("tags");
    this._tagCloudCache = Array.isArray(tags) ? tags : [];
    this._renderTagCloud();
  }, _renderTagCloud() {
    const target = Utils.$("tag-cloud");
    if (!target) return;
    const rows = this._tagCloudCache || [];
    if (!rows.length) {
      target.innerHTML = '<div class="tag-cloud-empty"><em>No tags yet.</em></div>';
      return;
    }
    const activeTag = String(State.tag || "").trim();
    const hasOverflow = rows.length > TAG_PREVIEW_LIMIT;
    let visibleRows = rows;
    if (!this._tagCloudExpanded && hasOverflow) {
      visibleRows = rows.slice(0, TAG_PREVIEW_LIMIT);
      if (activeTag && !visibleRows.some((row) => String(row?.tag || "").trim() === activeTag)) {
        const activeRow = rows.find((row) => String(row?.tag || "").trim() === activeTag);
        if (activeRow) {
          visibleRows = rows.slice(0, TAG_PREVIEW_LIMIT - 1).concat(activeRow);
        }
      }
    }
    const chipsHtml = visibleRows.map((row) => {
      const tag = String(row?.tag || "").trim();
      if (!tag) return "";
      const encodedTag = encodeInlineParam(tag);
      const activeClass = activeTag === tag ? " active" : "";
      return `<button class="tag-cloud-chip${activeClass}" type="button" onclick="App.openSidebarTagByEncoded('${encodedTag}')">#${escapeHtml(tag)}</button>`;
    }).join("");
    const footerLabel = this._tagCloudExpanded ? "Show fewer tags" : "Show more tags";
    const footerClass = this._tagCloudExpanded ? "tag-cloud-more is-expanded" : "tag-cloud-more";
    const footerMarkup = hasOverflow ? `<div class="tag-cloud-footer"><button class="${footerClass}" type="button" aria-label="${footerLabel}" onclick="App.toggleTagCloudExpanded()"><i class="ri-arrow-right-s-line"></i></button></div>` : "";
    target.innerHTML = `<div class="tag-cloud-list">${chipsHtml}</div>${footerMarkup}`;
    target.querySelector(".tag-cloud-more")?.removeAttribute("title");
  }, _renderTagCloudError() {
    const target = Utils.$("tag-cloud");
    if (!target) return;
    target.innerHTML = '<div class="tag-cloud-empty">Tags unavailable.</div>';
  }, _invalidateSidebarCaches() {
    this._folderTreeCache = null;
    this._tagCloudCache = null;
    this._tagCloudExpanded = false;
  }, toggleTagCloudExpanded() {
    if ((this._tagCloudCache || []).length <= TAG_PREVIEW_LIMIT) return;
    this._tagCloudExpanded = !this._tagCloudExpanded;
    this._renderTagCloud();
  }, _syncFolderPanelControls() {
    const treeShell = Utils.$("folder-tree-shell");
    const treeToggleLabel = Utils.$("tree-toggle-label");
    const folderDomToggleLabel = Utils.$("folder-dom-toggle-label");
    const treeToggleBtn = Utils.$("btn-tree-toggle");
    const folderDomToggleBtn = Utils.$("btn-folder-dom-toggle");
    if (treeShell) {
      treeShell.classList.toggle("collapsed", this._folderPanelCollapsed);
    }
    if (folderDomToggleBtn) {
      const folderLabel = this._folderPanelCollapsed ? "Show folder panel content" : "Hide folder panel content";
      folderDomToggleBtn.setAttribute("aria-label", folderLabel);
      folderDomToggleBtn.dataset.state = this._folderPanelCollapsed ? "collapsed" : "expanded";
    }
    const categories = (this._folderTreeCache || []).map((row) => String(row?.category || "").trim()).filter(Boolean);
    const allCollapsed = categories.length > 0 && categories.every((category) => this._collapsedCategories.has(category));
    if (treeToggleBtn) {
      const treeLabel = allCollapsed ? "Expand all folders" : "Collapse all folders";
      treeToggleBtn.setAttribute("aria-label", treeLabel);
      treeToggleBtn.dataset.state = allCollapsed ? "collapsed" : "expanded";
      treeToggleBtn.disabled = categories.length === 0;
    }
    if (folderDomToggleLabel) {
      folderDomToggleLabel.textContent = "";
    }
    if (treeToggleLabel) {
      treeToggleLabel.textContent = "";
    }
  }, _renderFolderTree() {
    const target = Utils.$("folder-tree");
    if (!target) return;
    const tree = this._folderTreeCache || [];
    const activeCategory = State.view === "note" && !State.category ? String(this._currentNote?.category || "") : State.category;
    const activeSubcategory = State.view === "note" && !State.subcategory ? String(this._currentNote?.subcategory || "") : State.subcategory;
    if (!tree.length) {
      target.innerHTML = '<div class="loading-hint">No folders yet. Save a note to create one.</div>';
      this._syncFolderPanelControls();
      return;
    }
    if (!this._collapsedStateLoaded) {
      tree.forEach((row) => {
        const category = String(row?.category || "").trim();
        if (category) this._collapsedCategories.add(category);
      });
      this._collapsedStateLoaded = true;
      this._saveCollapsedState();
    }
    target.innerHTML = tree.map((categoryRow) => {
      const category = String(categoryRow?.category || "");
      const encodedCategory = encodeInlineParam(category);
      const subfolders = Array.isArray(categoryRow?.subfolders) ? categoryRow.subfolders : [];
      const isOpen = !this._collapsedCategories.has(category);
      const isActiveSubcategory = category === activeCategory && !!activeSubcategory;
      const isActiveCategory = category === activeCategory && !activeSubcategory;
      const categoryStateClass = isActiveSubcategory ? "active-parent" : isActiveCategory ? "active" : "";
      return `                <div class="tree-group ${isOpen ? "open" : ""}">                    <div class="tree-node tree-category ${categoryStateClass}" onclick="App.openCategoryByEncoded('${encodedCategory}')" oncontextmenu="return App.openTreeContextMenu(event, 'category', '${encodedCategory}')">                        <button class="tree-toggle" type="button" onclick="event.stopPropagation(); App.toggleCategoryFoldByEncoded('${encodedCategory}')">                            <svg class="ri-icon" viewBox="0 0 24 24">                                <path d="M10 6l6 6-6 6"></path>                            </svg>                        </button>                        <span class="tree-label">${escapeHtml(category || "Imported")}</span>                        <span class="tree-count">${Number(categoryRow?.count || 0)}</span>                        <span class="tree-delete-slot">                            <button class="tree-delete-btn" type="button" onclick="event.stopPropagation(); App.deleteCategoryByEncoded('${encodedCategory}')">                                <i class="ri-close-line"></i>                            </button>                        </span>                    </div>                    <div class="tree-children">                        ${subfolders.length ? subfolders.map((subfolderRow) => {
        const subcategory = String(subfolderRow?.subcategory || "General");
        const encodedSubcategory = encodeInlineParam(subcategory);
        const isCurrentSubcategory = category === activeCategory && subcategory === activeSubcategory;
        return `                                    <div class="tree-node tree-subcategory ${isCurrentSubcategory ? "active" : ""}" onclick="App.openSubcategoryByEncoded('${encodedCategory}', '${encodedSubcategory}')" oncontextmenu="return App.openTreeContextMenu(event, 'subcategory', '${encodedCategory}', '${encodedSubcategory}')">                                        <span class="tree-leaf"></span>                                        <span class="tree-label">${escapeHtml(subcategory)}</span>                                        <span class="tree-count">${Number(subfolderRow?.count || 0)}</span>                                        <span class="tree-delete-slot">                                            <button class="tree-delete-btn" type="button" onclick="event.stopPropagation(); App.deleteSubcategoryByEncoded('${encodedCategory}', '${encodedSubcategory}')">                                                <i class="ri-close-line"></i>                                            </button>                                        </span>                                    </div>                                `;
      }).join("") : '<div class="tree-empty">No subfolders yet.</div>'}                    </div>                </div>            `;
    }).join("");
    this._syncFolderPanelControls();
  }, _primeCurrentNote(note) {
    if (!note?.id) return null;
    const normalizedNote = { ...note, id: String(note.id || ""), title: String(note.title || ""), category: String(note.category || ""), subcategory: String(note.subcategory || ""), content: typeof note.content === "string" ? note.content : "", tags: Array.isArray(note.tags) ? note.tags.map((tag) => String(tag || "").trim()).filter(Boolean) : [] };
    this._currentNote = normalizedNote;
    this._notePathHint = { category: normalizedNote.category, subcategory: normalizedNote.subcategory };
    return normalizedNote;
  }, primeSavedNote(note) {
    return this._primeCurrentNote(note);
  }, async _loadNote() {
    const detailEl = Utils.$("note-detail");
    if (!detailEl) return;
    const noteId = String(State.note || "").trim();
    const optimisticNote = this._currentNote?.id === noteId ? this._currentNote : null;
    if (optimisticNote) {
      UI.renderBreadcrumb();
      detailEl.innerHTML = this._renderNoteDetail(optimisticNote);
      this._renderFolderTree();
    } else {
      detailEl.innerHTML = '<div class="loading-hint">Loading...</div>';
    }
    const note = await API.req("list", { id: noteId });
    if (String(State.note || "").trim() !== noteId) return;
    if (!note?.id) {
      detailEl.innerHTML = '<div class="loading-hint">Note not found.</div>';
      this._currentNote = null;
      return;
    }
    this._primeCurrentNote(note);
    UI.renderBreadcrumb();
    detailEl.innerHTML = this._renderNoteDetail(note);
    this._renderFolderTree();
  }, _renderNoteDetail(note) {
    const safeId = escapeHtml(note.id);
    const safeTitle = escapeHtml(note.title || "Untitled Note");
    const safeDate = escapeHtml(String(note.updatedAt || "").slice(0, 10));
    const content = ensureLazyMedia(note.content || "");
    const tags = Array.isArray(note.tags) ? note.tags : [];
    const footerHtml = tags.length ? `<div class="note-detail-footer"><div class="note-detail-tags">${tags.map((tag) => `<button class="note-detail-tag" type="button" onclick="App.toggleTagByEncoded('${encodeInlineParam(tag)}')">#${escapeHtml(tag)}</button>`).join("")}</div></div>` : "";
    return `            <article class="note-detail-shell" tabindex="0">                <div class="note-detail-header">                    <div class="note-title-block">                        <div class="note-title note-detail-title">${safeTitle}</div>                        <div class="note-detail-meta">                            ${safeDate ? `<div class="note-date-muted">${safeDate}</div>` : '<div class="note-date-muted"></div>'}                            <div class="item-actions">                                <span class="btn-icon-s edit" onclick="App.editEntry(this, '${safeId}')"><i class="ri-edit-line"></i></span>                                <span class="btn-del" onclick="App.deleteEntry('${safeId}')"><i class="ri-delete-bin-line"></i></span>                            </div>                        </div>                    </div>                </div>                <div class="dc-text note-detail-body">${content}</div>                ${footerHtml}            </article>        `;
  }, _syncHeaderBackButton() {
    const button = Utils.$("btn-header-back");
    if (!button) return;
    const shouldShow = State.view !== "index";
    button.classList.toggle("visible", shouldShow);
    button.disabled = !shouldShow;
  }, _setupTreeContextMenu() {
    const tree = Utils.$("folder-tree");
    if (tree) {
      tree.addEventListener("contextmenu", (event) => {
        if (event.target.closest(".tree-node")) return;
        this.openTreeContextMenu(event, "root", "");
      });
    }
    document.addEventListener("click", () => this.closeTreeContextMenu());
    document.addEventListener("contextmenu", (event) => {
      if (event.target.closest("#folder-tree") || event.target.closest("#tree-context-menu")) return;
      this.closeTreeContextMenu();
    });
    window.addEventListener("scroll", () => this.closeTreeContextMenu(), { passive: true });
    window.addEventListener("resize", () => this.closeTreeContextMenu());
  }, openTreeContextMenu(event, scope = "root", encodedCategory = "", encodedSubcategory = "") {
    event.preventDefault();
    event.stopPropagation();
    const menu = Utils.$("tree-context-menu");
    const subfolderBtn = Utils.$("tree-context-subfolder");
    const renameBtn = Utils.$("tree-context-rename");
    if (!menu || !subfolderBtn) return false;
    const category = decodeURIComponent(encodedCategory || "");
    const subcategory = decodeURIComponent(encodedSubcategory || "");
    this._treeContextState = { scope, category, subcategory };
    if (scope === "root") {
      subfolderBtn.style.display = "none";
      if (renameBtn) renameBtn.style.display = "none";
    } else {
      subfolderBtn.style.display = scope === "category" ? "flex" : "none";
      subfolderBtn.textContent = `NEW SUBFOLDER IN ${category || "CATEGORY"}`;
      if (renameBtn) {
        renameBtn.style.display = "flex";
        renameBtn.textContent = `RENAME ${scope === "category" ? category : subcategory}`;
      }
    }
    menu.style.display = "flex";
    requestAnimationFrame(() => {
      const maxLeft = Math.max(8, window.innerWidth - menu.offsetWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - menu.offsetHeight - 8);
      menu.style.left = `${Math.min(event.clientX, maxLeft)}px`;
      menu.style.top = `${Math.min(event.clientY, maxTop)}px`;
    });
    return false;
  }, closeTreeContextMenu() {
    const menu = Utils.$("tree-context-menu");
    if (!menu) return;
    menu.style.display = "none";
  }, _syncSearchBar() {
    const input = Utils.$("note-search");
    if (input) input.value = State.q || "";
    const reset = Utils.$("search-reset");
    if (reset) reset.style.display = State.q || State.tag ? "inline-flex" : "none";
    const searchToggle = Utils.$("btn-search-toggle");
    if (searchToggle) {
      searchToggle.classList.toggle("active", this._searchPanelOpen || !!State.q);
    }
  }, _syncSearchBarVisibility() {
    const tools = Utils.$("global-note-tools");
    if (!tools) return;
    const visible = State.view !== "backup" && (this._searchPanelOpen || !!State.q);
    tools.classList.toggle("active", visible);
  }, _getActiveViewEl() {
    return Object.values(this._views).find((view) => view?.classList.contains("active")) || null;
  }, _getActivePaginationScope() {
    return this._getActiveViewEl();
  }, _syncPaginationFromDom(scopeEl = this._getActivePaginationScope()) {
    const pgData = scopeEl?.querySelector(".pg-data");
    State.data.totalPg = pgData ? parseInt(pgData.dataset.total, 10) || 1 : 1;
  }, openCategoryByEncoded(encodedCategory) {
    const category = decodeURIComponent(encodedCategory || "");
    this.route({ view: "category", category, subcategory: "", note: "", q: "", tag: "", page: 1 });
  }, openSubcategoryByEncoded(encodedCategory, encodedSubcategory) {
    const category = decodeURIComponent(encodedCategory || "");
    const subcategory = decodeURIComponent(encodedSubcategory || "");
    this.route({ view: "list", category, subcategory, note: "", q: "", tag: "", page: 1 });
  }, toggleCategoryFoldByEncoded(encodedCategory) {
    const category = decodeURIComponent(encodedCategory || "");
    if (!category) return;
    if (this._collapsedCategories.has(category)) {
      this._collapsedCategories.delete(category);
    } else {
      this._collapsedCategories.add(category);
    }
    this._saveCollapsedState();
    this._renderFolderTree();
  }, toggleAllFolders() {
    const categories = (this._folderTreeCache || []).map((row) => String(row?.category || "").trim()).filter(Boolean);
    if (!categories.length) {
      this._syncFolderPanelControls();
      return;
    }
    const allCollapsed = categories.every((category) => this._collapsedCategories.has(category));
    if (allCollapsed) {
      this._collapsedCategories.clear();
    } else {
      categories.forEach((category) => this._collapsedCategories.add(category));
    }
    this._saveCollapsedState();
    this._renderFolderTree();
  }, toggleFolderPanel() {
    this._folderPanelCollapsed = !this._folderPanelCollapsed;
    this._syncFolderPanelControls();
  }, openNoteById(id, encodedCategory = "", encodedSubcategory = "") {
    const note = String(id || "").trim();
    if (!note) return;
    const category = decodeURIComponent(encodedCategory || "");
    const subcategory = decodeURIComponent(encodedSubcategory || "");
    this._notePathHint = { category, subcategory };
    this.route({ view: "note", note });
  }, async deleteCategoryByEncoded(encodedCategory) {
    const category = decodeURIComponent(encodedCategory || "");
    if (!category) return;
    const ok = await swalConfirm("Delete Category?", `This will delete "${category}" and all notes inside it.`);
    if (!ok) return;
    UI.setStatus("loading");
    try {
      await API.req("folders", { category }, "DELETE");
      this._invalidateSidebarCaches();
      if (State.category === category) {
        this.route({ view: "index", category: "", subcategory: "", note: "", q: "", tag: "", page: 1 });
      } else {
        await this.loadView();
      }
      UI.setStatus("ok");
      resetStatusLater("ok");
    } catch (e) {
      console.error("Delete category failed:", e);
      UI.setStatus("err");
      resetStatusLater("err");
      swalAlert("Delete Failed", e?.message || "Unable to delete category.", "error");
    }
  }, async deleteSubcategoryByEncoded(encodedCategory, encodedSubcategory) {
    const category = decodeURIComponent(encodedCategory || "");
    const subcategory = decodeURIComponent(encodedSubcategory || "");
    if (!category || !subcategory) return;
    const ok = await swalConfirm("Delete Subfolder?", `This will delete "${subcategory}" and all notes inside it.`);
    if (!ok) return;
    UI.setStatus("loading");
    try {
      await API.req("folders", { category, subcategory }, "DELETE");
      this._invalidateSidebarCaches();
      if (State.category === category && State.subcategory === subcategory) {
        this.route({ view: "category", category, subcategory: "", note: "", q: "", tag: "", page: 1 });
      } else {
        await this.loadView();
      }
      UI.setStatus("ok");
      resetStatusLater("ok");
    } catch (e) {
      console.error("Delete subfolder failed:", e);
      UI.setStatus("err");
      resetStatusLater("err");
      swalAlert("Delete Failed", e?.message || "Unable to delete subfolder.", "error");
    }
  }, toggleTagByEncoded(encodedTag) {
    const tag = decodeURIComponent(encodedTag || "");
    this._searchPanelOpen = false;
    const nextView = State.category && !State.subcategory ? "category" : "list";
    this.route({ view: nextView, category: State.category, subcategory: State.subcategory, note: "", q: State.q, tag: State.tag === tag ? "" : tag, page: 1 });
  }, openSidebarTagByEncoded(encodedTag) {
    const tag = decodeURIComponent(encodedTag || "");
    const nextTag = State.tag === tag ? "" : tag;
    this._searchPanelOpen = false;
    this.route({ view: nextTag ? "list" : "index", category: "", subcategory: "", note: "", q: "", tag: nextTag, page: 1 });
  }, applySearch() {
    const query = String(Utils.$("note-search")?.value || "").trim();
    if (!query) {
      this.clearSearch();
      return;
    }
    this._searchPanelOpen = true;
    this.route({ view: "list", category: "", subcategory: "", note: "", q: query, tag: "", page: 1 });
  }, toggleSearchBox() {
    if (State.view === "backup") return;
    if (State.q || State.tag) {
      this._searchPanelOpen = true;
    } else {
      this._searchPanelOpen = !this._searchPanelOpen;
    }
    this._syncSearchBar();
    this._syncSearchBarVisibility();
    if (this._searchPanelOpen || State.q || State.tag) {
      requestAnimationFrame(() => {
        Utils.$("note-search")?.focus({ preventScroll: true });
      });
    }
  }, clearSearch() {
    const input = Utils.$("note-search");
    if (input) input.value = "";
    this._searchPanelOpen = false;
    if (State.category && State.subcategory) {
      this.route({ view: "list", category: State.category, subcategory: State.subcategory, note: "", q: "", tag: "", page: 1 });
      return;
    }
    if (State.category) {
      this.route({ view: "category", category: State.category, subcategory: "", note: "", q: "", tag: "", page: 1 });
      return;
    }
    this.route({ view: "index", category: "", subcategory: "", note: "", q: "", tag: "", page: 1 });
  }, async createCategory() {
    this.closeTreeContextMenu();
    const category = await swalPrompt("New Category", "Create a top-level folder for your notes.", "Major category");
    if (!category) return;
    UI.setStatus("loading");
    try {
      const result = await API.req("folders", { category }, "POST");
      this._folderTreeCache = null;
      this.route({ view: "category", category: result.category, subcategory: "", note: "", q: "", tag: "", page: 1 });
      UI.setStatus("ok");
      resetStatusLater("ok");
    } catch (e) {
      console.error("Create category failed:", e);
      UI.setStatus("err");
      resetStatusLater("err");
      swalAlert("Create Failed", e?.message || "Unable to create category.", "error");
    }
  }, async createSubcategory(categoryOverride = "") {
    const targetCategory = String(categoryOverride || State.category || "").trim();
    this.closeTreeContextMenu();
    if (!targetCategory) return;
    const subcategory = await swalPrompt("New Subfolder", `Create a subfolder inside "${targetCategory}".`, "Minor category");
    if (!subcategory) return;
    UI.setStatus("loading");
    try {
      const result = await API.req("folders", { category: targetCategory, subcategory }, "POST");
      this._folderTreeCache = null;
      this.route({ view: "list", category: result.category, subcategory: result.subcategory, note: "", q: "", tag: "", page: 1 });
      UI.setStatus("ok");
      resetStatusLater("ok");
    } catch (e) {
      console.error("Create subfolder failed:", e);
      UI.setStatus("err");
      resetStatusLater("err");
      swalAlert("Create Failed", e?.message || "Unable to create subfolder.", "error");
    }
  }, async createCategoryFromContextMenu() {
    await this.createCategory();
  }, async createSubcategoryFromContextMenu() {
    const category = String(this._treeContextState?.category || "").trim();
    if (!category) return;
    await this.createSubcategory(category);
  }, async renameFromContextMenu() {
    const { scope, category, subcategory } = this._treeContextState;
    this.closeTreeContextMenu();
    if (!category) return;
    
    const isCat = scope === "category";
    const oldName = isCat ? category : subcategory;
    const newName = await swalPrompt("Rename", `Enter a new name for "${oldName}"`, "", oldName, "Rename");
    
    if (!newName || newName === oldName) return;
    UI.setStatus("loading");
    try {
      await API.req("folders", { 
        oldCategory: category, 
        oldSubcategory: isCat ? "" : subcategory, 
        newName 
      }, "PUT");
      
      this._folderTreeCache = null;
      
      if (State.category === category && (isCat || State.subcategory === subcategory)) {
         this.route({
            view: State.view,
            category: isCat ? newName : category,
            subcategory: !isCat ? newName : State.subcategory,
            note: State.note,
            q: State.q,
            tag: State.tag,
            page: 1
         });
      } else {
         await this.loadView();
      }
      UI.setStatus("ok");
      resetStatusLater("ok");
    } catch (e) {
      console.error("Rename failed:", e);
      UI.setStatus("err");
      resetStatusLater("err");
      swalAlert("Rename Failed", e?.message || "Unable to rename folder.", "error");
    }
  }, handleSearchKeydown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      this.applySearch();
    }
  }, toggleJump(show) {
    const scopeEl = this._getActivePaginationScope();
    const pageTextEl = scopeEl?.querySelector(".pg-status-txt");
    const pageInputEl = scopeEl?.querySelector(".pg-inp");
    if (!pageTextEl || !pageInputEl) return;
    if (show) {
      pageTextEl.style.display = "none";
      pageInputEl.style.display = "inline-block";
      pageInputEl.value = State.page;
      requestAnimationFrame(() => pageInputEl.focus({ preventScroll: true }));
    } else {
      pageTextEl.style.display = "inline";
      pageInputEl.style.display = "none";
      const nextPage = parseInt(pageInputEl.value, 10);
      if (nextPage && nextPage !== State.page && nextPage <= State.data.totalPg) {
        this.route({ page: nextPage });
      }
    }
  }, async newEntry() {
    if (await Editor.close()) {
      await Editor.open("new", { title: "", category: State.category || "", subcategory: State.subcategory || "", tags: [], content: "", createdAt: "", updatedAt: "" });
    }
  }, async editEntry(btn, id) {
    if (!await Editor.close()) return;
    const row = btn?.closest(".note-detail-shell, .archive-row, .d-item") || (State.view === "note" ? Utils.$("note-detail")?.querySelector(".note-detail-shell") : null);
    const note = this._currentNote?.id === id ? this._currentNote : await API.req("list", { id });
    await Editor.open("edit", note, row);
  }, async deleteEntry(id) {
    const ok = await swalConfirm("Delete Note?", "This note and its unused local media will be removed.");
    if (!ok) return;
    UI.setStatus("loading");
    try {
      await API.req("delete", { id }, "DELETE");
      this._invalidateSidebarCaches();
      if (State.view === "note" && State.note === id) {
        if (State.category && !State.subcategory) {
          this.route({ view: "category", note: "", page: State.page });
          return;
        }
        this.route({ view: State.category && State.subcategory || State.q || State.tag ? "list" : "index", note: "", page: State.page });
        return;
      }
      await this.loadView();
      UI.setStatus("ok");
      resetStatusLater("ok");
    } catch (e) {
      console.error("Delete failed:", e);
      UI.setStatus("err");
      resetStatusLater("err");
    }
  }, changePage(dir) {
    const next = State.page + dir;
    if (next >= 1 && next <= State.data.totalPg) this.route({ page: next });
  }, async goBack() {
    if (State.view === "note") {
      if (State.category && !State.subcategory) {
        this.route({ view: "category", note: "", page: State.page });
        return;
      }
      if (State.category && State.subcategory) {
        this.route({ view: "list", note: "", page: State.page });
        return;
      }
      if (State.q || State.tag) {
        this.route({ view: "list", note: "", page: State.page });
        return;
      }
    }
    if (State.view === "list") {
      if (!State.category || !State.subcategory) {
        this.route({ view: "index", category: "", subcategory: "", note: "", q: "", tag: "", page: 1 });
        return;
      }
      this.route({ view: "category", category: State.category, subcategory: "", note: "", q: "", tag: "", page: 1 });
      return;
    }
    this.route({ view: "index", category: "", subcategory: "", note: "", q: "", tag: "", page: 1 });
  }, closeEditor: () => Editor.close(), pickRestoreFile() {
    const input = getRestoreInput();
    if (!input) return;
    try {
      if (typeof input.showPicker === "function") input.showPicker();
      else input.click();
    } catch {
      input.click();
    }
  }, async restoreBackup(file) {
    if (!file || this._restoreInFlight) return;
    this._restoreInFlight = true;
    UI.setStatus("loading");
    showRestoreMessage("info", "Reading backup...");
    try {
      if (file.size > MAX_RESTORE_FILE_BYTES) {
        throw new Error("Backup file too large (max 100MB).");
      }
      await nextFrame();
      const rawText = await file.text();
      if (!rawText) throw new Error("No data provided.");
      showRestoreMessage("info", "Parsing backup...");
      await nextFrame();
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new Error("Invalid JSON.");
      }
      const entries = extractRestoreEntries(parsed);
      if (!entries) throw new Error("Invalid data format.");
      const folders = extractRestoreFolders(parsed);
      const chunks = buildRestoreChunks(entries);
      const chunksToSend = chunks.length ? chunks : [[]];
      let count = 0;
      let skipped = 0;
      for (let i = 0; i < chunksToSend.length; i += 1) {
        const percent = Math.round(i / Math.max(chunksToSend.length, 1) * 100);
        showRestoreMessage("info", `Restoring backup... ${percent}%`);
        const result = await API.req("backup/restore", { entries: chunksToSend[i], folders: i === 0 ? folders : [], totalBytes: file.size }, "POST");
        count += Number(result?.count ?? 0);
        skipped += Number(result?.skipped ?? 0);
      }
      showRestoreMessage("success", `Restore successful. Processed ${count} notes, skipped ${skipped} invalid notes.`);
      UI.setStatus("ok");
      resetStatusLater("ok");
      this._invalidateSidebarCaches();
      await this.loadView();
      swalAlert("Restore Complete", `Notes processed: ${count}
Invalid skipped: ${skipped}`, "success");
    } catch (err) {
      const message = err?.message || "Restore failed.";
      showRestoreMessage("error", `Restore Failed: ${message}`);
      UI.setStatus("err");
      resetStatusLater("err");
    } finally {
      clearRestoreInput();
      this._restoreInFlight = false;
    }
  }, _populateExportScope() {
    const select = Utils.$("export-scope");
    if (!select) return;
    const tree = this._folderTreeCache || [];
    const options = ['<option value="">All Notes</option>'];
    for (const row of tree) {
      const category = String(row?.category || "").trim();
      if (!category) continue;
      const encodedCategory = escapeHtml(category);
      options.push(`<option value="c:${encodedCategory}">${encodedCategory}</option>`);
      const subs = Array.isArray(row?.subfolders) ? row.subfolders : [];
      for (const sub of subs) {
        const subcategory = String(sub?.subcategory || "").trim();
        if (!subcategory) continue;
        options.push(`<option value="cs:${encodedCategory}/${escapeHtml(subcategory)}">&nbsp;&nbsp;${encodedCategory} / ${escapeHtml(subcategory)}</option>`);
      }
    }
    select.innerHTML = options.join("");
  }, async downloadBackup() {
    UI.setStatus("loading");
    try {
      const scopeValue = Utils.$("export-scope")?.value || "";
      const params = new URLSearchParams();
      if (scopeValue.startsWith("cs:")) {
        const [category, subcategory] = scopeValue.slice(3).split("/", 2);
        if (category) params.set("category", category);
        if (subcategory) params.set("subcategory", subcategory);
      } else if (scopeValue.startsWith("c:")) {
        params.set("category", scopeValue.slice(2));
      }
      const url = `/api/backup/export${params.toString() ? `?${params.toString()}` : ""}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (res.status === 401) {
        sessionStorage.removeItem("session_nonce");
        UI.showAuth();
        throw new Error("Unauthorized");
      }
      if (!res.ok) {
        let errMsg = "Download failed";
        try {
          const errData = await res.json();
          if (errData?.error) errMsg = errData.error;
        } catch { }
        throw new Error(errMsg);
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      const disposition = res.headers.get("content-disposition") || "";
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      a.download = filenameMatch ? filenameMatch[1] : `note-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(blobUrl);
      UI.setStatus("");
    } catch (e) {
      console.error("Backup download failed:", e);
      UI.setStatus("err");
    }
  }, _setupHtmxListeners() {
    document.addEventListener("htmx:configRequest", (e) => {
      const sessionNonce = sessionStorage.getItem("session_nonce");
      if (sessionNonce) e.detail.headers["X-Session-Nonce"] = sessionNonce;
    });
    document.addEventListener("htmx:beforeRequest", (e) => {
      if (e.target.id !== "auth-form") UI.setStatus("loading");
    });
    document.addEventListener("change", async (e) => {
      const input = e.target;
      if (!input || input.id !== "restore-input") return;
      const file = input.files?.[0];
      if (!file) return;
      const ok = await swalConfirm("Restore Backup?", "This will overwrite notes with matching IDs.");
      if (!ok) {
        input.value = "";
        return;
      }
      await this.restoreBackup(file);
    });
  }
};
App.init();
