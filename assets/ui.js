/* Gather – tiny shared UI helpers.
 *
 * copy(text, note): copy to the clipboard, or, when that is blocked (the desktop
 * app in some states, older browsers), show an in-page box with the text ready
 * to select — never window.prompt, which the Electron apps don't support.
 */
(() => {
  'use strict';
  function box(text) {
    const wrap = document.createElement('div');
    wrap.className = 'lkdlg';
    wrap.innerHTML = '<div class="lkdlg-card"><h3>Copy this</h3><textarea rows="3" readonly></textarea><div class="lkdlg-row"><button type="button" class="btn primary">Done</button></div></div>';
    wrap.querySelector('textarea').value = text;
    document.body.appendChild(wrap);
    const ta = wrap.querySelector('textarea');
    setTimeout(() => { ta.focus(); ta.select(); }, 30);
    const close = () => wrap.remove();
    wrap.querySelector('button').addEventListener('click', close);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  }
  async function copy(text, note, toast) {
    try {
      await navigator.clipboard.writeText(text);
      if (toast) toast(note || 'Copied');
      return true;
    } catch { box(text); return false; }
  }
  window.GatherUI = { copy, copyBox: box };
})();
