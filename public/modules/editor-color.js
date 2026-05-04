export const ColorPlugin = {
    sq: null,
    _btnColor: null,
    _dropdown: null,
    _docHandler: null,

    init(sq, btnColor, dropdown) {
        this.sq = sq;
        this._btnColor = btnColor;
        this._dropdown = dropdown;

        if (!btnColor || !dropdown) return;

        btnColor.onmousedown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            sq.focus();
            dropdown.classList.toggle('show');
        };

        dropdown.onmousedown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const opt = e.target.closest('.color-option');
            if (!opt) return;
            sq.setTextColor(opt.dataset.color);
            dropdown.classList.remove('show');
        };

        if (this._docHandler) document.removeEventListener('mousedown', this._docHandler);
        this._docHandler = (e) => {
            if (!e.target.closest('.color-picker-wrapper')) {
                dropdown.classList.remove('show');
            }
        };
        document.addEventListener('mousedown', this._docHandler);
    }
};
