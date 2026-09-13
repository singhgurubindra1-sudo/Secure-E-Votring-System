import { $, $$, api, mountSession, escapeHtml, highlight, debounce, toast } from './app.js';

mountSession();

const form = $('#filters');
const tbody = $('#rows');
const empty = $('#empty');
const count = $('#count');
const pageLabel = $('#pageLabel');
const prev = $('#prev');
const next = $('#next');

const state = { name: '', voterId: '', page: 1, pageSize: 25, sort: 'slNo', order: 'asc', pages: 1 };

function rowHtml(voter) {
  return `<tr>
    <td class="num">${escapeHtml(voter.slNo)}</td>
    <td>${highlight(voter.name, state.name)}</td>
    <td class="epic">${highlight(voter.voterId, state.voterId)}</td>
    <td>${escapeHtml(voter.state)}</td>
    <td>${escapeHtml(voter.district)}</td>
    <td class="num">${escapeHtml(voter.dobDisplay || voter.dob)}</td>
  </tr>`;
}

function renderEmpty(total) {
  const filtering = Boolean(state.name || state.voterId);
  empty.hidden = false;
  empty.innerHTML = filtering
    ? `<h3>No matching entries</h3><p>Nothing on the roll matches those filters. Check the spelling, or clear the filters to see every entry.</p>`
    : total === 0
      ? `<h3>The roll has not been loaded yet</h3><p>Once voter records are added to <code>data/voters.json</code> they will appear here.</p>`
      : `<h3>Nothing on this page</h3><p>Go back to the first page to see results.</p>`;
}

async function load() {
  const params = new URLSearchParams({
    name: state.name,
    voterId: state.voterId,
    page: state.page,
    pageSize: state.pageSize,
    sort: state.sort,
    order: state.order,
  });

  try {
    const data = await api('/api/voters?' + params);
    state.pages = data.pages;

    tbody.innerHTML = data.rows.map(rowHtml).join('');
    if (data.rows.length) empty.hidden = true;
    else renderEmpty(data.total);

    const filtering = Boolean(state.name || state.voterId);
    count.textContent = data.total === 0
      ? 'No entries on the roll yet'
      : filtering
        ? `${data.matched} of ${data.total} entries match`
        : `${data.total} entries on the roll`;

    pageLabel.textContent = `Page ${data.page} of ${data.pages}`;
    prev.disabled = data.page <= 1;
    next.disabled = data.page >= data.pages;
  } catch (err) {
    toast(err.message, 'bad');
  }
}

const reload = debounce(() => { state.page = 1; load(); }, 220);

form.addEventListener('input', (event) => {
  const field = event.target.name;
  if (field === 'name' || field === 'voterId') {
    state[field] = event.target.value;
    reload();
  }
});

form.addEventListener('submit', (event) => event.preventDefault());

form.addEventListener('reset', () => {
  setTimeout(() => {
    state.name = '';
    state.voterId = '';
    state.page = 1;
    load();
  }, 0);
});

$$('[data-sort]').forEach((button) => {
  button.addEventListener('click', () => {
    const key = button.dataset.sort;
    state.order = state.sort === key && state.order === 'asc' ? 'desc' : 'asc';
    state.sort = key;
    state.page = 1;
    load();
  });
});

prev.addEventListener('click', () => { if (state.page > 1) { state.page -= 1; load(); } });
next.addEventListener('click', () => { if (state.page < state.pages) { state.page += 1; load(); } });

load();
