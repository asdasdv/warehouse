// Tasks panel (top left): one card per box the user asked to receive, move or ship.
// Finished moves and shipments become toasts.
const STEPS = {Receive: ['Coming', 'Loading', 'Storing'], Move: ['Coming', 'Loading', 'Moving'], Ship: ['Coming', 'Loading', 'Delivering']};
const TITLE = {Receive: 'Put away to', Move: 'Move to', Ship: 'Ship to'};
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

export function installTasksPanel(sim, toast, {onHistory}) {
  const el = document.createElement('section');
  el.id = 'tasksPanel'; el.hidden = true;
  document.querySelector('main').append(el);
  let last = '';
  function card(t) {
    const steps = STEPS[t.kind], status = t.step < 0 ? 'Waiting' : t.step === 0 ? 'Robot is coming' : steps[t.step];
    return `<div class="lc-task"><div class="lc-task-line"><span>${TITLE[t.kind]} ${esc(t.to)}</span><small>${status}</small></div><p>${esc(t.text)}</p>`
      + `<div class="lc-steps">${steps.map((_, i) => `<i class="${i <= t.step ? 'on' : ''}"></i>`).join('')}</div>`
      + `<div class="lc-step-names">${steps.map((s, i) => `<span class="${i === t.step ? 'on' : ''}">${s}</span>`).join('')}</div>`
      + (t.cancellable ? `<button class="lc-cancel" data-cancel="${esc(t.id)}">Cancel task</button>` : '') + '</div>';
  }
  function render() {
    const tasks = sim.tasks();
    const html = tasks.length ? `<p>Tasks · ${tasks.length}</p>${tasks.map(card).join('')}` : '';
    if (html !== last) {
      last = html; el.innerHTML = html; el.hidden = !tasks.length;
      el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => {
        try { sim.cancelTask(b.dataset.cancel); toast('Task cancelled'); } catch (e) { toast(e.message); }
        render();
      });
    }
    for (const f of sim.takeFinished()) {
      if (f.kind === 'Move') toast(`${f.box.id} moved`, `Now at ${f.place} · ${f.robot} is free again`);
      if (f.kind === 'Ship') toast(`${f.box.id} shipped`, `${f.robot} delivered it to ${f.place}`, {label: 'View history', run: onHistory});
    }
  }
  setInterval(render, 400);
  return {render};
}
