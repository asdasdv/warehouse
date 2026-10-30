// Tasks panel (top left): one card per box the user asked to receive, move or ship.
// Finished receipts, moves and shipments become toasts.
const STEPS = {Receive: ['Coming', 'Loading', 'Storing'], Move: ['Coming', 'Loading', 'Moving'], Ship: ['Coming', 'Loading', 'Delivering']};
const TITLE = {Receive: 'Put away to', Move: 'Move to', Ship: 'Ship to'};
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

export function installTasksPanel(sim, toast, {onHistory, onRobot, onBox}) {
  const el = document.createElement('section');
  el.id = 'tasksPanel'; el.hidden = true;
  document.querySelector('main').append(el);
  let last = '';
  // The robot's name in the line is a link: it selects the robot and the camera follows it.
  const robotLink = t => t.robot ? esc(t.text).replace(esc(t.robot), `<button class="lc-robot-link" data-follow="${esc(t.robot)}">${esc(t.robot)}</button>`) : esc(t.text);
  function card(t) {
    const steps = STEPS[t.kind], status = t.step < 0 ? 'Waiting' : t.step === 0 ? 'Robot is coming' : steps[t.step];
    // A card for a real box opens it and flies the camera there; queued receipts have no box yet.
    const box = /^BX-/.test(t.id);
    return `<div class="lc-task${box ? ' go' : ''}"${box ? ` data-box="${esc(t.id)}" tabindex="0" role="button"` : ''}><div class="lc-task-line"><span>${TITLE[t.kind]} ${esc(t.to)}</span><small>${status}</small></div><p>${robotLink(t)}</p>`
      + `<div class="lc-steps">${steps.map((_, i) => `<i class="${i <= t.step ? 'on' : ''}"></i>`).join('')}</div>`
      + `<div class="lc-step-names">${steps.map((s, i) => `<span class="${i === t.step ? 'on' : ''}">${s}</span>`).join('')}</div>`
      + (t.cancellable ? `<button class="lc-cancel" data-cancel="${esc(t.id)}">Cancel task</button>` : '') + '</div>';
  }
  function render() {
    const tasks = sim.tasks();
    const html = tasks.length ? `<p>Tasks · ${tasks.length}</p>${tasks.map(card).join('')}` : '';
    if (html !== last) {
      last = html; el.innerHTML = html; el.hidden = !tasks.length;
      el.querySelectorAll('[data-follow]').forEach(b => b.onclick = e => { e.stopPropagation(); onRobot?.(b.dataset.follow); });
      el.querySelectorAll('[data-box]').forEach(c => {
        c.onclick = e => { if (!e.target.closest('button')) onBox?.(c.dataset.box); };
        c.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === c) { e.preventDefault(); onBox?.(c.dataset.box); } };
      });
      el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = e => {
        e.stopPropagation();
        try { sim.cancelTask(b.dataset.cancel); toast('Task cancelled'); } catch (e) { toast(e.message); }
        render();
      });
    }
    // Boxes that finish together share one toast: «5 boxes shipped» instead of five toasts in a row.
    const done = {};
    for (const f of sim.takeFinished()) (done[f.kind] ||= []).push(f);
    for (const [kind, list] of Object.entries(done)) {
      const f = list[0], n = list.length, many = n > 1 ? `${n} boxes` : f.box.id;
      if (kind === 'Receive') toast(`${many} put away`, n > 1 ? `Now on the shelves · last at ${list[n - 1].place}` : `Now at ${f.place} · ${f.robot} is free again`);
      if (kind === 'Move') toast(`${many} moved`, n > 1 ? `Last one now at ${list[n - 1].place}` : `Now at ${f.place} · ${f.robot} is free again`);
      if (kind === 'MoveFailed') toast(`${many} not moved`, `${f.place} has no free cell left · the ${n > 1 ? 'boxes stay' : 'box stays'} where ${n > 1 ? 'they were' : 'it was'}`);
      if (kind === 'ReceiveRedirected') toast(`${many} stored elsewhere`, `${f.place} had no free cell left · put away near the dock`);
      if (kind === 'Ship') toast(`${many} shipped`, n > 1 ? `Delivered to ${[...new Set(list.map(x => x.place))].join(', ')}` : `${f.robot} delivered it to ${f.place}`, {label: 'View history', run: onHistory});
    }
  }
  setInterval(render, 400);
  return {render};
}
