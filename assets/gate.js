/* Gather – password gate.
 * Every page loads this first. The password is asked for once per device and
 * kept in localStorage; the call server checks the same password on every
 * request, so the pages alone are not the lock.
 */
(() => {
  'use strict';
  const cfg = window.GATHER_CONFIG || {};
  const KEY = 'gather.key';
  const saved = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
  window.GATHER_KEY = saved();

  async function sha256(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const ready = new Promise(resolve => {
    const done = key => { window.GATHER_KEY = key; try { localStorage.setItem(KEY, key); } catch {} resolve(key); };
    const start = async () => {
      if (!cfg.PASSWORD_HASH || !crypto.subtle) return resolve(window.GATHER_KEY);
      const have = saved();
      if (have && await sha256(have) === cfg.PASSWORD_HASH) return resolve(have);
      showGate(done);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  });
  window.GATHER_READY = ready;

  function showGate(done) {
    const wrap = document.createElement('div');
    wrap.id = 'gate';
    wrap.innerHTML =
      '<form class="gate-card" autocomplete="off">' +
      '<svg class="mark" viewBox="0 0 64 64"><defs><linearGradient id="gateg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e9e70"/><stop offset="1" stop-color="#0a6448"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#gateg)"/><g fill="#fff" stroke="url(#gateg)" stroke-width="6.4" paint-order="stroke"><circle cx="32" cy="25" r="11"/><circle cx="22" cy="42" r="11"/><circle cx="42" cy="42" r="11"/></g></svg>' +
      '<h1>Gather</h1>' +
      '<p>This is a private site. Enter the password you were given.</p>' +
      '<input type="password" id="gatePw" placeholder="Password" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">' +
      '<div class="gate-err" id="gateErr"></div>' +
      '<button type="submit" id="gateGo">Continue</button>' +
      '</form>';
    document.body.appendChild(wrap);
    document.body.classList.add('gated');
    const pw = wrap.querySelector('#gatePw'), err = wrap.querySelector('#gateErr'), go = wrap.querySelector('#gateGo');
    setTimeout(() => pw.focus(), 50);
    wrap.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const v = pw.value;
      if (!v) return;
      go.disabled = true;
      if (await sha256(v) === cfg.PASSWORD_HASH) {
        wrap.remove();
        document.body.classList.remove('gated');
        done(v);
      } else {
        err.textContent = 'That password is not right.';
        pw.select();
        go.disabled = false;
      }
    });
  }
})();
