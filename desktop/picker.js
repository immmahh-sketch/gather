// Screen picker: one click selects, double click (or Share) shares, Esc cancels.
(async () => {
  const $ = s => document.querySelector(s);
  const { list, sound } = await window.picker.sources();
  let chosen = null;
  const share = () => { if (chosen) window.picker.choose(chosen, sound && $('#sound').checked); };

  if (sound) $('#soundRow').classList.remove('hidden');
  for (const s of list) {
    const b = document.createElement('button');
    b.className = 'src';
    b.type = 'button';
    b.title = s.name;
    const img = document.createElement('img');
    img.src = s.thumb;
    img.alt = '';
    const name = document.createElement('span');
    name.textContent = s.screen ? (list.filter(x => x.screen).length > 1 ? s.name : 'Entire screen') : s.name;
    b.append(img, name);
    b.addEventListener('click', () => {
      chosen = s.id;
      document.querySelectorAll('.src').forEach(x => x.classList.toggle('on', x === b));
      $('#share').disabled = false;
    });
    b.addEventListener('dblclick', () => { chosen = s.id; share(); });
    (s.screen ? $('#screens') : $('#windows')).appendChild(b);
  }
  if (!$('#windows').children.length) $('#windowsHead').classList.add('hidden');
  if (!$('#screens').children.length) $('#screensHead').classList.add('hidden');
  const first = document.querySelector('.src');
  if (first) { first.click(); first.focus(); }

  $('#share').addEventListener('click', share);
  $('#cancel').addEventListener('click', () => window.picker.choose(null, false));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') window.picker.choose(null, false);
    if (e.key === 'Enter' && chosen) share();
  });
})();
