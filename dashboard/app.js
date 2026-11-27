// Token Radar dashboard. It reads window.RADAR, written beside dashboard/
// by main.ts, and draws the ranked board, a filterable table, and a
// per-protocol detail view holding the model's own inputs and the protocol's
// farm plan. No network: every byte shown comes from data.js. The farm plan
// is rendered here from the row's priced inputs, using the same words
// lib/model.ts writes into board.json, so the page and the board never
// disagree.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;

  var boardEl = document.getElementById('board');
  var detailEl = document.getElementById('detail');
  var view = { q: '', category: 'all', chain: 'all', watchlistOnly: false, sort: 'r', dir: 1, selected: null };

  // ---- building nodes: elements are built, never pasted as HTML.
  function make(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var val = attrs[key];
        if (key === 'text') el.textContent = val;
        else if (key === 'class') el.className = val;
        else if (key === 'click') el.addEventListener('click', val);
        else el.setAttribute(key, val);
      }
    }
    if (kids) {
      for (var j = 0; j < kids.length; j++) {
        var kid = kids[j];
        if (kid === null || kid === undefined) continue;
        el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
      }
    }
    return el;
  }

  function isMissing(v) {
    return v === null || v === undefined;
  }

  // ---- number and date formatting
  var MONEY_STEPS = [
    { at: 1e9, places: 2, suffix: 'B' },
    { at: 1e6, places: 1, suffix: 'M' },
    { at: 1e3, places: 1, suffix: 'K' }
  ];
  function shortMoney(n) {
    if (isMissing(n)) return 'n/a';
    for (var i = 0; i < MONEY_STEPS.length; i++) {
      var step = MONEY_STEPS[i];
      if (Math.abs(n) >= step.at) return '$' + (n / step.at).toFixed(step.places) + step.suffix;
    }
    var whole = Math.round(n);
    return '$' + whole;
  }
  function longMoney(n) {
    if (isMissing(n)) return 'n/a';
    var whole = Math.round(n);
    return '$' + whole.toLocaleString('en-US');
  }
  function changePct(n) {
    if (isMissing(n)) return 'n/a';
    var sign = n > 0 ? '+' : '';
    return sign + n.toFixed(1) + '%';
  }
  function ageLabel(a) {
    if (isMissing(a)) return 'n/a';
    if (a < 30) {
      return a + 'd';
    } else if (a < 365) {
      return Math.round(a / 30) + 'mo';
    }
    var years = (a / 365).toFixed(1);
    return years + 'y';
  }

  // ---- the farm plan, drawn from the row's priced inputs.
  // The words below match what lib/model.ts writes into board.json: the page
  // re-renders them from the same inputs and never invents a plan of its own.
  var CALM_WORDS = ['lend', 'cdp', 'collateral', 'curator', 'risk', 'stable', 'rwa', 'insurance'];
  function planRisk(row) {
    var c = (row.c || '').toLowerCase();
    var calm = false;
    for (var i = 0; i < CALM_WORDS.length; i++) {
      if (c.indexOf(CALM_WORDS[i]) >= 0) {
        calm = true;
        break;
      }
    }
    if (calm) return 'lower risk: supplying or holding has no impermanent loss';
    return 'higher risk: liquidity and leveraged spots carry impermanent loss';
  }
  var ACTION_RULES = [
    { words: ['lend', 'cdp', 'collateral'], text: function (name, cap, chain) { return 'Lend $' + cap + ' of USDC through ' + name + ' on ' + chain + ' and leave the position open.'; } },
    { words: ['dex', 'yield', 'leveraged farm'], text: function (name, cap, chain) { return 'Add $' + cap + ' of liquidity to ' + name + '\'s main pool on ' + chain + ' and leave the position open.'; } },
    { words: ['bridge'], text: function (name, cap, chain) { return 'Move $' + cap + ' of USDC to ' + chain + ' through ' + name + ' and put the bridged funds to work in its app.'; } },
    { words: ['staking', 'restak'], text: function (name, cap, chain) { return 'Stake $' + cap + ' of the chain\'s staking asset through ' + name + ' and hold the receipt.'; } },
    { words: ['perpetual', 'derivative'], text: function (name, cap, chain) { return 'Post $' + cap + ' of USDC as margin on ' + name + ' and open one small hedge.'; } },
    { words: ['prediction'], text: function (name, cap, chain) { return 'Fund $' + cap + ' and take one market position on ' + name + '.'; } },
    { words: ['curator', 'allocator'], text: function (name, cap, chain) { return 'Put $' + cap + ' into a ' + name + ' vault on ' + chain + ' and hold the shares.'; } },
    { words: ['stable'], text: function (name, cap, chain) { return 'Mint or hold $' + cap + ' of the stable asset through ' + name + ' on ' + chain + '.'; } },
    { words: ['rwa'], text: function (name, cap, chain) { return 'Mint $' + cap + ' of the protocol\'s yield asset on ' + chain + ' and hold it.'; } },
    { words: ['insurance'], text: function (name, cap, chain) { return 'Buy $' + cap + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.'; } },
    { words: ['basis'], text: function (name, cap, chain) { return 'Place $' + cap + ' of USDC in ' + name + '\'s basis position on ' + chain + ' and leave it open.'; } },
    { words: ['risk'], text: function (name, cap, chain) { return 'Put $' + cap + ' into a ' + name + ' vault on ' + chain + ' and hold the shares.'; } }
  ];
  function planAction(row) {
    var c = (row.c || '').toLowerCase();
    for (var i = 0; i < ACTION_RULES.length; i++) {
      var rule = ACTION_RULES[i];
      for (var j = 0; j < rule.words.length; j++) {
        if (c.indexOf(rule.words[j]) >= 0) return rule.text(row.n, row.f.cap, row.f.chain);
      }
    }
    return 'Put $' + row.f.cap + ' of USDC into ' + row.n + ' on ' + row.f.chain + ' and leave the position open.';
  }
  var VERDICT_ENDINGS = {
    FARM: ', so the position is worth running at this size.',
    THIN: ': farm it only with a bigger stake or on a cheaper chain.',
    SKIP: ', so this size is not worth farming — wait for a cheaper chain or a bigger stake.'
  };
  function planVerdict(row) {
    var f = row.f;
    var share = 'Gas across the whole plan runs about $' + f.tg + ', ' + f.gs + '% of this $' + f.cap + ' stake on ' + f.chain;
    return 'Verdict: ' + f.vd + '. ' + share + VERDICT_ENDINGS[f.vd];
  }
  function clampStep(s) {
    if (s.length > 600) return s.slice(0, 596) + '...';
    if (s.length < 20) return s + ' Hold the position and check the protocol\'s own page.';
    return s;
  }
  function joinStep(step) {
    return clampStep(step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.');
  }
  function planSteps(row) {
    var f = row.f;
    var steps = [
      { text: 'Open a fresh wallet holding only the farming funds, and store its recovery phrase offline.', cost: 'about $' + f.gas + ' gas for the first transaction on ' + f.chain, time: '5 minutes' },
      { text: planAction(row) + ' ' + planRisk(row) + '. ' + planVerdict(row), cost: '$' + f.cap + ' capital plus about $' + f.gas + ' gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying move each week — a deposit, a swap, a vote or a borrow — so the activity shows up in more than one snapshot.', cost: 'about $' + f.wk + ' gas a month on ' + f.chain, time: '10 minutes a week' },
      { text: 'Leave the position in place for at least ' + f.hold + ' days so it is counted across snapshots.', cost: 'the $' + f.cap + ' stays locked in the position', time: f.hold + ' days' },
      { text: 'Before you pull out, open the protocol\u2019s own rewards page and claim only through the link it publishes.', cost: 'free to check; never pay to claim', time: '10 minutes' },
      { text: 'Write down the wallet, the dates and every transaction in a farm log, so the position can be repeated or unwound cleanly.', cost: 'nothing but the log', time: '5 minutes' }
    ];
    var out = [];
    for (var i = 0; i < steps.length; i++) out.push(joinStep(steps[i]));
    return out;
  }
  // The entry's own node test calls this: the page's farm steps must match
  // board.json's, row for row. A test hook, not a feature.
  window.__farmSteps = planSteps;

  // ---- the URL hash holds the view, so a view is a link: #p=<slug> opens a
  // protocol; #category=Lending or #watchlist=1 filters the board.
  function loadHash() {
    var raw = window.location.hash;
    if (raw.charAt(0) === '#') raw = raw.slice(1);
    var params = new URLSearchParams(raw);
    view.q = params.get('q') || '';
    view.category = params.get('category') || 'all';
    view.chain = params.get('chain') || 'all';
    view.watchlistOnly = params.get('watchlist') === '1';
    view.selected = params.get('p');
  }
  function saveHash() {
    var pairs = [];
    if (view.q) pairs.push(['q', view.q]);
    if (view.category !== 'all') pairs.push(['category', view.category]);
    if (view.chain !== 'all') pairs.push(['chain', view.chain]);
    if (view.watchlistOnly) pairs.push(['watchlist', '1']);
    if (view.selected) pairs.push(['p', view.selected]);
    var query = new URLSearchParams(pairs).toString();
    if (query) {
      window.history.replaceState(null, '', '#' + query);
      return;
    }
    var plain = window.location.pathname + window.location.search;
    window.history.replaceState(null, '', plain);
  }

  // ---- filtering and sorting
  function passesFilters(r) {
    if (view.watchlistOnly && !r.w) return false;
    if (view.category !== 'all' && r.c !== view.category) return false;
    if (view.chain !== 'all' && (r.ch || []).indexOf(view.chain) < 0) return false;
    var q = view.q.trim().toLowerCase();
    if (!q) return true;
    var hay = (r.n + ' ' + r.s + ' ' + (r.c || '') + ' ' + (r.ch || []).join(' ')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }
  function compareRows(a, b) {
    var av = a[view.sort];
    var bv = b[view.sort];
    var aMissing = isMissing(av);
    var bMissing = isMissing(bv);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof av === 'string' && typeof bv === 'string') return view.dir * av.localeCompare(bv);
    return view.dir * (av - bv);
  }
  function visibleRows() {
    var list = [];
    for (var i = 0; i < DATA.rows.length; i++) {
      var r = DATA.rows[i];
      if (passesFilters(r)) list.push(r);
    }
    list.sort(compareRows);
    return list;
  }
  function findRow(slug) {
    var found = DATA.rows.find(function (r) { return r.s === slug; });
    return found === undefined ? null : found;
  }
  function changeSort(key) {
    if (view.sort === key) {
      view.dir = -view.dir;
    } else {
      view.sort = key;
      view.dir = key === 'n' ? 1 : -1;
    }
    render();
  }
  function sortMark(key, label) {
    if (view.sort !== key) return label;
    return label + (view.dir === 1 ? ' ▲' : ' ▼');
  }
  function sortHead(key, label) {
    var button = make('button', { type: 'button', text: sortMark(key, label) });
    button.addEventListener('click', function () { changeSort(key); });
    return make('th', { scope: 'col' }, [button]);
  }

  // ---- the two held-out panels
  function statPair(label, value) {
    return make('div', null, [make('span', { text: label }), make('span', { class: 'num', text: value })]);
  }
  function validationPanels() {
    var v = DATA.validation;
    var loo = make('section', { class: 'panel' }, [
      make('h2', { text: 'Held-out: leave-one-out' }),
      make('p', { class: 'muted', text: 'Each live-token protocol is predicted from all the others. Error 1x is exact; 2x is double or half.' }),
      make('div', { class: 'grid' }, [
        statPair('Model median', v.loo.model.median + 'x'),
        statPair('Model p90', v.loo.model.p90 + 'x'),
        statPair('Category median', v.loo.categoryMedian.median + 'x'),
        statPair('Global median', v.loo.globalMedian.median + 'x'),
        statPair('Comps', String(v.loo.model.n)),
        statPair('Top-10 overlap', v.loo.top10OverlapMedian.toFixed(2))
      ])
    ]);
    var wf = make('section', { class: 'panel' }, [
      make('h2', { text: 'Held-out: walk-forward' }),
      make('p', { class: 'muted', text: 'Peer ratios are fitted on protocols listed before ' + v.walkForward.cutoff + ' and tested on the ones listed after it.' }),
      make('div', { class: 'grid' }, [
        statPair('Model median', v.walkForward.model.median + 'x'),
        statPair('Model p90', v.walkForward.model.p90 + 'x'),
        statPair('Category median', v.walkForward.categoryMedian.median + 'x'),
        statPair('Global median', v.walkForward.globalMedian.median + 'x'),
        statPair('Tested', String(v.walkForward.test)),
        statPair('Rank Spearman', v.walkForward.spearman.toFixed(2))
      ])
    ]);
    return make('div', { class: 'panels' }, [loo, wf]);
  }

  // ---- the filters row
  function filterBar() {
    var categories = [];
    var chains = [];
    function collect(list, value) {
      if (value && list.indexOf(value) < 0) list.push(value);
    }
    for (var i = 0; i < DATA.rows.length; i++) {
      var r = DATA.rows[i];
      collect(categories, r.c);
      var ch = r.ch || [];
      for (var j = 0; j < ch.length; j++) collect(chains, ch[j]);
    }
    categories.sort();
    chains.sort();
    var search = make('input', { type: 'search', placeholder: 'Search name or slug…', value: view.q, 'aria-label': 'Search protocols' });
    search.addEventListener('input', function () { view.q = search.value; saveHash(); render(); });
    var catSelect = make('select', { 'aria-label': 'Category' });
    catSelect.appendChild(make('option', { value: 'all', text: 'All categories' }));
    for (var k = 0; k < categories.length; k++) {
      catSelect.appendChild(make('option', { value: categories[k], text: categories[k] }));
    }
    catSelect.value = view.category;
    catSelect.addEventListener('change', function () { view.category = catSelect.value; saveHash(); render(); });
    var chainSelect = make('select', { 'aria-label': 'Chain' });
    chainSelect.appendChild(make('option', { value: 'all', text: 'All chains' }));
    for (var m = 0; m < chains.length; m++) {
      chainSelect.appendChild(make('option', { value: chains[m], text: chains[m] }));
    }
    chainSelect.value = view.chain;
    chainSelect.addEventListener('change', function () { view.chain = chainSelect.value; saveHash(); render(); });
    var wl = make('input', { type: 'checkbox' });
    wl.checked = view.watchlistOnly;
    wl.addEventListener('change', function () { view.watchlistOnly = wl.checked; saveHash(); render(); });
    return make('div', { class: 'filters' }, [
      search, catSelect, chainSelect,
      make('label', null, [wl, ' Watchlist only']),
      make('button', { class: 'button', type: 'button', text: 'Download filtered rows as CSV', click: downloadCsv })
    ]);
  }

  // ---- the board table
  function boardTable(list) {
    var wrap = make('div', { class: 'table-wrap' });
    if (list.length === 0) {
      wrap.appendChild(make('div', { class: 'empty' }, [
        make('h2', { text: 'No protocol matches that filter' }),
        make('button', {
          class: 'button primary', type: 'button', text: 'Clear filters',
          click: function () { view.q = ''; view.category = 'all'; view.chain = 'all'; view.watchlistOnly = false; saveHash(); render(); }
        })
      ]));
      return wrap;
    }
    var body = make('tbody');
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var tr = make('tr', { class: r.w ? 'watch' : '' });
      tr.addEventListener('click', (function (slug) {
        return function () { view.selected = slug; saveHash(); showDetail(slug); };
      })(r.s));
      tr.appendChild(make('td', { class: 'num', text: String(r.r) }));
      var nameCell = make('td', { class: 'name' }, [make('b', { text: r.n })]);
      nameCell.appendChild(make('span', { text: r.s + (r.w ? ' · watchlist' : '') }));
      tr.appendChild(nameCell);
      tr.appendChild(make('td', { text: r.c || '—' }));
      tr.appendChild(make('td', { class: 'num', text: shortMoney(r.t) }));
      tr.appendChild(make('td', { class: 'num', text: changePct(r.g) }));
      var valCell = make('td', { class: 'num', text: shortMoney(r.v) });
      valCell.appendChild(make('span', { class: 'range', text: shortMoney(r.vLo) + ' – ' + shortMoney(r.vHi) }));
      tr.appendChild(valCell);
      tr.appendChild(make('td', { class: 'num', text: (r.o * 100).toFixed(1) + '%' }));
      tr.appendChild(make('td', { class: 'num', text: String(r.ls) }));
      tr.appendChild(make('td', null, [make('span', { class: 'tag ' + r.f.vd.toLowerCase(), text: r.f.vd })]));
      body.appendChild(tr);
    }
    var table = make('table', null, [
      make('thead', null, [make('tr', null, [
        sortHead('r', 'Rank'),
        sortHead('n', 'Protocol'),
        sortHead('c', 'Category'),
        sortHead('t', 'TVL'),
        sortHead('g', '7d'),
        sortHead('v', 'Implied value'),
        sortHead('o', 'Token odds'),
        sortHead('ls', 'Score'),
        sortHead('vd', 'Farm')
      ])]),
      body
    ]);
    wrap.appendChild(table);
    return wrap;
  }

  // ---- the live-token comps table
  function liveSection() {
    var body = make('tbody');
    for (var i = 0; i < DATA.live.length; i++) {
      var p = DATA.live[i];
      var tr = make('tr');
      tr.appendChild(make('td', { class: 'name' }, [make('b', { text: p.n })]));
      tr.appendChild(make('td', { text: p.c || '—' }));
      tr.appendChild(make('td', { class: 'num', text: shortMoney(p.t) }));
      tr.appendChild(make('td', { class: 'num', text: shortMoney(p.m) }));
      tr.appendChild(make('td', { class: 'num', text: p.m !== null && p.t > 0 ? (p.m / p.t).toFixed(2) : 'n/a' }));
      tr.appendChild(make('td', { class: 'num', text: changePct(p.g) }));
      body.appendChild(tr);
    }
    return make('section', { class: 'panel', style: 'margin-top: 20px;' }, [
      make('h2', { text: 'Live-token comps: what the market already values' }),
      make('p', { class: 'muted', text: 'The peers the model learns from. A live-token protocol\u2019s value is the market\u2019s, never a model\u2019s.' }),
      make('table', { style: 'margin-top: 10px;' }, [
        make('thead', null, [make('tr', null, [
          make('th', { scope: 'col', text: 'Protocol' }),
          make('th', { scope: 'col', text: 'Category' }),
          make('th', { scope: 'col', text: 'TVL' }),
          make('th', { scope: 'col', text: 'Market cap' }),
          make('th', { scope: 'col', text: 'MCap / TVL' }),
          make('th', { scope: 'col', text: '7d' })
        ])]),
        body
      ])
    ]);
  }

  // ---- full render
  function render() {
    boardEl.setAttribute('aria-busy', 'false');
    while (boardEl.firstChild) boardEl.removeChild(boardEl.firstChild);
    var shell = make('div', { class: 'shell' });
    shell.appendChild(make('div', { class: 'top' }, [
      make('div', null, [
        make('h1', { text: 'Token Radar' }),
        make('p', { class: 'sub', text: 'Pre-token protocols, ranked by implied launch value — from the snapshot\u2019s own figures: TVL, the live-token peers\u2019 market-cap-to-TVL ratio, and how long the protocol has run with no token.' })
      ]),
      make('span', { class: 'badge', text: 'Model ' + DATA.model_version })
    ]));
    var stripParts = [
      ['b', DATA.integrity.protocols + ' protocols'],
      ['t', ' in the snapshot · '],
      ['b', DATA.integrity.watchlist + ' on the watchlist'],
      ['t', ' · '],
      ['b', DATA.integrity.board + ' ranked'],
      ['t', ' · '],
      ['b', DATA.integrity.excluded_products + ' wrapped / staked products excluded'],
      ['t', ' · '],
      ['b', DATA.integrity.live_token + ' live-token protocols'],
      ['t', '. Snapshot ' + DATA.as_of + '. ' + DATA.integrity.note]
    ];
    var stripKids = [];
    for (var i = 0; i < stripParts.length; i++) {
      var part = stripParts[i];
      stripKids.push(part[0] === 'b' ? make('b', { text: part[1] }) : part[1]);
    }
    shell.appendChild(make('div', { class: 'strip' }, stripKids));
    shell.appendChild(validationPanels());
    shell.appendChild(filterBar());
    var list = visibleRows();
    shell.appendChild(make('p', { class: 'count', text: list.length + ' of ' + DATA.rows.length + ' rows shown. Click a row for its detail view and farm plan. Implied values carry a range: the leave-one-out median error, never a single precise number.' }));
    shell.appendChild(boardTable(list));
    shell.appendChild(liveSection());
    var credit = 'Source: ' + DATA.source + '. Model ' + DATA.model_version + '.';
    shell.appendChild(make('p', { class: 'note' }, [
      make('b', { text: 'Reading the board. ' }),
      'Implied value = TVL × peer ratio × liquidity × decay (methodology v2). The peer ratio is the mean market-cap-to-TVL ratio of the five most similar live-token protocols in the same category. Liquidity is 1.0 for direct-pool categories, 0.2 for LP-token-heavy yield categories, 0.5 otherwise — a stated proxy, since the snapshot carries no pool data. Token odds = market momentum × 0.5 (technical, neutral — the snapshot carries no audit data) × the mature peers\u2019 launch rate. Farm verdicts price gas only: yield is not in the snapshot and is never invented. ',
      credit
    ]));
    boardEl.appendChild(shell);
    if (view.selected) showDetail(view.selected);
    else if (detailEl.open) detailEl.close();
  }

  // ---- the detail dialog
  function kvCell(label, value) {
    var valueNode = typeof value === 'string' ? make('span', { class: 'num', text: value }) : value;
    return make('div', null, [make('span', { text: label }), valueNode]);
  }
  function splitStep(step) {
    var atCost = step.indexOf(' Cost: ');
    var atTime = step.indexOf(' Time: ');
    if (atCost === -1 || atTime === -1) return { head: step, tail: '' };
    var head = step.substring(0, atCost) + ' ';
    var tail = 'Cost: ' + step.substring(atCost + 8, atTime) + ' Time: ' + step.substring(atTime + 8);
    return { head: head, tail: tail };
  }
  function showDetail(slug) {
    var r = findRow(slug);
    if (!r) return;
    while (detailEl.firstChild) detailEl.removeChild(detailEl.firstChild);
    var wrap = make('div', { class: 'detail' });
    wrap.appendChild(make('h2', { text: r.n + ' — rank ' + r.r }));
    wrap.appendChild(make('p', { class: 'meta', text: (r.c || 'Uncategorised') + ' · ' + (r.ch || []).join(', ') + ' · ' + r.s + (r.w ? ' · watchlist' : '') + ' · listed ' + (r.l || 'unknown') + (r.a !== null ? ' (' + ageLabel(r.a) + ' ago)' : '') }));
    var verdictTag = make('span', { class: 'tag ' + r.f.vd.toLowerCase(), text: r.f.vd });
    var kv = make('div', { class: 'kv' }, [
      kvCell('TVL', longMoney(r.t)),
      kvCell('7-day change', changePct(r.g)),
      kvCell('Implied launch value', longMoney(r.v)),
      kvCell('Implied range', shortMoney(r.vLo) + ' – ' + shortMoney(r.vHi)),
      kvCell('Peer ratio (MCap/TVL)', r.m.toFixed(3)),
      kvCell('Liquidity factor', r.lf.toFixed(1) + ' (category proxy)'),
      kvCell('Token odds', (r.o * 100).toFixed(1) + '%'),
      kvCell('Mature peers with a token', r.ow + ' of ' + r.op),
      kvCell('Launch score', String(r.ls) + ' / 100'),
      kvCell('Farm verdict', verdictTag),
      kvCell('Farm cost', '$' + r.f.cph + '/hr · net $' + r.f.net + '/hr'),
      kvCell('Plan gas / capital', '$' + r.f.tg + ' gas · $' + r.f.cap + ' cap (' + r.f.gs + '%) · ' + r.f.hold + 'd')
    ]);
    wrap.appendChild(kv);
    wrap.appendChild(make('h3', { text: 'Farm plan — six steps, costed' }));
    var steps = make('ol', { class: 'steps' });
    var rendered = planSteps(r);
    for (var i = 0; i < rendered.length; i++) {
      var parts = splitStep(rendered[i]);
      steps.appendChild(make('li', null, [
        make('span', { text: parts.head }),
        make('span', { class: 'cost', text: parts.tail })
      ]));
    }
    wrap.appendChild(steps);
    wrap.appendChild(make('div', { class: 'actions' }, [
      make('button', { class: 'button primary', type: 'button', text: 'Close', click: hideDetail })
    ]));
    detailEl.appendChild(wrap);
    if (!detailEl.open) detailEl.showModal();
  }
  function hideDetail() {
    view.selected = null;
    saveHash();
    if (detailEl.open) detailEl.close();
  }
  detailEl.addEventListener('close', function () { view.selected = null; saveHash(); });

  // ---- CSV download of the filtered rows
  var CSV_HEADERS = ['rank', 'slug', 'name', 'category', 'tvl_usd', 'change_7d', 'implied_value_usd', 'implied_low_usd', 'implied_high_usd', 'token_odds', 'launch_score', 'farm_verdict'];
  function csvField(value) {
    if (value === null || value === undefined) return '';
    var text = String(value);
    if (text.indexOf(',') >= 0 || text.indexOf('"') >= 0) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }
  function downloadCsv() {
    var list = visibleRows();
    var lines = [CSV_HEADERS.join(',')];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var fields = [r.r, r.s, r.n, r.c, r.t, r.g, r.v, r.vLo, r.vHi, r.o, r.ls, r.f.vd];
      var cells = [];
      for (var j = 0; j < fields.length; j++) cells.push(csvField(fields[j]));
      lines.push(cells.join(','));
    }
    var csv = lines.join('\n');
    var blob = new Blob([csv], { type: 'text/csv' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'token-radar-board.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  loadHash();
  render();
  window.addEventListener('hashchange', function () { loadHash(); render(); });
})();
