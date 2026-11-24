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

  async function sha256(s) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  // Change the site password, for the whole site, from inside the app. The person
  // doing it is already signed in (window.GATHER_KEY), so we only ask for the new
  // one, twice. The server stores it and every device is asked for it next time.
  function changePassword(toast) {
    if (changePassword._open) return;
    const cfg = window.GATHER_CONFIG || {};
    const wrap = document.createElement('div');
    wrap.className = 'lkdlg';
    changePassword._open = true;
    wrap.innerHTML =
      '<form class="lkdlg-card" autocomplete="off">' +
      '<h3>Change the site password</h3>' +
      '<p>This is the password everyone types to get into Gather. Everyone signed in now will be asked for the new one once.</p>' +
      '<input type="password" id="np1" placeholder="New password" autocapitalize="off" autocorrect="off" spellcheck="false">' +
      '<input type="password" id="np2" placeholder="Type it again" autocapitalize="off" autocorrect="off" spellcheck="false">' +
      '<div class="lkdlg-err" id="npErr"></div>' +
      '<div class="lkdlg-row"><button type="button" class="btn lkdlg-cancel">Cancel</button><button type="submit" class="btn primary lkdlg-ok">Change password</button></div>' +
      '</form>';
    document.body.appendChild(wrap);
    const close = () => { wrap.remove(); changePassword._open = false; };
    const err = wrap.querySelector('#npErr'), p1 = wrap.querySelector('#np1'), p2 = wrap.querySelector('#np2'), ok = wrap.querySelector('.lkdlg-ok');
    setTimeout(() => p1.focus(), 30);
    wrap.querySelector('.lkdlg-cancel').addEventListener('click', close);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
    wrap.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const a = p1.value, b = p2.value;
      if (a.trim().length < 3) { err.textContent = 'Pick a password of at least 3 characters.'; return; }
      if (a !== b) { err.textContent = 'The two passwords do not match.'; p2.select(); return; }
      ok.disabled = true; err.textContent = '';
      try {
        const r = await fetch((cfg.RTC_ENDPOINT || '') + '/auth/password', {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: cfg.SUPABASE_KEY || '', 'x-gather-key': window.GATHER_KEY || '' },
          body: JSON.stringify({ password: a })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error((d && d.errorDescription) || ('Something went wrong (' + r.status + ')'));
        // Keep this device signed in with the new password.
        window.GATHER_KEY = a;
        try { localStorage.setItem('gather.key', a); } catch {}
        try { localStorage.setItem('gather.sitehash', d.hash || await sha256(a)); } catch {}
        close();
        if (toast) toast('Password changed'); else alert('The site password has been changed.');
      } catch (ex) { ok.disabled = false; err.textContent = 'Could not change it: ' + ex.message; }
    });
  }

  window.GatherUI = { copy, copyBox: box, changePassword };
})();
