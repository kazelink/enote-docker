import { Utils, State, RI_SVGS, loadScript } from './dom.js';


const AUTH_ARROW_SVG = '<svg viewBox="0 0 24 24"><path d="M16.172 11l-5.364-5.364 1.414-1.414L20 12l-7.778 7.778-1.414-1.414L16.172 13H4v-2z"></path></svg>';

const STATUS_ICONS = {
    loading: RI_SVGS.loader,
    ok: '<i class="ri-check-line"></i>',
    err: '<i class="ri-close-line" style="color:var(--danger)"></i>'
};

function resetAuthUi() {
    const authForm = Utils.$('auth-form');
    const authBtn = authForm?.querySelector('.auth-btn');
    const authMsg = Utils.$('auth-messages');

    if (authMsg) authMsg.innerHTML = '';
    if (authBtn) {
        authBtn.innerHTML = AUTH_ARROW_SVG;
        authBtn.style.removeProperty('background');
    }
}

async function showFancybox(items, options = {}) {
    try {
        await loadScript('/assets/fancybox.umd.js');
        if (typeof Fancybox !== 'undefined') {
            Fancybox.show(items, { showClass: false, Hash: false, ...options });
        }
    } catch (err) {
        console.error('Failed to load Fancybox:', err);
    }
}

function handleMediaClick(target, container) {
    if (target.tagName === 'IMG') {
        const imgs = Array.from(container.querySelectorAll('img'));
        const start = Math.max(0, imgs.indexOf(target));
        const gallery = imgs.map((img) => ({ src: img.src, type: 'image' }));

        showFancybox(gallery, {
            startIndex: start,
            Carousel: { initialSlide: start },
            Images: { Panzoom: { maxScale: 4 } },
            Thumbs: { type: 'modern' },
            wheel: 'zoom'
        });
    } else if (target.tagName === 'VIDEO') {
        target.pause();
        showFancybox([{ src: target.src, type: 'html5video' }]);
    }
}

function appendCrumb(container, label, onClick) {
    const crumb = document.createElement('span');
    crumb.className = 'breadcrumb-item';
    crumb.textContent = label;
    if (onClick) {
        crumb.classList.add('clickable');
        crumb.addEventListener('click', onClick);
    }
    container.appendChild(crumb);
}

function appendDivider(container) {
    const divider = document.createElement('span');
    divider.className = 'breadcrumb-divider';
    divider.textContent = '/';
    container.appendChild(divider);
}

export const UI = {
    setStatus(mode) {
        const statusEl = Utils.$('sync-stat');
        if (!statusEl) return;

        statusEl.className = `sync-stat active ${mode === 'ok' ? 'success' : ''}`.trim();
        statusEl.innerHTML = STATUS_ICONS[mode] || '';
    },

    renderBreadcrumb() {
        const titleEl = Utils.$('c-title-box');
        if (!titleEl) return;
        const currentNote = window.App?._currentNote;
        const notePathHint = window.App?._notePathHint || null;
        const noteCategory = State.view === 'note' && !State.category
            ? String(currentNote?.category || notePathHint?.category || '')
            : String(State.category || '');
        const noteSubcategory = State.view === 'note' && !State.subcategory
            ? String(currentNote?.subcategory || notePathHint?.subcategory || '')
            : String(State.subcategory || '');

        if (State.view === 'backup') {
            titleEl.textContent = 'BACKUP';
            return;
        }

        titleEl.innerHTML = '';
        if (State.view === 'index') {
            appendCrumb(titleEl, 'NOTES', () => window.App?.route({
                view: 'index',
                category: '',
                subcategory: '',
                note: '',
                q: '',
                tag: '',
                page: 1
            }));
            return;
        }

        if ((State.view === 'list' || State.view === 'note') && !noteCategory && !noteSubcategory) {
            appendCrumb(titleEl, State.q || State.tag ? 'SEARCH' : 'LIBRARY', null);
            return;
        }

        if (noteCategory) {
            appendCrumb(titleEl, noteCategory, (State.view === 'list' || State.view === 'note')
                ? () => window.App?.route({
                    view: 'category',
                    category: noteCategory,
                    subcategory: '',
                    note: '',
                    q: '',
                    tag: '',
                    page: 1
                })
                : null);
        }

        if (noteSubcategory) {
            if (titleEl.childNodes.length) appendDivider(titleEl);
            appendCrumb(titleEl, noteSubcategory, (State.view === 'list' || State.view === 'note')
                ? () => window.App?.route({
                    view: 'list',
                    category: noteCategory,
                    subcategory: noteSubcategory,
                    note: '',
                    q: '',
                    tag: '',
                    page: 1
                })
                : null);
        }
    },

    showAuth() {
        const overlay = Utils.$('auth-overlay');
        if (!overlay) return;

        overlay.classList.add('active');
        resetAuthUi();

        const inputEl = Utils.$('auth-input');
        if (inputEl) {
            inputEl.value = '';
            // Immediate focus attempt
            inputEl.focus({ preventScroll: true });

            // Native event-driven focus when transition completes
            const focusOnReady = (e) => {
                if (e.propertyName === 'opacity') {
                    inputEl.focus({ preventScroll: true });
                }
            };
            overlay.addEventListener('transitionend', focusOnReady, { once: true });
        }
    },

    hideAuth() {
        const overlay = Utils.$('auth-overlay');
        if (overlay) overlay.classList.remove('active');
    },

    initGlobalEvents() {
        document.addEventListener('click', (e) => {
            const dcText = e.target.closest('.dc-text');
            if (!dcText) return;

            const isMedia = e.target.tagName === 'IMG' || e.target.tagName === 'VIDEO';
            if (isMedia) {
                e.preventDefault();
                handleMediaClick(e.target, dcText);
            }
        });
    }
};
