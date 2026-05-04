import { getBlockFromRange } from './dom.js';

function isAtBlockStart(range, block) {
    const r = range.cloneRange();
    r.selectNodeContents(block);
    r.setEnd(range.startContainer, range.startOffset);
    return r.toString().length === 0;
}

export const IndentPlugin = {
    init(sq) {
        const origBackspace = sq._keyHandlers['Backspace'];
        sq.setKeyHandler('Backspace', (editor, event, range) => {
            if (range.collapsed) {
                const block = getBlockFromRange(range, editor.getRoot());
                if (block && block.classList.contains('indent') && isAtBlockStart(range, block)) {
                    event.preventDefault();
                    editor.saveUndoState(range);
                    block.classList.remove('indent');
                    editor._docWasChanged();
                    return;
                }
            }
            if (origBackspace) origBackspace(editor, event, range);
        });
    },

    toggle(sq) {
        sq.saveUndoState(sq.getSelection());
        const shouldIndent = !this.isActive(sq);
        sq.forEachBlock((block) => {
            block.classList.toggle('indent', shouldIndent);
        }, true);
        sq.focus();
    },

    isActive(sq) {
        const path = sq.getPath();
        return /\.indent(?:\.|>|\[|$)/.test(path);
    }
};
