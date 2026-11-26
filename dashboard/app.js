// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/
// by main.ts) and renders the ranked board, a filterable table, a
// per-protocol detail view with the model's own inputs and the protocol's
// farm plan. No network: every byte it shows is in data.js. The farm plan's
// text is rendered here from the row's priced inputs, with the same
// templates lib/model.ts uses for board.json, so the page and the board
// always agree.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var dialog = document.getElementById('detail');
  var state = { q: '', category: 'all', chain: 'all', watchlistOnly: false, sort: 'r', dir: 1, selected: null };

  // ---- small DOM helpers: elements are built, never pasted as HTML.
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (key === 'text') node.textContent = attrs[key];
        else if (key === 'class') node.className = attrs[key];
        else if (key === 'onclick') node.addEventListener('click', attrs[key]);
        else node.setAttribute(key, attrs[key]);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }
  function money(n) {
    if (n === null || n === undefined) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function fullMoney(n) {
    if (n === null || n === undefined) return 'n/a';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function pct(n) {
    if (n === null || n === undefined) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function ageText(a) {
    if (a === null || a === undefined) return 'n/a';
    if (a < 30) return a + 'd';
    if (a < 365) return Math.round(a / 30) + 'mo';
    return (a / 365).toFixed(1) + 'y';
  }

  // ---- the farm plan, rendered from the row's priced inputs.
  // These templates are the same words lib/model.ts writes into board.json:
  // the page re-renders them from the same inputs, it never invents a plan.
  function riskFor(p) {
    var c = (p.c || '').toLowerCase();
    if (
      c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0 || c.indexOf('curator') >= 0 ||
      c.indexOf('risk') >= 0 || c.indexOf('stable') >= 0 || c.indexOf('rwa') >= 0 || c.indexOf('insurance') >= 0
    ) {
      return 'lower risk: supplying or holding carries no impermanent loss';
    }
    return 'higher risk: liquidity and leveraged positions carry impermanent loss';
  }
  function actionFor(p) {
    var c = (p.c || '').toLowerCase();
    var name = p.n;
    var cap = p.f.cap;
    var chain = p.f.chain;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + cap + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + cap + ' of liquidity to ' + name + '\'s main pool on ' + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + cap + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Stake $' + cap + ' of the chain\'s staking asset through ' + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + cap + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + cap + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + cap + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + cap + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + cap + ' of the protocol\'s yield asset on ' + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + cap + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    if (c.indexOf('basis') >= 0) return 'Deposit $' + cap + ' of USDC into ' + name + '\'s basis position on ' + chain + ' and keep it open.';
    if (c.indexOf('risk') >= 0) return 'Deposit $' + cap + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    return 'Deposit $' + cap + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function verdictText(p) {
    var f = p.f;
    if (f.vd === 'FARM') return 'Verdict: FARM. Gas for the whole plan is about $' + f.tg + ', ' + f.gs + '% of this $' + f.cap + ' capital on ' + f.chain + ', so the position is worth running at this size.';
    if (f.vd === 'THIN') return 'Verdict: THIN. Gas for the whole plan is about $' + f.tg + ', ' + f.gs + '% of this $' + f.cap + ' capital on ' + f.chain + ': farm it only with a larger position or on a cheaper chain.';
    return 'Verdict: SKIP. Gas for the whole plan is about $' + f.tg + ', ' + f.gs + '% of this $' + f.cap + ' capital on ' + f.chain + ', so this size is not worth farming — wait for a cheaper chain or a larger position.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + ' Hold the position and check the protocol\'s own page.';
    return s;
  }
  function farmSteps(p) {
    var f = p.f;
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'about $' + f.gas + ' of gas for the first transaction on ' + f.chain, time: '5 minutes' },
      { text: actionFor(p) + ' ' + riskFor(p) + '. ' + verdictText(p), cost: '$' + f.cap + ' of capital and about $' + f.gas + ' of gas', time: '15 minutes to set up' },
      { text: 'Do one qualifying action each week — a deposit, a swap, a vote or a borrow — so the activity spans more than one snapshot.', cost: 'about $' + f.wk + ' of gas a month on ' + f.chain, time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + f.hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + f.cap + ' stays in the position', time: f.hold + ' days' },
      { text: 'Before withdrawing, open the protocol\'s own rewards page and claim only from the link it publishes.', cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Keep a farm log with the wallet, the dates and every transaction, so you can repeat the position or unwind it cleanly.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }
  // Exposed for the entry's own node test: the page's farm steps must match
  // board.json's, row for row. It is a test hook, not a feature.
  window.__farmSteps = farmSteps;

  // ---- state in the URL hash, so a view is a link: #p=<slug> opens a
  // protocol, #category=Lending or #watchlist=1 filters the board.
  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    state.q = params.get('q') || '';
    state.category = params.get('category') || 'all';
    state.chain = params.get('chain') || 'all';
    state.watchlistOnly = params.get('watchlist') === '1';
    state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watchlistOnly) params.set('watchlist', '1');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    var list = DATA.rows.filter(function (r) {
      if (state.watchlistOnly && !r.w) return false;
      if (state.category !== 'all' && r.c !== state.category) return false;
      if (state.chain !== 'all' && (r.ch || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      return [r.n, r.s, r.c, (r.ch || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    var key = state.sort;
    var dir = state.dir;
    list.sort(function (a, b) {
      var av = a[key];
      var bv = b[key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av - bv);
    });
    return list;
  }
  function rowBySlug(slug) {
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].s === slug) return DATA.rows[i];
    return null;
  }
  function setSort(key) {
    if (state.sort === key) state.dir = -state.dir;
    else { state.sort = key; state.dir = key === 'n' ? 1 : -1; }
    render();
  }
  function sortLabel(key, label) {
    return label + (state.sort === key ? (state.dir === 1 ? ' ▲' : ' ▼') : '');
  }

  function headerCell(key, label) {
    return el('th', { scope: 'col' }, el('button', { type: 'button', onclick: function () { setSort(key); }, text: sortLabel(key, label) }));
  }

  function render() {
    app.setAttribute('aria-busy', 'false');
    while (app.firstChild) app.removeChild(app.firstChild);
    var v = DATA.validation;
    var shell = el('div', { class: 'shell' });
    var top = el('div', { class: 'top' },
      el('div', null,
        el('h1', { text: 'Token Radar' }),
        el('p', { class: 'sub', text: 'Pre-token protocols, ranked by implied launch value — from the snapshot\u2019s own figures: TVL, the live-token peers\u2019 market-cap-to-TVL ratio, and how long the protocol has run with no token.' })
      ),
      el('span', { class: 'badge', text: 'Model ' + DATA.model_version })
    );
    shell.appendChild(top);
    shell.appendChild(el('div', { class: 'strip' },
      el('b', { text: DATA.integrity.protocols + ' protocols' }),
      ' in the snapshot · ',
      el('b', { text: DATA.integrity.watchlist + ' on the watchlist' }),
      ' · ',
      el('b', { text: DATA.integrity.board + ' ranked' }),
      ' · ',
      el('b', { text: DATA.integrity.excluded_products + ' wrapped / staked products excluded' }),
      ' · ',
      el('b', { text: DATA.integrity.live_token + ' live-token protocols' }),
      '. Snapshot ' + DATA.as_of + '. ' + DATA.integrity.note
    ));
    var panels = el('div', { class: 'panels' });
    panels.appendChild(el('section', { class: 'panel' },
      el('h2', { text: 'Held-out: leave-one-out' }),
      el('p', { class: 'muted', text: 'Each live-token protocol is predicted from all the others. Error 1x is exact; 2x is double or half.' }),
      el('div', { class: 'grid' },
        el('div', null, el('span', { text: 'Model median' }), el('span', { class: 'num', text: v.loo.model.median + 'x' })),
        el('div', null, el('span', { text: 'Model p90' }), el('span', { class: 'num', text: v.loo.model.p90 + 'x' })),
        el('div', null, el('span', { text: 'Category median' }), el('span', { class: 'num', text: v.loo.categoryMedian.median + 'x' })),
        el('div', null, el('span', { text: 'Global median' }), el('span', { class: 'num', text: v.loo.globalMedian.median + 'x' })),
        el('div', null, el('span', { text: 'Comps' }), el('span', { class: 'num', text: String(v.loo.model.n) })),
        el('div', null, el('span', { text: 'Top-10 overlap' }), el('span', { class: 'num', text: v.loo.top10OverlapMedian.toFixed(2) }))
      )
    ));
    panels.appendChild(el('section', { class: 'panel' },
      el('h2', { text: 'Held-out: walk-forward' }),
      el('p', { class: 'muted', text: 'Peer ratios are fitted on protocols listed before ' + v.walkForward.cutoff + ' and tested on the ones listed after it.' }),
      el('div', { class: 'grid' },
        el('div', null, el('span', { text: 'Model median' }), el('span', { class: 'num', text: v.walkForward.model.median + 'x' })),
        el('div', null, el('span', { text: 'Model p90' }), el('span', { class: 'num', text: v.walkForward.model.p90 + 'x' })),
        el('div', null, el('span', { text: 'Category median' }), el('span', { class: 'num', text: v.walkForward.categoryMedian.median + 'x' })),
        el('div', null, el('span', { text: 'Global median' }), el('span', { class: 'num', text: v.walkForward.globalMedian.median + 'x' })),
        el('div', null, el('span', { text: 'Tested' }), el('span', { class: 'num', text: String(v.walkForward.test) })),
        el('div', null, el('span', { text: 'Rank Spearman' }), el('span', { class: 'num', text: v.walkForward.spearman.toFixed(2) }))
      )
    ));
    shell.appendChild(panels);

    var categories = [];
    var chains = [];
    DATA.rows.forEach(function (r) {
      if (r.c && categories.indexOf(r.c) < 0) categories.push(r.c);
      (r.ch || []).forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
    });
    categories.sort();
    chains.sort();
    var search = el('input', { type: 'search', placeholder: 'Search name or slug…', value: state.q, 'aria-label': 'Search protocols' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSelect = el('select', { 'aria-label': 'Category' });
    catSelect.appendChild(el('option', { value: 'all', text: 'All categories' }));
    categories.forEach(function (c) { catSelect.appendChild(el('option', { value: c, text: c })); });
    catSelect.value = state.category;
    catSelect.addEventListener('change', function () { state.category = catSelect.value; writeHash(); render(); });
    var chainSelect = el('select', { 'aria-label': 'Chain' });
    chainSelect.appendChild(el('option', { value: 'all', text: 'All chains' }));
    chains.forEach(function (c) { chainSelect.appendChild(el('option', { value: c, text: c })); });
    chainSelect.value = state.chain;
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var wl = el('input', { type: 'checkbox' });
    wl.checked = state.watchlistOnly;
    wl.addEventListener('change', function () { state.watchlistOnly = wl.checked; writeHash(); render(); });
    var filters = el('div', { class: 'filters' }, search, catSelect, chainSelect,
      el('label', null, wl, ' Watchlist only'),
      el('button', { class: 'button', type: 'button', text: 'Download filtered rows as CSV', onclick: downloadCsv })
    );
    shell.appendChild(filters);

    var list = rows();
    shell.appendChild(el('p', { class: 'count', text: list.length + ' of ' + DATA.rows.length + ' rows shown. Click a row for its detail view and farm plan. Implied values carry a range: the leave-one-out median error, never a single precise number.' }));
    var wrap = el('div', { class: 'table-wrap' });
    if (list.length === 0) {
      wrap.appendChild(el('div', { class: 'empty' }, el('h2', { text: 'No protocol matches that filter' }), el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchlistOnly = false; writeHash(); render(); } })));
    } else {
      var table = el('table', null,
        el('thead', null, el('tr', null,
          headerCell('r', 'Rank'),
          headerCell('n', 'Protocol'),
          headerCell('c', 'Category'),
          headerCell('t', 'TVL'),
          headerCell('g', '7d'),
          headerCell('v', 'Implied value'),
          headerCell('o', 'Token odds'),
          headerCell('ls', 'Score'),
          headerCell('vd', 'Farm')
        ))
      );
      var body = el('tbody', null);
      list.forEach(function (r) {
        var tr = el('tr', { class: r.w ? 'watch' : '' });
        tr.addEventListener('click', function () { state.selected = r.s; writeHash(); openDetail(r.s); });
        tr.appendChild(el('td', { class: 'num', text: String(r.r) }));
        var nameCell = el('td', { class: 'name' }, el('b', { text: r.n }));
        nameCell.appendChild(el('span', { text: r.s + (r.w ? ' · watchlist' : '') }));
        tr.appendChild(nameCell);
        tr.appendChild(el('td', { text: r.c || '—' }));
        tr.appendChild(el('td', { class: 'num', text: money(r.t) }));
        tr.appendChild(el('td', { class: 'num', text: pct(r.g) }));
        var valCell = el('td', { class: 'num', text: money(r.v) });
        valCell.appendChild(el('span', { class: 'range', text: money(r.vLo) + ' – ' + money(r.vHi) }));
        tr.appendChild(valCell);
        tr.appendChild(el('td', { class: 'num', text: (r.o * 100).toFixed(1) + '%' }));
        tr.appendChild(el('td', { class: 'num', text: String(r.ls) }));
        var verdict = el('td', null, el('span', { class: 'tag ' + r.f.vd.toLowerCase(), text: r.f.vd }));
        tr.appendChild(verdict);
        body.appendChild(tr);
      });
      table.appendChild(body);
      wrap.appendChild(table);
    }
    shell.appendChild(wrap);

    var live = el('section', { class: 'panel', style: 'margin-top: 20px;' });
    live.appendChild(el('h2', { text: 'Live-token comps: what the market already values' }));
    live.appendChild(el('p', { class: 'muted', text: 'The peers the model learns from. A live-token protocol\u2019s value is the market\u2019s, never a model\u2019s.' }));
    var liveTable = el('table', { style: 'margin-top: 10px;' },
      el('thead', null, el('tr', null,
        el('th', { scope: 'col', text: 'Protocol' }),
        el('th', { scope: 'col', text: 'Category' }),
        el('th', { scope: 'col', text: 'TVL' }),
        el('th', { scope: 'col', text: 'Market cap' }),
        el('th', { scope: 'col', text: 'MCap / TVL' }),
        el('th', { scope: 'col', text: '7d' })
      ))
    );
    var liveBody = el('tbody', null);
    DATA.live.forEach(function (p) {
      var tr = el('tr', null);
      tr.appendChild(el('td', { class: 'name' }, el('b', { text: p.n })));
      tr.appendChild(el('td', { text: p.c || '—' }));
      tr.appendChild(el('td', { class: 'num', text: money(p.t) }));
      tr.appendChild(el('td', { class: 'num', text: money(p.m) }));
      tr.appendChild(el('td', { class: 'num', text: p.m !== null && p.t > 0 ? (p.m / p.t).toFixed(2) : 'n/a' }));
      tr.appendChild(el('td', { class: 'num', text: pct(p.g) }));
      liveBody.appendChild(tr);
    });
    liveTable.appendChild(liveBody);
    live.appendChild(liveTable);
    shell.appendChild(live);

    shell.appendChild(el('p', { class: 'note' },
      el('b', { text: 'How to read it. ' }),
      'Implied value = TVL × peer ratio × liquidity × decay (methodology v2). Peer ratio: the mean market-cap-to-TVL ratio of the five most similar live-token protocols in the same category. Liquidity: 1.0 for direct-pool categories, 0.2 for LP-token-heavy yield categories, 0.5 otherwise — a stated proxy, since the snapshot carries no pool data. Token odds = market momentum × 0.5 (technical, neutral — the snapshot carries no audit data) × the mature peers\u2019 launch rate. Farm verdicts price gas only: yield is not in the snapshot and is never invented. ',
      'Source: ', DATA.source, '. Model ', DATA.model_version, '.'
    ));
    app.appendChild(shell);
    if (state.selected) openDetail(state.selected);
    else if (dialog.open) dialog.close();
  }

  function openDetail(slug) {
    var r = rowBySlug(slug);
    if (!r) return;
    while (dialog.firstChild) dialog.removeChild(dialog.firstChild);
    var wrap = el('div', { class: 'detail' });
    wrap.appendChild(el('h2', { text: r.n + ' — rank ' + r.r }));
    wrap.appendChild(el('p', { class: 'meta', text: (r.c || 'Uncategorised') + ' · ' + (r.ch || []).join(', ') + ' · ' + r.s + (r.w ? ' · watchlist' : '') + ' · listed ' + (r.l || 'unknown') + (r.a !== null ? ' (' + ageText(r.a) + ' ago)' : '') }));
    var kv = el('div', { class: 'kv' });
    kv.appendChild(el('div', null, el('span', { text: 'TVL' }), el('span', { class: 'num', text: fullMoney(r.t) })));
    kv.appendChild(el('div', null, el('span', { text: '7-day change' }), el('span', { class: 'num', text: pct(r.g) })));
    kv.appendChild(el('div', null, el('span', { text: 'Implied launch value' }), el('span', { class: 'num', text: fullMoney(r.v) })));
    kv.appendChild(el('div', null, el('span', { text: 'Implied range' }), el('span', { class: 'num', text: money(r.vLo) + ' – ' + money(r.vHi) })));
    kv.appendChild(el('div', null, el('span', { text: 'Peer ratio (MCap/TVL)' }), el('span', { class: 'num', text: r.m.toFixed(3) })));
    kv.appendChild(el('div', null, el('span', { text: 'Liquidity factor' }), el('span', { class: 'num', text: r.lf.toFixed(1) + ' (category proxy)' })));
    kv.appendChild(el('div', null, el('span', { text: 'Token odds' }), el('span', { class: 'num', text: (r.o * 100).toFixed(1) + '%' })));
    kv.appendChild(el('div', null, el('span', { text: 'Mature peers with a token' }), el('span', { class: 'num', text: r.ow + ' of ' + r.op })));
    kv.appendChild(el('div', null, el('span', { text: 'Launch score' }), el('span', { class: 'num', text: String(r.ls) + ' / 100' })));
    kv.appendChild(el('div', null, el('span', { text: 'Farm verdict' }), el('span', { class: 'tag ' + r.f.vd.toLowerCase(), text: r.f.vd })));
    kv.appendChild(el('div', null, el('span', { text: 'Farm cost' }), el('span', { class: 'num', text: '$' + r.f.cph + '/hr · net $' + r.f.net + '/hr' })));
    kv.appendChild(el('div', null, el('span', { text: 'Plan gas / capital' }), el('span', { class: 'num', text: '$' + r.f.tg + ' gas · $' + r.f.cap + ' cap (' + r.f.gs + '%) · ' + r.f.hold + 'd' })));
    wrap.appendChild(kv);
    wrap.appendChild(el('h3', { text: 'Farm plan — six steps, costed' }));
    var steps = el('ol', { class: 'steps' });
    farmSteps(r).forEach(function (s) {
      var parts = s.split(' Cost: ');
      var head = parts[0] || '';
      var rest = parts[1] || '';
      var costTime = rest.split(' Time: ');
      var li = el('li', null, el('span', { text: head + ' ' }), el('span', { class: 'cost', text: 'Cost: ' + (costTime[0] || '') + ' Time: ' + (costTime[1] || '') }));
      steps.appendChild(li);
    });
    wrap.appendChild(steps);
    wrap.appendChild(el('div', { class: 'actions' },
      el('button', { class: 'button primary', type: 'button', text: 'Close', onclick: closeDetail })
    ));
    dialog.appendChild(wrap);
    if (!dialog.open) dialog.showModal();
  }
  function closeDetail() {
    state.selected = null;
    writeHash();
    if (dialog.open) dialog.close();
  }
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function downloadCsv() {
    var list = rows();
    var lines = ['rank,slug,name,category,tvl_usd,change_7d,implied_value_usd,implied_low_usd,implied_high_usd,token_odds,launch_score,farm_verdict'];
    list.forEach(function (r) {
      lines.push([r.r, r.s, '"' + r.n.replace(/"/g, '""') + '"', r.c || '', r.t, r.g === null ? '' : r.g, r.v, r.vLo, r.vHi, r.o, r.ls, r.f.vd].join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'token-radar-board.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () { readHash(); render(); });
})();
