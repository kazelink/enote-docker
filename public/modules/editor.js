import { Utils, State } from './dom.js';
import { API } from './api.js';
import { UI } from './ui.js';
import { swalAlert, swalUnsaved } from './swal.js';
import { Upload } from './upload.js';
import { sanitizePastedHtml } from './paste.js?v=5.2';

const SEL = { header: '.d-item-header', text: '.dc-text', actions: '.item-actions', readMore: '.btn-read-more' };

function getSel() {
    return window.getSelection();
}

function anchorBlock(sel, selectors = 'p, div, h1, h2, blockquote') {
    if (!sel?.rangeCount) return null;
    const n = sel.anchorNode;
    const block = (n.nodeType === 3 ? n.parentNode : n).closest(selectors);
    if (block && block.id === 'd-text') return null;
    return block;
}

function toggleDisplay(el, condition) {
    if (el) el.style.display = condition ? '' : 'none';
}

function execCmd(cmd, val = null) {
    document.execCommand(cmd, false, val);
}

function normalizeTagInput(value) {
    if (Array.isArray(value)) {
        return value.map((tag) => String(tag || '').trim()).filter(Boolean);
    }

    return String(value || '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
}

export const Editor = {
    el: {},
    wrapper: null,
    newContainer: null,
    savedRange: null,
    currImg: null,
    activeRow: null,
    _vpHandler: null,
    _loadTimer: null,
    _scrollY: null,
    _mainContainer: null,
    _preventScroll: null,
    _savePromise: null,
    _sessionId: 0,
    _activeUploads: new Set(),
    _toolbarRaf: null,
    _imgToolbarRaf: null,
    _beforeUnloadHandler: null,
    _categoryOptionsLoaded: false,
    _subcategoryOptionsCache: new Map(),
    _openMode: '',
    _hiddenInlineNodes: [],
    _metaCollapsed: false,

    init() {
        const ids = [
            'toolbar', 'd-text', 'd-save', 'save-txt',
            'img-input', 'vid-input', 'btn-img', 'btn-vid', 'btn-hr', 'btn-color',
            'color-dropdown', 'img-toolbar',
            'n-title', 'n-category', 'n-subcategory', 'n-tags', 'n-date',
            'note-date-pill', 'note-date-text', 'category-options', 'subcategory-options',
            'btn-meta-toggle', 'note-meta-bar'
        ];

        ids.forEach((id) => {
            const element = Utils.$(id);
            if (element) {
                const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                this.el[key] = element;
            }
        });

        this.wrapper = Utils.$('editor-wrapper-dom');
        this.newContainer = Utils.$('editor-card');

        if (!this.wrapper || !this.newContainer || !this.el.dText || !this.el.toolbar) return;

        this._bindUnsavedGuard();
        this._bindContent();
        this._bindKeyboard();
        this._bindToolbar();
        this._bindColor();
        this._bindImage();
        this._bindVideo();
        this._bindMetaFields();
        this._bindUpload();

        if (this.el.dSave) {
            this.el.dSave.onclick = () => this.save();
        }
    },

    snapshot() {
        return JSON.stringify({
            title: this.el.nTitle?.value || '',
            category: this.el.nCategory?.value || '',
            subcategory: this.el.nSubcategory?.value || '',
            tags: this.el.nTags?.value || '',
            date: this.el.nDate?.value || '',
            content: this.el.dText?.innerHTML || ''
        });
    },

    async save() {
        if (this._savePromise) return this._savePromise;
        this._savePromise = this._doSave();
        try {
            return await this._savePromise;
        } finally {
            this._savePromise = null;
        }
    },

    async _doSave() {
        const { dText, dSave, nTitle, nCategory, nSubcategory, nTags, nDate } = this.el;
        if (!dText || !nTitle || !nCategory || !nSubcategory || !nDate) return false;

        if (!nTitle.value.trim()) {
            swalAlert('Title Required', 'Add a title before saving this note.', 'warning');
            return false;
        }

        if (!nCategory.value.trim() || !nSubcategory.value.trim()) {
            swalAlert('Folder Required', 'Choose both a major category and a minor category.', 'warning');
            return false;
        }

        if (!this.hasContent()) {
            swalAlert('Empty Note', 'Add a title or some content before saving.', 'warning');
            return false;
        }

        if (dSave) {
            dSave.classList.add('sending');
            dSave.disabled = true;
        }

        try {
            const result = await API.req('save', {
                id: State.editingId,
                title: nTitle.value,
                category: nCategory.value,
                subcategory: nSubcategory.value,
                tags: nTags?.value || '',
                date: nDate.value,
                content: dText.innerHTML
            }, 'POST');

            const savedNote = {
                id: String(result.id || State.editingId || ''),
                title: String(result.title || nTitle.value || '').trim(),
                category: String(result.category || nCategory.value || '').trim(),
                subcategory: String(result.subcategory || nSubcategory.value || '').trim(),
                tags: normalizeTagInput(result.tags ?? nTags?.value),
                createdAt: String(result.createdAt || ''),
                updatedAt: String(result.updatedAt || nDate.value || ''),
                content: typeof result.content === 'string' ? result.content : dText.innerHTML
            };

            dText.innerHTML = savedNote.content;
            nTitle.value = savedNote.title;
            nCategory.value = savedNote.category;
            nSubcategory.value = savedNote.subcategory;
            if (nTags) nTags.value = savedNote.tags.join(', ');
            this._updateMetaStatus(savedNote.updatedAt);

            this._categoryOptionsLoaded = false;
            this._subcategoryOptionsCache.clear();
            window.App?._invalidateSidebarCaches?.();
            window.App?.primeSavedNote?.(savedNote);
            State.originalSnapshot = this.snapshot();
            await this.close(true, { savedNote });

            window.App.route({
                view: 'note',
                category: savedNote.category,
                subcategory: savedNote.subcategory,
                note: savedNote.id,
                q: '',
                tag: '',
                page: 1
            });

            UI.setStatus('ok');
            setTimeout(() => UI.setStatus(''), 2000);
            return true;
        } catch (e) {
            if (e?.code !== 'UNAUTHORIZED') {
                swalAlert('Save Failed', e?.message || 'Unknown error', 'error');
            }
            return false;
        } finally {
            if (dSave) {
                dSave.classList.remove('sending');
                dSave.disabled = false;
            }
        }
    },

    _bindUnsavedGuard() {
        if (this._beforeUnloadHandler) return;
        this._beforeUnloadHandler = (e) => {
            if (
                this.wrapper.style.display !== 'none' &&
                this.hasContent() &&
                this.snapshot() !== State.originalSnapshot
            ) {
                e.preventDefault();
                e.returnValue = 'Unsaved changes';
                return 'Unsaved changes';
            }
            return undefined;
        };
        window.addEventListener('beforeunload', this._beforeUnloadHandler);
    },

    _bindContent() {
        const { dText } = this.el;
        if (!dText) return;

        dText.addEventListener('click', (e) => {
            if (e.target.tagName === 'IMG') {
                this.selectImg(e.target);
                e.stopPropagation();
            } else {
                this.deselectImg();
            }

            // Toggle checklist item on checkbox area click
            const li = e.target.closest('ul.checklist > li');
            if (li && e.offsetX < 28) {
                li.classList.toggle('checked');
                this._triggerInput();
                this._scheduleSyncToolbarState();
            }
        });

        this._triggerInput = () => {
            if (dText.oninput) dText.oninput();
        };

        dText.addEventListener('scroll', () => this._schedulePositionImgToolbar());
        dText.ondragover = (e) => e.preventDefault();

        const handleMediaFile = (e, files) => {
            const file = [...(files || [])].find((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
            if (file) {
                e.preventDefault();
                this._uploadAndInsertMedia(file, file.type.startsWith('image/') ? 'image' : 'video');
                return true;
            }
            return false;
        };

        dText.addEventListener('drop', (e) => handleMediaFile(e, e.dataTransfer?.files));

        dText.addEventListener('paste', (e) => {
            if (handleMediaFile(e, e.clipboardData?.files)) return;

            const html = e.clipboardData?.getData('text/html');
            const sanitizedHtml = sanitizePastedHtml(html);
            if (sanitizedHtml) {
                e.preventDefault();
                this.ensureFocus();
                execCmd('insertHTML', sanitizedHtml);
                this._triggerInput();
                return;
            }

            e.preventDefault();
            const text = e.clipboardData?.getData('text/plain') || '';
            execCmd('insertText', text);
        });

        dText.oninput = () => {
            this._scheduleSyncToolbarState();
            this.deselectImg();
        };
    },

    _bindKeyboard() {
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                if (this.wrapper && this.wrapper.style.display !== 'none') {
                    e.preventDefault();
                    if (!this._savePromise) this.save();
                }
            }
        });

        if (!this.el.dText) return;
        this.el.dText.onkeydown = (e) => {
            if (e.key === 'Backspace') this._handleBackspace(e);
            else if (e.key === 'Enter') this._handleEnter(e);
        };
    },

    _handleBackspace(e) {
        const sel = getSel();
        if (!sel.rangeCount || !sel.isCollapsed) return;
        const block = anchorBlock(sel);
        if (!block) return;

        const range = sel.getRangeAt(0);
        const preCaretRange = range.cloneRange();
        preCaretRange.selectNodeContents(block);
        preCaretRange.setEnd(range.startContainer, range.startOffset);

        if (preCaretRange.toString().length > 0) return;

        if (block.style.textAlign === 'center') {
            execCmd('justifyLeft');
            this._scheduleSyncToolbarState();
            e.preventDefault();
            return;
        }

        if (block.classList.contains('indent')) {
            block.classList.remove('indent');
            this._scheduleSyncToolbarState();
            this._triggerInput();
            e.preventDefault();
        }
    },

    _handleEnter() {
        const sel = getSel();
        if (!sel.rangeCount) return;

        const block = anchorBlock(sel, 'blockquote, h1, h2');
        if (block) {
            setTimeout(() => execCmd('formatBlock', 'p'), 0);
        }
        setTimeout(() => this._scheduleSyncToolbarState(), 0);
    },

    _handleToolbarAction(cmd, val) {
        switch (cmd) {
            case 'justifyCenter': {
                const parent = this.currImg?.parentElement;
                if (parent) {
                    parent.style.textAlign = parent.style.textAlign === 'center' ? 'left' : 'center';
                    this._schedulePositionImgToolbar();
                    this._triggerInput();
                    return;
                }
                const isCentered = document.queryCommandState('justifyCenter');
                execCmd(isCentered ? 'justifyLeft' : 'justifyCenter');
                break;
            }
            case 'justifyFull': {
                const isJustified = document.queryCommandState('justifyFull');
                execCmd(isJustified ? 'justifyLeft' : 'justifyFull');
                break;
            }
            case 'indentClass': {
                const sel = getSel();
                if (!sel.rangeCount) return;

                const { dText } = this.el;
                let targets = [];

                if (sel.isCollapsed) {
                    // Collapsed cursor: only indent the single block containing the caret
                    let block = anchorBlock(sel);
                    if (!block) {
                        // Bare text node directly in editor — wrap it in <p> first
                        execCmd('formatBlock', 'p');
                        // Re-acquire after formatting
                        block = anchorBlock(getSel());
                        if (!block) {
                            // Last resort: find the <p> the cursor is now in
                            const anchor = getSel().anchorNode;
                            const el = anchor?.nodeType === 3 ? anchor.parentNode : anchor;
                            if (el && el !== dText && dText.contains(el)) {
                                block = el.closest('p, div, h1, h2, blockquote');
                                if (block === dText) block = null;
                            }
                        }
                    }
                    if (block) targets = [block];
                } else {
                    // Range selection: indent all blocks the selection touches
                    targets = Array.from(dText.querySelectorAll('p, div, h1, h2, blockquote'))
                        .filter((b) => sel.containsNode(b, true));
                    if (!targets.length) {
                        const fallbackBlock = anchorBlock(sel);
                        if (fallbackBlock) targets = [fallbackBlock];
                    }
                }

                if (targets.length) {
                    const shouldIndent = targets.some((b) => !b.classList.contains('indent'));
                    targets.forEach((b) => b.classList.toggle('indent', shouldIndent));
                    this._triggerInput();
                }
                break;
            }
            case 'insertChecklist': {
                const isInChecklist = !!anchorBlock(getSel(), 'ul.checklist');
                if (isInChecklist) {
                    // Remove checklist: convert back to normal paragraphs
                    const cl = anchorBlock(getSel(), 'ul.checklist');
                    if (cl) {
                        const frag = document.createDocumentFragment();
                        Array.from(cl.children).forEach((li) => {
                            const p = document.createElement('p');
                            p.innerHTML = li.innerHTML;
                            frag.appendChild(p);
                        });
                        cl.replaceWith(frag);
                    }
                } else {
                    // If in a regular UL, convert it to checklist
                    const existingUl = anchorBlock(getSel(), 'ul');
                    if (existingUl && !existingUl.classList.contains('checklist')) {
                        existingUl.classList.add('checklist');
                    } else {
                        // Create new checklist from current line
                        execCmd('insertUnorderedList');
                        const ul = anchorBlock(getSel(), 'ul');
                        if (ul) ul.classList.add('checklist');
                    }
                }
                this._triggerInput();
                break;
            }
            case 'formatBlock': {
                const current = document.queryCommandValue('formatBlock');
                const isSame = current && current.toLowerCase() === val.toLowerCase();
                execCmd('formatBlock', isSame ? 'p' : val);
                break;
            }
            default:
                execCmd(cmd, val);
        }
    },

    _bindToolbar() {
        const { toolbar, dText, btnHr } = this.el;
        if (!toolbar || !dText) return;

        const IGNORED_BTNS = ['btn-img', 'btn-vid', 'btn-color', 'btn-hr'];

        // More-trigger: toggle on click/touch for mobile, with dynamic positioning
        const moreWrapper = toolbar.querySelector('.tb-more-wrapper');
        const moreTrigger = toolbar.querySelector('.tb-more-trigger');
        const morePanel = toolbar.querySelector('.tb-more-panel');
        if (moreTrigger && moreWrapper && morePanel) {
            const positionPanel = () => {
                // Reset to default (right-side)
                morePanel.style.left = '100%';
                morePanel.style.right = 'auto';
                morePanel.style.paddingLeft = '6px';
                morePanel.style.paddingRight = '0';

                requestAnimationFrame(() => {
                    const panelRect = morePanel.getBoundingClientRect();
                    const viewportWidth = window.innerWidth;

                    if (panelRect.right > viewportWidth - 4) {
                        // Not enough space on right — flip to left
                        morePanel.style.left = 'auto';
                        morePanel.style.right = '100%';
                        morePanel.style.paddingLeft = '0';
                        morePanel.style.paddingRight = '6px';
                    }
                });
            };

            moreTrigger.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const isOpen = moreWrapper.classList.toggle('open');
                if (isOpen) positionPanel();
            });

            // Also position on hover for desktop
            moreWrapper.addEventListener('mouseenter', positionPanel);

            document.addEventListener('mousedown', (e) => {
                if (!moreWrapper.contains(e.target)) {
                    moreWrapper.classList.remove('open');
                }
            });
        }

        toolbar.onmousedown = (e) => {
            if (e.target.closest('.tb-more-trigger')) return;
            const btn = e.target.closest('.tb-btn');
            if (!btn || IGNORED_BTNS.includes(btn.id)) return;

            e.preventDefault();
            this.ensureFocus();

            this._handleToolbarAction(btn.dataset.cmd, btn.dataset.val);
            setTimeout(() => this._scheduleSyncToolbarState(), 0);
        };

        toolbar.addEventListener('click', () => setTimeout(() => this._schedulePositionImgToolbar(), 10));

        if (btnHr) {
            btnHr.onclick = () => {
                this.ensureFocus();
                execCmd('insertHTML', '<hr contenteditable="false"><p><br></p>');
            };
        }
    },

    _bindColor() {
        const { btnColor, colorDropdown } = this.el;
        if (!btnColor || !colorDropdown) return;

        btnColor.onmousedown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.ensureFocus();
            const sel = getSel();
            this.savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
            colorDropdown.classList.toggle('show');
        };

        colorDropdown.onmousedown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const opt = e.target.closest('.color-option');
            if (!opt) return;

            if (this.savedRange) {
                const s = getSel();
                s.removeAllRanges();
                s.addRange(this.savedRange);
            }
            execCmd('foreColor', opt.dataset.color);
            colorDropdown.classList.remove('show');
        };

        document.addEventListener('mousedown', (e) => {
            if (!e.target.closest('.color-picker-wrapper')) {
                colorDropdown.classList.remove('show');
            }
        });
    },

    _bindImage() {
        const { btnImg, imgInput, imgToolbar } = this.el;
        if (!btnImg || !imgInput || !imgToolbar) return;

        btnImg.onclick = () => imgInput.click();

        imgToolbar.addEventListener('click', (e) => {
            if (e.target.classList.contains('it-btn') && this.currImg) {
                e.preventDefault();
                e.stopPropagation();
                this.currImg.style.width = e.target.dataset.w + '%';
                this._schedulePositionImgToolbar();
                this._triggerInput();
            }
        });
    },

    _bindVideo() {
        const { btnVid, vidInput } = this.el;
        if (!btnVid || !vidInput) return;
        btnVid.onclick = () => vidInput.click();
    },

    _bindMetaFields() {
        const { nTitle, nCategory, nSubcategory, nTags, nDate, noteDatePill, btnMetaToggle } = this.el;
        [nTitle, nCategory, nSubcategory, nTags, nDate].forEach((input) => {
            if (!input) return;
            input.addEventListener('input', () => this._triggerInput?.());
        });

        if (nCategory) {
            nCategory.addEventListener('input', () => {
                this._loadSubcategoryOptions(nCategory.value, this.el.nSubcategory?.value || '');
            });
        }

        if (noteDatePill && nDate) {
            noteDatePill.addEventListener('click', () => {
                try {
                    nDate.showPicker?.();
                } catch {
                    // Ignore browsers without showPicker.
                }
                nDate.focus({ preventScroll: true });
            });

            nDate.addEventListener('change', () => {
                this._updateMetaStatus(nDate.value);
                this._triggerInput?.();
            });
        }

        if (btnMetaToggle) {
            btnMetaToggle.addEventListener('click', () => {
                this._setMetaCollapsed(!this._metaCollapsed);
            });
            this._setMetaCollapsed(false);
        }
    },

    _setMetaCollapsed(collapsed) {
        this._metaCollapsed = !!collapsed;

        if (this.el.noteMetaBar) {
            this.el.noteMetaBar.classList.toggle('collapsed', this._metaCollapsed);
        }

        if (this.el.btnMetaToggle) {
            this.el.btnMetaToggle.dataset.state = this._metaCollapsed ? 'collapsed' : 'expanded';
            this.el.btnMetaToggle.setAttribute('aria-label', this._metaCollapsed ? 'Show note details' : 'Hide note details');
        }
    },

    _bindUpload() {
        const { imgInput, vidInput } = this.el;

        const attachUpload = (inputElem, type) => {
            if (!inputElem) return;
            inputElem.onchange = () => {
                const file = inputElem.files[0];
                if (file) this._uploadAndInsertMedia(file, type);
                inputElem.value = '';
            };
        };

        attachUpload(imgInput, 'image');
        attachUpload(vidInput, 'video');
    },

    _populateDatalist(listEl, values) {
        if (!listEl) return;
        listEl.innerHTML = (values || [])
            .filter(Boolean)
            .map((value) => `<option value="${String(value)
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')}"></option>`)
            .join('');
    },

    _loadCategoryOptions() {
        if (this._categoryOptionsLoaded) return;
        const tree = window.App?._folderTreeCache;
        if (!Array.isArray(tree)) return;
        const categories = tree
            .map((row) => String(row?.category || '').trim())
            .filter(Boolean);
        this._populateDatalist(this.el.categoryOptions, categories);
        this._categoryOptionsLoaded = true;
    },

    _primeOptionLists(sessionId, category, preferred = '') {
        this._loadCategoryOptions();
        if (sessionId !== this._sessionId) return;
        this._loadSubcategoryOptions(category, preferred);
    },

    _loadSubcategoryOptions(category, preferred = '') {
        const safeCategory = String(category || '').trim();
        if (!safeCategory) {
            this._populateDatalist(this.el.subcategoryOptions, []);
            return;
        }

        const cached = this._subcategoryOptionsCache.get(safeCategory);
        if (cached) {
            if (String(this.el.nCategory?.value || '').trim() === safeCategory) {
                this._populateDatalist(this.el.subcategoryOptions, cached);
                if (preferred && this.el.nSubcategory) this.el.nSubcategory.value = preferred;
            }
            return;
        }

        const tree = window.App?._folderTreeCache;
        if (!Array.isArray(tree)) return;
        const match = tree.find((row) => String(row?.category || '').trim() === safeCategory);
        const subcategories = (match?.subfolders || [])
            .map((sub) => String(sub?.subcategory || '').trim())
            .filter(Boolean);
        this._subcategoryOptionsCache.set(safeCategory, subcategories);
        if (String(this.el.nCategory?.value || '').trim() === safeCategory) {
            this._populateDatalist(this.el.subcategoryOptions, subcategories);
            if (preferred && this.el.nSubcategory) this.el.nSubcategory.value = preferred;
        }
    },

    _updateMetaStatus(dateValue) {
        const dateTextEl = this.el.noteDateText;
        const dateInputEl = this.el.nDate;
        if (!dateTextEl || !dateInputEl) return;

        const fallbackDate = new Date().toISOString().slice(0, 10);
        const normalized = String(dateValue || '').slice(0, 10);
        const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : fallbackDate;

        dateInputEl.value = safeDate;
        dateTextEl.textContent = safeDate;
    },

    selectImg(img) {
        if (this.currImg === img) return;
        this.deselectImg();
        this.currImg = img;
        img.classList.add('img-selected');

        if (this.el.imgToolbar) this.el.imgToolbar.classList.add('show');

        const parent = img.parentElement;
        if (parent) {
            Utils.$('btn-center')?.classList.toggle('active', parent.style.textAlign === 'center');
        }
        this._schedulePositionImgToolbar();
    },

    deselectImg() {
        if (!this.currImg) return;
        this.currImg.classList.remove('img-selected');
        this.currImg = null;
        if (this.el.imgToolbar) this.el.imgToolbar.classList.remove('show');
    },

    ensureFocus() {
        const { dText } = this.el;
        if (!dText) return;

        const sel = getSel();
        if (sel.rangeCount && dText.contains(sel.anchorNode)) {
            this._scheduleSyncToolbarState();
            return;
        }

        dText.focus();
        const r = document.createRange();
        r.selectNodeContents(dText);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        this._scheduleSyncToolbarState();
    },

    hasContent() {
        const { dText, nTitle } = this.el;
        if (!dText || !nTitle) return false;
        return (
            nTitle.value.trim().length > 0 ||
            dText.innerText.trim().length > 0 ||
            !!dText.querySelector('img') ||
            !!dText.querySelector('video')
        );
    },

    _positionImgToolbar() {
        if (!this.currImg || !this.wrapper || !this.el.imgToolbar) return;
        const er = this.wrapper.getBoundingClientRect();
        const ir = this.currImg.getBoundingClientRect();
        this.el.imgToolbar.style.top = `${ir.bottom - er.top - 50}px`;
        this.el.imgToolbar.style.left = `${(ir.left + ir.width / 2) - er.left}px`;
    },

    _schedulePositionImgToolbar() {
        if (this._imgToolbarRaf) return;
        this._imgToolbarRaf = requestAnimationFrame(() => {
            this._imgToolbarRaf = null;
            this._positionImgToolbar();
        });
    },

    _syncToolbarState() {
        const { toolbar } = this.el;
        if (!toolbar) return;

        const CUSTOM_CMDS = ['indentClass', 'justifyCenter', 'insertChecklist'];

        toolbar.querySelectorAll('.tb-btn[data-cmd]').forEach((btn) => {
            const cmd = btn.dataset.cmd;
            if (cmd && !CUSTOM_CMDS.includes(cmd)) {
                try {
                    btn.classList.toggle('active', document.queryCommandState(cmd));
                } catch {
                    // Some mobile browsers throw for unsupported queries.
                }
            }
        });

        const block = anchorBlock(getSel());
        let isCentered = this.currImg?.parentElement?.style.textAlign === 'center'
            || document.queryCommandState('justifyCenter');

        if (block && block.style.textAlign === 'center') isCentered = true;

        Utils.$('btn-center')?.classList.toggle('active', isCentered);
        toolbar.querySelector('[data-cmd="indentClass"]')?.classList.toggle('active', !!block?.classList.contains('indent'));

        // Checklist state
        const inChecklist = !!anchorBlock(getSel(), 'ul.checklist');
        Utils.$('btn-checklist')?.classList.toggle('active', inChecklist);
    },

    _scheduleSyncToolbarState() {
        if (this._toolbarRaf) return;
        this._toolbarRaf = requestAnimationFrame(() => {
            this._toolbarRaf = null;
            this._syncToolbarState();
        });
    },

    async open(mode, data = {}, anchorEl) {
        this._sessionId += 1;
        const sessionId = this._sessionId;
        this._setupMobileContext();

        const { dText, nTitle, nCategory, nSubcategory, nTags } = this.el;
        if (!dText || !nTitle || !nCategory || !nSubcategory || !nTags || !this.wrapper) return;

        this.wrapper.style.display = 'flex';
        dText.innerHTML = data.content || '';
        nTitle.value = data.title || '';
        nCategory.value = data.category || '';
        nSubcategory.value = data.subcategory || '';
        nTags.value = Array.isArray(data.tags) ? data.tags.join(', ') : (data.tags || '');
        this._setMetaCollapsed(false);
        this._updateMetaStatus(data.updatedAt);

        if (mode === 'new') {
            this._openNew();
        } else {
            this._openExisting(data, anchorEl);
        }

        State.originalSnapshot = this.snapshot();
        this._primeOptionLists(sessionId, nCategory.value, nSubcategory.value);

        requestAnimationFrame(() => {
            if (sessionId !== this._sessionId) return;
            if (mode === 'new') {
                nTitle.focus({ preventScroll: true });
                Array.from(this.el.toolbar.querySelectorAll('.active')).forEach((b) => b.classList.remove('active'));
            } else {
                this.ensureFocus();
            }
        });
    },

    _setupMobileContext() {
        if (window.innerWidth > 600) return;

        this.wrapper.classList.add('editor-fullscreen', 'editor-loading');
        this._scrollY = window.scrollY;

        this._mainContainer = document.querySelector('.d-container');
        toggleDisplay(this._mainContainer, false);

        this._startViewportSync();
        document.body.appendChild(this.wrapper);

        this._preventScroll = (e) => {
            if (!e.target.closest('.editor-box')) e.preventDefault();
        };
        document.addEventListener('touchmove', this._preventScroll, { passive: false });
    },

    _openNew() {
        const { saveTxt } = this.el;
        State.editingId = null;
        this._openMode = 'new';
        if (saveTxt) saveTxt.innerText = 'SAVE';

        this.wrapper.classList.add('editor-in-new');
        this.newContainer.style.display = 'block';

        // Hide the notes list card so the editor takes over the full panel
        const mainCard = this.newContainer.parentElement?.querySelector('.main-card');
        if (mainCard) mainCard.style.display = 'none';

        if (window.innerWidth > 600) {
            this.newContainer.appendChild(this.wrapper);
        }
    },

    _openExisting(data, anchorEl) {
        State.editingId = data.id;
        this._openMode = anchorEl ? 'inline-edit' : 'standalone-edit';
        if (this.el.saveTxt) this.el.saveTxt.innerText = 'SAVE';
        this.activeRow = anchorEl;

        if (!this.activeRow) {
            this.newContainer.style.display = 'block';
            // Hide the notes list card so the editor takes over the full panel
            const mainCard = this.newContainer.parentElement?.querySelector('.main-card');
            if (mainCard) mainCard.style.display = 'none';
            if (window.innerWidth > 600) {
                this.newContainer.appendChild(this.wrapper);
                this.newContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            return;
        }

        this.activeRow.classList.add('editing-inline');
        this._hiddenInlineNodes = this._collectInlineNodes(this.activeRow);
        this._hiddenInlineNodes.forEach((node) => toggleDisplay(node, false));

        if (window.innerWidth > 600) {
            this.wrapper.classList.add('editor-in-card');
            this.activeRow.appendChild(this.wrapper);
        }
    },

    async close(force, options = {}) {
        if (!this.wrapper || this.wrapper.style.display === 'none') return true;

        this.deselectImg();
        const changed = this.snapshot() !== State.originalSnapshot;
        const openMode = this._openMode;

        if (!force && this.hasContent() && changed) {
            const savedOrDiscarded = await swalUnsaved(() => this.save());
            if (savedOrDiscarded === false) return false;
            if (savedOrDiscarded === true && this.snapshot() === State.originalSnapshot) return true;
        }

        this._cleanupContext();
        this.newContainer.appendChild(this.wrapper);

        if (openMode === 'new' || openMode === 'standalone-edit') {
            this._restoreNewView();
        } else if (openMode === 'inline-edit' && this.activeRow) {
            this._applySavedNoteToActiveRow(options.savedNote);
            this._restoreExistingView();
        }

        State.editingId = null;
        State.originalSnapshot = '';
        this._openMode = '';
        return true;
    },

    _cleanupContext() {
        this.el.dText.innerHTML = '';
        this.wrapper.style.display = 'none';
        this.wrapper.classList.remove('editor-fullscreen', 'editor-loading', 'editor-in-card', 'editor-in-new');

        if (this.el.nTitle) this.el.nTitle.value = '';
        if (this.el.nCategory) this.el.nCategory.value = '';
        if (this.el.nSubcategory) this.el.nSubcategory.value = '';
        if (this.el.nTags) this.el.nTags.value = '';
        this._setMetaCollapsed(false);
        this._updateMetaStatus('');

        this._sessionId += 1;
        this._activeUploads.forEach((xhr) => xhr.abort());
        this._activeUploads.clear();

        if (this._toolbarRaf) {
            cancelAnimationFrame(this._toolbarRaf);
            this._toolbarRaf = null;
        }
        if (this._imgToolbarRaf) {
            cancelAnimationFrame(this._imgToolbarRaf);
            this._imgToolbarRaf = null;
        }
        if (this._loadTimer) clearTimeout(this._loadTimer);

        if (this._mainContainer) {
            toggleDisplay(this._mainContainer, true);
            this._mainContainer = null;
        }
        if (this._scrollY != null) {
            window.scrollTo(0, this._scrollY);
            this._scrollY = null;
        }

        this._stopViewportSync();
        if (this._preventScroll) {
            document.removeEventListener('touchmove', this._preventScroll);
            this._preventScroll = null;
        }
    },

    _restoreNewView() {
        this.newContainer.style.display = 'none';
        // Restore the notes list card visibility
        const mainCard = this.newContainer.parentElement?.querySelector('.main-card');
        if (mainCard) mainCard.style.display = '';
    },

    _restoreExistingView() {
        this.activeRow.classList.remove('editing-inline');
        if (this.activeRow.classList.contains('d-item')) {
            toggleDisplay(this.activeRow.querySelector(SEL.header), true);
            const textEl = this.activeRow.querySelector(SEL.text);
            toggleDisplay(textEl, true);
            toggleDisplay(this.activeRow.querySelector(SEL.actions), true);

            const readMore = this.activeRow.querySelector(SEL.readMore);
            toggleDisplay(readMore, textEl?.classList.contains('content-folded'));
        } else {
            this._hiddenInlineNodes.forEach((node) => toggleDisplay(node, true));
        }
        this._hiddenInlineNodes = [];
        this.activeRow = null;
    },

    _applySavedNoteToActiveRow(note) {
        if (!note || !this.activeRow?.classList.contains('note-detail-shell')) return;

        const renderNoteDetail = window.App?._renderNoteDetail;
        if (typeof renderNoteDetail !== 'function') return;

        const temp = document.createElement('div');
        temp.innerHTML = renderNoteDetail.call(window.App, note);
        const nextRow = temp.firstElementChild;
        if (!nextRow) return;

        const replaceSection = (selector) => {
            const currentNode = this.activeRow.querySelector(selector);
            const nextNode = nextRow.querySelector(selector);

            if (currentNode && nextNode) {
                currentNode.replaceWith(nextNode);
                return;
            }

            if (currentNode && !nextNode) {
                currentNode.remove();
                return;
            }

            if (!currentNode && nextNode) {
                this.activeRow.appendChild(nextNode);
            }
        };

        replaceSection('.note-detail-header');
        replaceSection('.note-detail-body');
        replaceSection('.note-detail-footer');
    },

    _collectInlineNodes(row) {
        if (!row) return [];

        const selectors = row.classList.contains('note-detail-shell')
            ? ['.note-detail-header', '.note-detail-body', '.note-detail-footer']
            : row.classList.contains('archive-row')
                ? ['.archive-track', '.archive-title', '.archive-tags', '.archive-date', '.archive-actions']
                : [SEL.header, SEL.text, SEL.actions, SEL.readMore];

        return selectors
            .map((selector) => row.querySelector(selector))
            .filter(Boolean);
    },

    _startViewportSync() {
        if (!window.visualViewport) return;
        this._vpHandler = () => {
            const vv = window.visualViewport;
            requestAnimationFrame(() => {
                this.wrapper.style.height = `${vv.height}px`;
                this.wrapper.style.top = `${vv.offsetTop}px`;
            });
            if (this.wrapper.classList.contains('editor-loading')) {
                if (this._loadTimer) clearTimeout(this._loadTimer);
                this._loadTimer = setTimeout(() => {
                    this.wrapper.classList.remove('editor-loading');
                }, 150);
            }
        };
        this._vpHandler();
        window.visualViewport.addEventListener('resize', this._vpHandler);
        window.visualViewport.addEventListener('scroll', this._vpHandler);
    },

    _stopViewportSync() {
        if (this._vpHandler && window.visualViewport) {
            window.visualViewport.removeEventListener('resize', this._vpHandler);
            window.visualViewport.removeEventListener('scroll', this._vpHandler);
        }
        this._vpHandler = null;
        this.wrapper.style.height = '';
        this.wrapper.style.top = '';
    },

    _uploadAndInsertMedia(file, type) {
        const sessionId = this._sessionId;
        const xhr = Upload.file(file, this.wrapper, (url) => {
            if (sessionId !== this._sessionId || !this.wrapper || this.wrapper.style.display === 'none') return;
            if (!/^\/(img|video)\//.test(url)) return;

            this.ensureFocus();
            if (type === 'video') {
                execCmd('insertHTML', `<video src="${url}" controls preload="metadata"></video><p><br></p>`);
            } else {
                execCmd('insertHTML', `<img src="${url}" loading="lazy" />`);
            }
            this._triggerInput();
        }, () => {
            this._activeUploads.delete(xhr);
        });
        if (xhr) this._activeUploads.add(xhr);
    }
};
