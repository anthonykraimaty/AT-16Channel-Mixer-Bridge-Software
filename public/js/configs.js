// Save and load whole configurations: every mixer setting and name, plus the
// colours, views and mix sources kept by the bridge.
import * as net from './net.js';
import { h, openDialog, closeDialog, toast } from './ui.js';

const ARM_TIME = 4000;

const when = (ms) => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const suggestName = () => new Date().toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const head = (title, note) => h('header', { class: 'dialog-head' },
  h('div', { class: 'dialog-titles' }, h('small', null, net.state.model || 'MIXER'), h('b', null, title)), note || null);

export function openSave() {
  if (net.state.link !== 'ready') { toast('The mixer is not connected.'); return; }
  openDialog({
    label: 'Save configuration',
    render(card) {
      const input = h('input', {
        class: 'text-input', type: 'text', value: suggestName(), placeholder: 'Name', maxLength: 60,
        autocomplete: 'off', spellcheck: false, enterKeyHint: 'done', 'aria-label': 'Name',
      });
      const note = h('p', { class: 'hint' });
      const save = h('button', { class: 'button button-primary', type: 'button' }, 'Save');
      const existing = () => net.state.configs.find((c) => c.name.toLowerCase() === input.value.trim().toLowerCase());
      const paint = () => {
        const same = existing();
        note.textContent = same ? `"${same.name}" exists already, saved ${when(same.savedAt)}. Saving replaces it.` : 'Saves every mixer setting and name, with the colours, views and mix sources.';
        note.classList.toggle('is-warning', Boolean(same));
        save.textContent = same ? 'Replace' : 'Save';
        save.disabled = !input.value.trim();
      };
      const done = () => {
        if (!input.value.trim()) return;
        net.send({ t: 'configSave', name: input.value.trim() });
        closeDialog();
      };
      input.addEventListener('input', paint);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } });
      save.addEventListener('click', done);

      // Earlier names, one tap to save over them.
      const earlier = net.state.configs.slice(0, 6).map((c) => h('button', {
        class: 'chip', type: 'button', onclick: () => { input.value = c.name; paint(); },
      }, h('span', null, c.name)));

      card.append(
        head('Save configuration'),
        h('div', { class: 'dialog-body' },
          h('div', { class: 'group-title' }, 'Name'),
          input,
          earlier.length ? h('div', { class: 'pick-pool' }, earlier) : null,
          note),
        h('footer', { class: 'dialog-foot' },
          h('button', { class: 'button', type: 'button', onclick: closeDialog }, 'Cancel'),
          save),
      );
      paint();
      if (window.matchMedia('(pointer: fine)').matches) setTimeout(() => { input.focus(); input.select(); }, 0);
    },
  });
}

export function openLoad() {
  let selected = net.state.configs.length ? net.state.configs[0].id : null;
  const parts = { mixer: true, names: true, look: true };
  let armed = null;
  let deleting = null;
  let repaint = null;

  openDialog({
    label: 'Load configuration',
    render(card) {
      const list = h('div', { class: 'config-list' });
      const options = h('div', { class: 'config-parts' });
      const warning = h('p', { class: 'hint is-warning' }, 'Loading changes the mixer at once: levels, mutes, EQ, sends and +48V go to what was saved.');
      const load = h('button', { class: 'button button-danger-fill', type: 'button' }, 'Load');
      const remove = h('button', { class: 'link', type: 'button' }, 'Delete');
      const download = h('a', { class: 'link', download: '' }, 'Download file');
      const picker = h('input', { type: 'file', accept: '.json,application/json', hidden: true });

      const disarm = () => { clearTimeout(armed); clearTimeout(deleting); armed = null; deleting = null; };
      const paint = () => {
        const configs = net.state.configs;
        if (!configs.some((c) => c.id === selected)) selected = configs.length ? configs[0].id : null;
        list.replaceChildren(...(configs.length ? configs.map((c) => h('button', {
          class: `config-row${c.id === selected ? ' is-on' : ''}`, type: 'button',
          onclick: () => { selected = c.id; disarm(); paint(); },
        }, h('b', null, c.name), h('small', null, when(c.savedAt)))) : [h('p', { class: 'hint' }, 'Nothing saved yet. Use Save to keep the current state of the mixer.')]));

        options.replaceChildren(...[['mixer', 'Mixer settings'], ['names', 'Names'], ['look', 'Colours and views']].map(([key, label]) => h('button', {
          class: `toggle${parts[key] ? ' is-on' : ''}`, type: 'button', 'aria-pressed': String(parts[key]),
          onclick: () => { parts[key] = !parts[key]; disarm(); paint(); },
        }, label)));

        const any = parts.mixer || parts.names || parts.look;
        load.disabled = !selected || !any || net.state.link !== 'ready';
        load.textContent = armed ? 'Press again to load' : 'Load';
        load.classList.toggle('is-armed', Boolean(armed));
        warning.hidden = !parts.mixer || !selected;
        remove.hidden = download.hidden = !selected;
        remove.textContent = deleting ? 'Press again to delete' : 'Delete';
        remove.classList.toggle('is-armed', Boolean(deleting));
        if (selected) download.href = `configs/${selected}.json`;
      };
      repaint = paint;

      // Loading changes the sound, so it takes two presses.
      load.addEventListener('click', () => {
        if (!armed) {
          armed = setTimeout(() => { armed = null; paint(); }, ARM_TIME);
          paint();
          return;
        }
        disarm();
        net.send({ t: 'configLoad', id: selected, parts });
        closeDialog();
      });
      // Two presses, like loading: a saved configuration cannot be brought back.
      remove.addEventListener('click', () => {
        if (!deleting) {
          clearTimeout(armed);
          armed = null;
          deleting = setTimeout(() => { deleting = null; paint(); }, ARM_TIME);
          paint();
          return;
        }
        const id = selected;
        disarm();
        net.send({ t: 'configDelete', id });
      });
      picker.addEventListener('change', async () => {
        const file = picker.files[0];
        picker.value = '';
        if (!file) return;
        try {
          net.send({ t: 'configImport', config: JSON.parse(await file.text()) });
        } catch {
          toast('That file could not be read as a configuration.');
        }
      });

      card.append(
        head('Load configuration'),
        h('div', { class: 'dialog-body' },
          list,
          h('div', { class: 'config-tools' }, download, remove, h('button', { class: 'link', type: 'button', onclick: () => picker.click() }, 'Add from file'), picker),
          h('div', { class: 'group-title' }, 'Bring back'),
          options,
          warning),
        h('footer', { class: 'dialog-foot' },
          h('button', { class: 'button', type: 'button', onclick: closeDialog }, 'Cancel'),
          load),
      );
      net.on('configs', paint);
      net.on('link', paint);
      paint();
    },
    onClose() {
      clearTimeout(armed);
      clearTimeout(deleting);
      if (repaint) { net.off('configs', repaint); net.off('link', repaint); }
    },
  });
}

net.on('notice', (notice) => {
  if (notice.kind === 'configSaved') toast(notice.replaced ? `Replaced "${notice.name}".` : `Saved "${notice.name}".`);
  if (notice.kind === 'configImported') toast(`Added "${notice.name}" from the file.`);
  if (notice.kind === 'configLoaded') {
    const bits = [];
    if (notice.settings) bits.push(`${notice.settings} setting${notice.settings === 1 ? '' : 's'}`);
    if (notice.names) bits.push(`${notice.names} name${notice.names === 1 ? '' : 's'}`);
    if (notice.look) bits.push('colours and views');
    toast(bits.length ? `Loaded "${notice.name}": ${bits.join(', ')} changed.` : `Loaded "${notice.name}". Everything already matched.`);
  }
});
