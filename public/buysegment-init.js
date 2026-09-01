// BuySegment page initialisation script
// Loaded via <script src> to avoid Turbopack parsing this JS as TypeScript.

(function () {
  // COMPLETE TRADING DATABASE
  var allScripts = [
    { name: "NIFTY FUT",     symbol: "NIFTY_FUT",     kiteInstrument: "NFO:NIFTY25MAYFUT",     price: 22456.80, change: "+0.45%", segment: "INDEX - FUTURE",  lotSize: 65,  maxLots: 100,  marginPercent: 0.12 },
    { name: "SENSEX FUT",    symbol: "SENSEX_FUT",    kiteInstrument: "BSE:SENSEX",             price: 74230.15, change: "+0.32%", segment: "INDEX - FUTURE",  lotSize: 20,  maxLots: 100,  marginPercent: 0.12 },
    { name: "BANKNIFTY FUT", symbol: "BANKNIFTY_FUT", kiteInstrument: "NFO:BANKNIFTY25MAYFUT", price: 48210.50, change: "-0.21%", segment: "INDEX - FUTURE",  lotSize: 30,  maxLots: 150,  marginPercent: 0.12 },
    { name: "RELIANCE FUT",  symbol: "RELIANCE_FUT",  kiteInstrument: "NFO:RELIANCE25MAYFUT",  price: 2856.40,  change: "+0.75%", segment: "STOCKS - FUTURE", lotSize: 250, maxLots: 50,   marginPercent: 0.15 },
    { name: "RELIANCE EQ",   symbol: "RELIANCE",      kiteInstrument: "NSE:RELIANCE",           price: 2845.30,  change: "+0.68%", segment: "NSE - EQ",        lotSize: 1,   maxLots: 5000, marginPercent: 0.20 },
    { name: "BTC/USDT",      symbol: "BTCUSDT",       kiteInstrument: "CRYPTO:BTC",             price: 68450.20, change: "+2.1%",  segment: "CRYPTO",          lotSize: 0.01,maxLots: 100,  marginPercent: 0.05 },
    { name: "GOLD FUT",      symbol: "GOLD_FUT",      kiteInstrument: "MCX:GOLD25MAYFUT",      price: 62340.00, change: "+0.28%", segment: "MCX - FUTURE",    lotSize: 1,   maxLots: 100,  marginPercent: 0.08 }
  ];

  var watchlistItems = [], selectedIndices = new Set(), selectionMode = false;
  var currentScript = null, currentTradeType = null, selectedAction = null, currentIsLotMode = false, currentOrderType = "market", currentProductType = "intraday", currentQuantity = 1;
  var BROKERAGE_FLAT = 5;

  setTimeout(function () {
    document.querySelectorAll('.footer-tab').forEach(function (tab) {
      tab.classList.remove('active');
      if (tab.getAttribute('data-tab') === 'buysegment') tab.classList.add('active');
    });
  }, 100);

  // DOM Elements
  var watchlistContainer = document.getElementById('watchlistMobileContainer');
  var watchlistCounter = document.getElementById('mobileWatchlistCounter');
  var searchInput = document.getElementById('globalSearchInput');
  var clearSearchBtn = document.getElementById('clearSearchBtn');
  var searchResultsArea = document.getElementById('searchResultsArea');
  var searchResultsList = document.getElementById('searchResultsList');
  var searchResultCount = document.getElementById('searchResultCount');
  var tradeSheet = document.getElementById('tradeSheet');
  var tradeSheetOverlay = document.getElementById('tradeSheetOverlay');
  var orderFullpage = document.getElementById('orderFullpage');
  var orderFullpageOverlay = document.getElementById('orderFullpageOverlay');
  var folderDrawer = document.getElementById('scriptsFolderDrawer');
  var openBtn = document.getElementById('openFolderMobileBtn');
  var closeDrawerBtn = document.getElementById('closeFolderDrawerBtn');
  var overlay = document.getElementById('drawerOverlay');
  var toastEl = document.getElementById('toastMessageMobile');
  var toastTimeout = null;

  function showToast(msg, isError) {
    if (toastTimeout) clearTimeout(toastTimeout);
    toastEl.textContent = msg;
    toastEl.style.background = isError ? "#C62E2E" : "#2C313F";
    toastEl.style.opacity = "1";
    toastTimeout = setTimeout(function () { toastEl.style.opacity = "0"; }, 2000);
  }

  function formatPrice(price) {
    var num = typeof price === 'number' ? price : parseFloat(price);
    return '\u20b9' + num.toLocaleString('en-IN', { minimumFractionDigits: 2 });
  }

  function formatPriceNumber(price) {
    var num = typeof price === 'number' ? price : parseFloat(price);
    return num.toLocaleString('en-IN', { minimumFractionDigits: 2 });
  }

  function generateBidAsk(script) {
    var price = script.price;
    return { bid: price * 0.9995, ask: price * 1.0005 };
  }

  function openTradeSheet(script) {
    currentScript = script;
    document.getElementById('tradeScriptName').innerText = script.name;
    document.getElementById('tradeSegment').innerText = script.segment;
    document.getElementById('tradeCmpValue').innerText = formatPrice(script.price);
    var isPositive = script.change.includes('+');
    document.getElementById('tradeChange').innerText = script.change;
    document.getElementById('tradeChange').className = 'sheet-change ' + (isPositive ? 'positive' : 'negative');
    var ba = generateBidAsk(script);
    document.getElementById('tradeBid').innerText = formatPrice(ba.bid);
    document.getElementById('tradeAsk').innerText = formatPrice(ba.ask);
    tradeSheet.classList.add('open');
    tradeSheetOverlay.classList.add('active');
  }

  function closeTradeSheet() {
    tradeSheet.classList.remove('open');
    tradeSheetOverlay.classList.remove('active');
  }

  function closeOrderFullpage() {
    orderFullpage.classList.remove('open');
    orderFullpageOverlay.classList.remove('active');
  }

  function updateLotInfoDisplay() {
    var lotSize = currentScript.lotSize || 1, maxLots = currentScript.maxLots || 100;
    var orderLots = currentIsLotMode ? currentQuantity : Math.floor(currentQuantity / lotSize);
    if (!currentIsLotMode && currentQuantity < lotSize) orderLots = 0;
    var totalQty = currentIsLotMode ? currentQuantity * lotSize : currentQuantity;
    document.getElementById('lotSizeValue').innerText = lotSize;
    document.getElementById('maxLotsValue').innerText = maxLots;
    document.getElementById('orderLotsValue').innerText = orderLots;
    document.getElementById('totalQtyValue').innerText = totalQty;
  }

  function updateMarginDisplay() {
    var lotSize = currentScript.lotSize || 1, actualQty = currentIsLotMode ? currentQuantity * lotSize : currentQuantity;
    var exposure = actualQty * currentScript.price, marginPercent = currentScript.marginPercent || 0.12;
    var requiredMargin = exposure * marginPercent, carryMargin = exposure * marginPercent * 1.5;
    document.getElementById('requiredMargin').innerHTML = formatPrice(requiredMargin);
    document.getElementById('carryMargin').innerHTML = formatPrice(carryMargin);
    document.getElementById('availableMargin').innerHTML = formatPrice(125000);
    var brokerageRow = document.getElementById('brokerageRow');
    if (currentOrderType === 'gtt') {
      brokerageRow.style.display = 'block';
      document.getElementById('brokerageAmount').innerHTML = '\u20b9' + BROKERAGE_FLAT + '.00';
    } else {
      brokerageRow.style.display = 'none';
    }
  }

  function openOrderFullpage(type) {
    currentTradeType = type;
    selectedAction = type;
    currentQuantity = 1;
    currentIsLotMode = false;
    currentOrderType = "market";
    document.getElementById('qtyLotSwitch').checked = false;
    document.getElementById('orderScriptName').innerText = currentScript.name;
    document.getElementById('orderSegment').innerText = currentScript.segment;
    document.getElementById('orderCmpValue').innerText = formatPrice(currentScript.price);
    var isPositive = currentScript.change.includes('+');
    document.getElementById('orderChange').innerText = currentScript.change;
    document.getElementById('orderChange').className = 'order-change ' + (isPositive ? 'positive' : 'negative');
    var ba = generateBidAsk(currentScript);
    document.getElementById('orderBid').innerText = formatPriceNumber(ba.bid);
    document.getElementById('orderAsk').innerText = formatPriceNumber(ba.ask);
    document.getElementById('orderQtyInput').value = currentQuantity;
    updateQuantityModeDisplay();
    updateMarginDisplay();
    updateLotInfoDisplay();
    document.querySelectorAll('[data-order-type]').forEach(function (b) { b.classList.remove('active'); });
    document.querySelector('[data-order-type="market"]').classList.add('active');
    document.getElementById('limitPriceContainer').style.display = 'none';
    document.getElementById('slmContainer').style.display = 'none';
    document.getElementById('gttContainer').style.display = 'none';
    document.querySelectorAll('[data-product-type]').forEach(function (b) { b.classList.remove('active'); });
    document.querySelector('[data-product-type="intraday"]').classList.add('active');
    var buyBtn = document.getElementById('confirmBuyBtn');
    var sellBtn = document.getElementById('confirmSellBtn');
    if (selectedAction === 'buy') {
      buyBtn.style.display = 'flex'; buyBtn.style.width = '100%'; sellBtn.style.display = 'none';
    } else {
      sellBtn.style.display = 'flex'; sellBtn.style.width = '100%'; buyBtn.style.display = 'none';
    }
    closeTradeSheet();
    orderFullpage.classList.add('open');
    orderFullpageOverlay.classList.add('active');
  }

  function updateQuantityModeDisplay() {
    var lotSize = currentScript.lotSize || 1;
    document.getElementById('qtyLabel').innerHTML = currentIsLotMode ? ('LOTS (1 Lot = ' + lotSize + ' units)') : "QUANTITY";
    document.getElementById('lotSizeInfo').innerHTML = currentIsLotMode
      ? ('Lot Size: ' + lotSize + ' | ' + currentQuantity + ' Lot = ' + (currentQuantity * lotSize) + ' Units')
      : ('Lot Size: ' + lotSize + ' | 1 Lot = ' + lotSize + ' Units');
    document.getElementById('orderQtyInput').value = currentQuantity;
    updateLotInfoDisplay();
    updateMarginDisplay();
  }

  function updateQuantity(value) {
    var lotSize = currentScript.lotSize || 1, maxLots = currentScript.maxLots || 100;
    var newVal = Math.max(1, Math.min(value, currentIsLotMode ? maxLots : maxLots * lotSize));
    currentQuantity = newVal;
    document.getElementById('orderQtyInput').value = currentQuantity;
    updateLotInfoDisplay();
    updateMarginDisplay();
  }

  function executeFinalOrder() {
    var lotSize = currentScript.lotSize || 1;
    var actualQty = currentIsLotMode ? currentQuantity * lotSize : currentQuantity;
    var price = currentScript.price;
    if (currentOrderType === 'limit') {
      var lp = parseFloat(document.getElementById('limitPriceInput').value);
      if (lp && lp > 0) price = lp;
    }
    var orderTypeMap = { market: 'MARKET', limit: 'LIMIT', slm: 'SLM', gtt: 'GTT' };
    var btn = document.getElementById(selectedAction === 'buy' ? 'confirmBuyBtn' : 'confirmSellBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Placing...'; }

    var bridge = window.__executeOrderViaBridge;
    var orderPayload = {
      symbol: currentScript.symbol,
      kite_instrument: currentScript.kiteInstrument || currentScript.symbol,
      segment: currentScript.segment,
      side: currentTradeType.toUpperCase(),
      order_type: orderTypeMap[currentOrderType] || 'MARKET',
      product_type: currentProductType === 'intraday' ? 'INTRADAY' : 'CARRY',
      qty: actualQty,
      lots: currentIsLotMode ? currentQuantity : Math.floor(actualQty / lotSize),
      client_price: price
    };

    var promise = bridge ? bridge(orderPayload) : Promise.resolve({ ok: false, error: 'Order bridge not ready' });

    promise.then(function (result) {
      if (result.ok) {
        showToast('\u2713 Order placed @ \u20b9' + result.fill_price.toLocaleString('en-IN', { minimumFractionDigits: 2 }));
      } else {
        showToast(result.error || 'Order failed. Try again.', true);
      }
    }).catch(function () {
      showToast('Network error. Please try again.', true);
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.innerHTML = selectedAction === 'buy' ? '<i class="fas fa-arrow-up"></i> BUY' : '<i class="fas fa-arrow-down"></i> SELL'; }
      closeOrderFullpage();
    });
  }

  // Event Listeners
  document.getElementById('qtyLotSwitch').addEventListener('change', function (e) { currentIsLotMode = e.target.checked; updateQuantityModeDisplay(); });
  document.getElementById('orderQtyMinus').addEventListener('click', function () { updateQuantity(currentQuantity - 1); });
  document.getElementById('orderQtyPlus').addEventListener('click', function () { updateQuantity(currentQuantity + 1); });
  document.getElementById('orderQtyInput').addEventListener('change', function (e) { updateQuantity(parseFloat(e.target.value) || 1); });

  document.querySelectorAll('[data-order-type]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('[data-order-type]').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentOrderType = btn.getAttribute('data-order-type');
      document.getElementById('limitPriceContainer').style.display = currentOrderType === 'limit' ? 'block' : 'none';
      document.getElementById('slmContainer').style.display = currentOrderType === 'slm' ? 'block' : 'none';
      document.getElementById('gttContainer').style.display = currentOrderType === 'gtt' ? 'block' : 'none';
      updateMarginDisplay();
    });
  });

  document.querySelectorAll('[data-product-type]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('[data-product-type]').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentProductType = btn.getAttribute('data-product-type');
    });
  });

  document.getElementById('confirmBuyBtn').addEventListener('click', function () { currentTradeType = 'buy'; executeFinalOrder(); });
  document.getElementById('confirmSellBtn').addEventListener('click', function () { currentTradeType = 'sell'; executeFinalOrder(); });
  document.getElementById('backToTradeSheetBtn').addEventListener('click', function () { closeOrderFullpage(); openTradeSheet(currentScript); });
  document.getElementById('proceedToOrderBuy').addEventListener('click', function () { openOrderFullpage('buy'); });
  document.getElementById('proceedToOrderSell').addEventListener('click', function () { openOrderFullpage('sell'); });
  tradeSheetOverlay.addEventListener('click', closeTradeSheet);
  orderFullpageOverlay.addEventListener('click', closeOrderFullpage);

  // Watchlist Functions
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]; });
  }

  function addToWatchlist(inst) {
    if (watchlistItems.some(function (i) { return i.symbol === inst.symbol; })) {
      showToast('Already in watchlist', true); return false;
    }
    watchlistItems.push(inst);
    renderWatchlist();
    showToast('\u2713 ' + inst.name + ' added');
    return true;
  }

  function renderWatchlist() {
    if (watchlistItems.length === 0) {
      watchlistContainer.innerHTML = '<div class="empty-watchlist"><i class="fas fa-plus-circle"></i><p>Your watchlist is empty</p><p>Search or tap Scripts Library +</p></div>';
      watchlistCounter.innerText = '0 items';
      return;
    }
    var html = '<div class="watchlist-card-list">';
    watchlistItems.forEach(function (item, idx) {
      var isPositive = item.change.includes('+'), changeClass = isPositive ? 'positive' : 'negative';
      html += '<div class="swipe-container" data-idx="' + idx + '"><div class="delete-background"><i class="fas fa-trash-alt"></i> Delete</div>' +
        '<div class="instrument-card" data-name="' + escapeHtml(item.name) + '" data-price="' + item.price + '" data-change="' + item.change + '" data-segment="' + escapeHtml(item.segment) + '" data-lotsize="' + item.lotSize + '" data-maxlots="' + item.maxLots + '" data-margin="' + item.marginPercent + '">' +
        '<div class="instrument-info"><div class="instrument-symbol">' + escapeHtml(item.name) + '</div><div class="instrument-name">' + escapeHtml(item.symbol) + '</div></div>' +
        '<div class="instrument-price-area"><div class="price-value">' + item.price + '</div><div class="change-badge ' + changeClass + '">' + item.change + '</div></div></div></div>';
    });
    html += '</div>';
    watchlistContainer.innerHTML = html;
    watchlistCounter.innerText = watchlistItems.length + ' items';

    document.querySelectorAll('.instrument-card').forEach(function (card) {
      var name = card.dataset.name, price = parseFloat(card.dataset.price), change = card.dataset.change, segment = card.dataset.segment;
      var lotSize = parseInt(card.dataset.lotsize), maxLots = parseInt(card.dataset.maxlots), marginPercent = parseFloat(card.dataset.margin);
      card.addEventListener('click', function () { openTradeSheet({ name: name, price: price, change: change, segment: segment, lotSize: lotSize, maxLots: maxLots, marginPercent: marginPercent }); });
    });

    document.querySelectorAll('.swipe-container').forEach(function (container) {
      var idx = parseInt(container.dataset.idx), startX = 0, isSwiping = false, card = container.querySelector('.instrument-card');
      function handleStart(e) { startX = e.touches ? e.touches[0].clientX : e.clientX; isSwiping = true; container.classList.add('swiping'); card.style.transition = 'none'; e.preventDefault(); }
      function handleMove(e) { if (!isSwiping) return; var delta = (e.touches ? e.touches[0].clientX : e.clientX) - startX; card.style.transform = 'translateX(' + Math.min(Math.max(delta, -80), 80) + 'px)'; e.preventDefault(); }
      function handleEnd(e) {
        if (!isSwiping) return; isSwiping = false; container.classList.remove('swiping'); card.style.transition = 'transform 0.3s';
        if (Math.abs(startX - (e.changedTouches ? e.changedTouches[0].clientX : e.clientX)) > 45) { watchlistItems.splice(idx, 1); renderWatchlist(); showToast('Removed'); }
        else { card.style.transform = 'translateX(0px)'; }
      }
      card.addEventListener('touchstart', handleStart, { passive: false });
      card.addEventListener('touchmove', handleMove, { passive: false });
      card.addEventListener('touchend', handleEnd);
    });
  }

  function performSearch(query) {
    var term = query.trim().toLowerCase();
    if (!term) { searchResultsArea.style.display = 'none'; clearSearchBtn.classList.remove('visible'); return; }
    clearSearchBtn.classList.add('visible');
    var filtered = allScripts.filter(function (s) { return s.name.toLowerCase().includes(term) || s.symbol.toLowerCase().includes(term); });
    if (!filtered.length) {
      searchResultsArea.style.display = 'block';
      searchResultCount.innerText = '0 results';
      searchResultsList.innerHTML = '<div class="no-results">No results</div>';
      return;
    }
    searchResultCount.innerText = filtered.length + ' results';
    var html = '<div class="search-result-list">';
    filtered.forEach(function (s) {
      html += '<div class="search-result-item"><div><div class="search-result-name">' + escapeHtml(s.name) + '</div><div class="search-result-symbol">' + escapeHtml(s.symbol) + '</div></div><div>' + s.price + '</div>' +
        '<button class="add-smart-btn" data-name="' + escapeHtml(s.name) + '" data-symbol="' + escapeHtml(s.symbol) + '" data-price="' + s.price + '" data-change="' + s.change + '" data-segment="' + escapeHtml(s.segment) + '" data-lotsize="' + s.lotSize + '" data-maxlots="' + s.maxLots + '" data-margin="' + s.marginPercent + '">Add</button></div>';
    });
    html += '</div>';
    searchResultsList.innerHTML = html;
    searchResultsArea.style.display = 'block';
    document.querySelectorAll('.add-smart-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        addToWatchlist({ name: btn.dataset.name, symbol: btn.dataset.symbol, price: parseFloat(btn.dataset.price), change: btn.dataset.change, segment: btn.dataset.segment, lotSize: parseInt(btn.dataset.lotsize), maxLots: parseInt(btn.dataset.maxlots), marginPercent: parseFloat(btn.dataset.margin) });
      });
    });
  }

  searchInput.addEventListener('input', function (e) { performSearch(e.target.value); });
  clearSearchBtn.addEventListener('click', function () { searchInput.value = ''; performSearch(''); });

  function buildFolderTree() {
    var container = document.getElementById('folderTreeMobile');
    if (!container) return;
    container.innerHTML = '<div style="padding:16px">Scripts Library - Tap + to add</div>';
  }

  function openDrawer() { folderDrawer.classList.add('open'); overlay.classList.add('active'); }
  function closeDrawer() { folderDrawer.classList.remove('open'); overlay.classList.remove('active'); }
  openBtn.addEventListener('click', openDrawer);
  closeDrawerBtn.addEventListener('click', closeDrawer);
  overlay.addEventListener('click', closeDrawer);

  renderWatchlist();
  buildFolderTree();
})();
