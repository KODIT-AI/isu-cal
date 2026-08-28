/* ==========================================================================
   연장결제기일 간이 계산기
   ------------------------------------------------------------------------
   계산 규칙 (영업일 기준)

     ① 결제기간 기산일 = 물품인도일이 속한 달의 "다음 달 1일"
                        (그날이 휴일이면 다음 영업일이 1일째가 됩니다)
     ② 결제기일       = 기산일을 1일째로 하여 결제기간만큼 "영업일"을 센 날
     ③ 연장결제기일    = 결제기일에 2개월을 더한 날 (2개월 뒤 같은 날짜)
                        · 그 날짜가 없으면 해당 월의 말일
                        · 그날이 휴일이면 다음 영업일로 이월

   영업일 = 토·일요일과 관공서 공휴일을 제외한 날
   ========================================================================== */
(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════
     ① 설정
     ══════════════════════════════════════════════════════════ */
  var USE_BUSINESS_DAYS = true;  // false 로 두면 역일(달력일) 기준으로 계산합니다
  var DEFAULT_DAYS = 31;         // '모름' 선택 시 (다음 달 월말결제)
  var MIN_DAYS     = 1;
  var MAX_DAYS     = 180;
  var GRACE_MONTHS = 2;          // 결제기일 이후 연장 개월 수
  var MOBILE_QUERY = '(max-width:680px)';

  /* ══════════════════════════════════════════════════════════
     ② 공휴일 목록 — js/holidays.js 에서 가져옵니다.
        · 공휴일 데이터를 갱신할 때는 이 파일이 아니라 js/holidays.js를
          수정하세요. (이 파일은 계산 로직만 담당합니다.)
        · index.html에서 holidays.js가 app.js보다 먼저 로드되어야 합니다.
     ══════════════════════════════════════════════════════════ */
  var HOLIDAY_DATA = window.HOLIDAY_DATA || { list: [], coverage: { from: '', to: '' } };
  var HOLIDAY_LIST = HOLIDAY_DATA.list;
  var COVERAGE     = HOLIDAY_DATA.coverage;

  /* 공휴일 목록 범위를 벗어난 날짜를 계산했을 때, 화면에 보여줄 안내 문구.
     (개발자용 표현 대신 사용자 관점에서 오해가 없도록 작성합니다.) */
  var OUT_OF_RANGE_MESSAGE =
    '연장결제기일이 공휴일인 경우에는 그 익일에 만료됩니다. ' +
    '자세한 내용은 보험센터로 문의해 주세요.';
 
  var HOLIDAYS = {};
  for (var h = 0; h < HOLIDAY_LIST.length; h++) { HOLIDAYS[HOLIDAY_LIST[h]] = true; }

  var WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  var SANS = '"Pretendard","Apple SD Gothic Neo","Malgun Gothic","맑은 고딕",sans-serif';
  var C = {
    ink:'#16233B', muted:'#6E7889', line:'#E3E7EE', field:'#F5F7FA',
    accent:'#B01B2E', accentSoft:'#FCEFF1', accentLine:'#EBC3C9', accentText:'#6B2029'
  };

  var state = {
    days: 0, delivery: null, start: null, due: null, base: null,
    clamped: false, moved: false, spanA: 0, spanB: 0, pct: 50, outOfRange: false
  };

  /* ── DOM ────────────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  var deliveryDate  = $('deliveryDate');
  var periodDays    = $('periodDays');
  var periodGuide   = $('periodGuide');
  var modeUnknown   = $('modeUnknown');
  var modeManual    = $('modeManual');
  var deliveryError = $('deliveryError');
  var periodError   = $('periodError');
  var panel         = $('panel');
  var captureBtn    = $('captureBtn');
  var captureNote   = $('captureNote');

  function isMobile() { return window.matchMedia(MOBILE_QUERY).matches; }

  /* ══════════════════════════════════════════════════════════
     ③ 날짜 유틸 (UTC 고정 · 타임존 영향 없음)
     ══════════════════════════════════════════════════════════ */
  function toDate(iso) {
    var p = iso.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  }
  function toIso(dt) {
    return dt.getUTCFullYear() + '-' +
           String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' +
           String(dt.getUTCDate()).padStart(2, '0');
  }
  function lastDayOfMonth(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  }
  function nextMonthFirst(dt) {
    return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1));
  }
  function addDays(dt, n) {
    var d = new Date(dt.getTime());
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  }
  function addMonths(dt, n) {
    var day    = dt.getUTCDate();
    var target = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + n, 1));
    var last   = lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth());
    target.setUTCDate(Math.min(day, last));
    return { date: target, clamped: day > last };
  }
  function diffDays(a, b) { return Math.round((b - a) / 86400000); }

  function isHoliday(dt) { return !!HOLIDAYS[toIso(dt)]; }
  function isBusinessDay(dt) {
    var w = dt.getUTCDay();
    if (w === 0 || w === 6) { return false; }
    return !isHoliday(dt);
  }
  /** from 을 1일째로 하여 영업일 n일을 센 날. from 이 휴일이면 다음 영업일이 1일째. */
  function countBusinessDays(from, n) {
    var d = new Date(from.getTime());
    var counted = 0, guard = 0;
    while (guard < 4000) {
      if (isBusinessDay(d)) {
        counted++;
        if (counted === n) { return d; }
      }
      d.setUTCDate(d.getUTCDate() + 1);
      guard++;
    }
    return d;
  }
  /** 휴일이면 다음 영업일로 이월 */
  function nextBusinessDay(dt) {
    var d = new Date(dt.getTime());
    var guard = 0;
    while (!isBusinessDay(d) && guard < 60) {
      d.setUTCDate(d.getUTCDate() + 1);
      guard++;
    }
    return d;
  }

  function fmt(dt) {
    return dt.getUTCFullYear() + '. ' +
           String(dt.getUTCMonth() + 1).padStart(2, '0') + '. ' +
           String(dt.getUTCDate()).padStart(2, '0') + '. (' +
           WEEKDAYS[dt.getUTCDay()] + ')';
  }
  function fmtShort(dt) {
    return dt.getUTCFullYear() + '.' +
           String(dt.getUTCMonth() + 1).padStart(2, '0') + '.' +
           String(dt.getUTCDate()).padStart(2, '0');
  }
  function fmtFile(dt) {
    return '' + dt.getUTCFullYear() +
           String(dt.getUTCMonth() + 1).padStart(2, '0') +
           String(dt.getUTCDate()).padStart(2, '0');
  }
  function todayUTC() {
    var n = new Date();
    return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  }

  /* ══════════════════════════════════════════════════════════
     ④ 커스텀 달력
        브라우저 기본 달력의 버튼 문구(안드로이드의 '설정' 등)는
        OS·브라우저가 그리는 것이라 웹에서 바꿀 수 없습니다.
        그래서 달력을 직접 만들어 '취소 / 확인' 으로 통일했습니다.
     ══════════════════════════════════════════════════════════ */
  var dpPop    = $('dpPop');
  var dpGrid   = $('dpGrid');
  var dpYear   = $('dpYear');
  var dpMonth  = $('dpMonth');
  var dpBackdrop = null;
  var dpView   = todayUTC();   // 보고 있는 달
  var dpPicked = null;         // 팝업 안에서 고른 날짜 (확인 눌러야 확정)

  var YEAR_FROM = 2020, YEAR_TO = 2035;

  (function initSelects() {
    var y, opt;
    for (y = YEAR_FROM; y <= YEAR_TO; y++) {
      opt = document.createElement('option');
      opt.value = y; opt.textContent = y + '년';
      dpYear.appendChild(opt);
    }
    for (y = 1; y <= 12; y++) {
      opt = document.createElement('option');
      opt.value = y - 1; opt.textContent = y + '월';
      dpMonth.appendChild(opt);
    }
  })();

  function renderCalendar() {
    dpYear.value  = dpView.getUTCFullYear();
    dpMonth.value = dpView.getUTCMonth();

    var y = dpView.getUTCFullYear(), m = dpView.getUTCMonth();
    var first = new Date(Date.UTC(y, m, 1));
    var lead  = first.getUTCDay();
    var start = addDays(first, -lead);
    var today = toIso(todayUTC());
    var picked = dpPicked ? toIso(dpPicked) : '';

    dpGrid.innerHTML = '';
    for (var i = 0; i < 42; i++) {
      var d = addDays(start, i);
      var iso = toIso(d);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dp-day';
      b.textContent = d.getUTCDate();
      b.setAttribute('data-iso', iso);

      if (d.getUTCMonth() !== m) { b.className += ' is-out'; }
      if (d.getUTCDay() === 0)   { b.className += ' is-sun'; }
      if (d.getUTCDay() === 6)   { b.className += ' is-sat'; }
      if (isHoliday(d))          { b.className += ' is-holiday'; b.title = '공휴일'; }
      if (iso === today)         { b.className += ' is-today'; }
      if (iso === picked)        { b.className += ' is-picked'; }

      dpGrid.appendChild(b);
    }
  }

  function openPicker() {
    dpPicked = deliveryDate.value ? toDate(deliveryDate.value) : todayUTC();
    dpView   = new Date(dpPicked.getTime());

    if (isMobile()) {
      if (!dpBackdrop) {
        dpBackdrop = document.createElement('div');
        dpBackdrop.className = 'dp-backdrop';
        dpBackdrop.addEventListener('click', closePicker);
        document.body.appendChild(dpBackdrop);
      }
      dpBackdrop.hidden = false;
    }

    renderCalendar();
    dpPop.hidden = false;
    deliveryDate.setAttribute('aria-expanded', 'true');
    setTimeout(function () { $('dpOk').focus(); }, 0);
  }

  function closePicker() {
    dpPop.hidden = true;
    if (dpBackdrop) { dpBackdrop.hidden = true; }
    deliveryDate.setAttribute('aria-expanded', 'false');
  }

  function confirmPicker() {
    if (dpPicked) {
      deliveryDate.value = toIso(dpPicked);
      deliveryError.textContent = '';
    }
    closePicker();
  }

  function shiftMonth(delta) {
    dpView = new Date(Date.UTC(dpView.getUTCFullYear(), dpView.getUTCMonth() + delta, 1));
    renderCalendar();
  }

  deliveryDate.addEventListener('click', openPicker);
  deliveryDate.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
  });
  $('dpOpen').addEventListener('click', function (e) { e.stopPropagation(); openPicker(); });
  $('dpPrev').addEventListener('click', function () { shiftMonth(-1); });
  $('dpNext').addEventListener('click', function () { shiftMonth(1); });
  $('dpCancel').addEventListener('click', closePicker);
  $('dpOk').addEventListener('click', confirmPicker);
  $('dpToday').addEventListener('click', function () {
    dpPicked = todayUTC();
    dpView = new Date(dpPicked.getTime());
    renderCalendar();
  });
  dpYear.addEventListener('change', function () {
    dpView = new Date(Date.UTC(+this.value, dpView.getUTCMonth(), 1));
    renderCalendar();
  });
  dpMonth.addEventListener('change', function () {
    dpView = new Date(Date.UTC(dpView.getUTCFullYear(), +this.value, 1));
    renderCalendar();
  });
  function dayButton(target) {
    return (target && target.closest) ? target.closest('.dp-day') : null;
  }

  dpGrid.addEventListener('click', function (e) {
    e.stopPropagation();               // 바깥클릭 감지 핸들러로 새어나가지 않게 막습니다
    var btn = dayButton(e.target);
    if (!btn) { return; }

    dpPicked = toDate(btn.getAttribute('data-iso'));

    // 지난달/다음달 칸을 눌렀을 때만 달력을 다시 그립니다.
    // 같은 달이면 클래스만 옮겨서, 눌린 버튼이 DOM에서 사라지지 않게 합니다.
    if (dpPicked.getUTCFullYear() !== dpView.getUTCFullYear() ||
        dpPicked.getUTCMonth()    !== dpView.getUTCMonth()) {
      dpView = new Date(dpPicked.getTime());
      renderCalendar();
    } else {
      var prev = dpGrid.querySelector('.dp-day.is-picked');
      if (prev) { prev.className = prev.className.replace(/\s*is-picked/, ''); }
      btn.className += ' is-picked';
    }
  });

  dpGrid.addEventListener('dblclick', function (e) {
    e.stopPropagation();
    if (dayButton(e.target)) { confirmPicker(); }
  });

  document.addEventListener('click', function (e) {
    if (dpPop.hidden) { return; }
    // 다시 그려지면서 DOM에서 빠진 요소는 '바깥 클릭'으로 오인하면 안 됩니다
    if (!document.contains(e.target)) { return; }
    if (!$('dp').contains(e.target)) { closePicker(); }
  });
  document.addEventListener('keydown', function (e) {
    if (!dpPop.hidden && e.key === 'Escape') { closePicker(); }
  });

  /* ══════════════════════════════════════════════════════════
     ⑤ 입력 동작
     ══════════════════════════════════════════════════════════ */
  function applyMode() {
    var manual = modeManual.checked;
    periodDays.readOnly = !manual;
    periodGuide.classList.toggle('is-hidden', manual);

    if (manual) {
      periodDays.value = '';
      periodDays.focus();
    } else {
      periodDays.value = String(DEFAULT_DAYS);
      periodError.textContent = '';
    }
  }
  modeUnknown.addEventListener('change', applyMode);
  modeManual.addEventListener('change', applyMode);

  periodDays.addEventListener('input', function () {
    this.value = this.value.replace(/[^0-9]/g, '').slice(0, 3);
    periodError.textContent = '';
  });

  /* ══════════════════════════════════════════════════════════
     ⑥ 계산
     ══════════════════════════════════════════════════════════ */
  function calculate() {
    var ok = true;
    deliveryError.textContent = '';
    periodError.textContent = '';
    captureNote.classList.remove('is-open');

    var iso = deliveryDate.value;
    if (!iso) {
      deliveryError.textContent = '물품인도일을 선택하세요.';
      ok = false;
    }

    var days = parseInt(periodDays.value, 10);
    if (!periodDays.value) {
      periodError.textContent = '결제기간 일수를 입력하세요.';
      ok = false;
    } else if (isNaN(days) || days < MIN_DAYS || days > MAX_DAYS) {
      periodError.textContent = '결제기간은 ' + MIN_DAYS + '일에서 ' + MAX_DAYS + '일 사이로 입력하세요.';
      ok = false;
    }

    if (!ok) {
      panel.classList.remove('is-open');
      if (deliveryError.textContent) { openPicker(); } else { periodDays.focus(); }
      return;
    }

    var delivery = toDate(iso);
    var start    = nextMonthFirst(delivery);                 // ① 다음 달 1일
    var due, base, grace, moved = false;

    if (USE_BUSINESS_DAYS) {
      due   = countBusinessDays(start, days);                // ② 영업일 기준
      grace = addMonths(due, GRACE_MONTHS);                  // ③ 2개월 뒤
      base  = nextBusinessDay(grace.date);                   //    휴일이면 이월
      moved = toIso(base) !== toIso(grace.date);
    } else {
      due   = addDays(start, days - 1);                      // 역일 기준
      grace = addMonths(due, GRACE_MONTHS);
      base  = grace.date;
    }

    state.days     = days;
    state.delivery = delivery;
    state.start    = start;
    state.due      = due;
    state.base     = base;
    state.clamped  = grace.clamped;
    state.moved    = moved;
    state.outOfRange = USE_BUSINESS_DAYS &&
                       (toIso(delivery) < COVERAGE.from || toIso(base) > COVERAGE.to);

    render();
    panel.classList.add('is-open');
    adjustMidMark();
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function unitLabel() { return USE_BUSINESS_DAYS ? '영업일' : '일'; }

  function render() {
    var spanA = diffDays(state.delivery, state.due);
    var spanB = diffDays(state.due, state.base);
    var pct   = (spanA + spanB) > 0 ? (spanA / (spanA + spanB)) * 100 : 50;

    state.spanA = spanA;
    state.spanB = spanB;
    state.pct   = pct;

    $('segA').style.width = pct.toFixed(2) + '%';
    $('segB').style.width = (100 - pct).toFixed(2) + '%';
    $('segAText').textContent = '결제기간 ' + state.days + unitLabel();
    $('markMid').style.left = pct.toFixed(2) + '%';

    $('outDelivery').textContent = fmt(state.delivery);
    $('outDue').textContent      = fmt(state.due);
    $('outBaseline').textContent = fmt(state.base);
    $('verdictDate').textContent = fmt(state.base);

    $('pillStart').textContent  = '기산 ' + fmtShort(state.start);
    $('panelBasis').textContent = '결제기간 ' + state.days + unitLabel();

    var notes = [];
    if (state.outOfRange) { notes.push(OUT_OF_RANGE_MESSAGE); }
    /* 아래 두 안내는 필요할 경우 주석을 해제해 사용하세요.
    if (state.clamped) { notes.push('2개월 뒤 같은 날짜가 없어 그 달의 말일로 계산했습니다.'); }
    if (state.moved)   { notes.push('연장결제기일이 휴일이라 다음 영업일로 이월했습니다.'); }
    */
    $('adjustNote').textContent = notes.join(' ');
  }

  /* 결제기일 라벨이 좌우 라벨과 겹치지 않도록 가로 위치를 보정합니다. */
  function adjustMidMark() {
    var body = $('midBody');
    if (isMobile()) { body.style.transform = ''; return; }

    body.style.transform = 'translateX(-50%)';

    var marks = document.querySelector('.tl-marks');
    var total = marks.clientWidth;
    if (!total) { return; }

    var bodyW  = body.offsetWidth;
    var startW = document.querySelector('.tl-start').offsetWidth;
    var endW   = document.querySelector('.tl-end').offsetWidth;

    var center = total * state.pct / 100;
    var minC   = startW + 18 + bodyW / 2;
    var maxC   = total - endW - 18 - bodyW / 2;

    var offset = 0;
    if (minC <= maxC) {
      offset = Math.max(minC, Math.min(maxC, center)) - center;
    }
    body.style.transform = 'translateX(calc(-50% + ' + Math.round(offset) + 'px))';
  }

  function reset() {
    deliveryDate.value = '';
    modeUnknown.checked = true;
    periodDays.value = String(DEFAULT_DAYS);
    periodDays.readOnly = true;
    periodGuide.classList.remove('is-hidden');
    deliveryError.textContent = '';
    periodError.textContent = '';
    captureNote.classList.remove('is-open');
    panel.classList.remove('is-open');
    closePicker();
    deliveryDate.focus();
  }

  $('calcBtn').addEventListener('click', calculate);
  $('resetBtn').addEventListener('click', reset);

  /* 인쇄 시에는 '유의사항'이 접혀 있어도 함께 출력되도록 펼칩니다. */
  var notesBox = $('notesBox');
  var notesWasOpen = false;
  function openNotesForPrint() {
    if (!notesBox) { return; }
    notesWasOpen = notesBox.open;
    notesBox.open = true;
  }
  function restoreNotesAfterPrint() {
    if (!notesBox) { return; }
    notesBox.open = notesWasOpen;
  }
  $('printBtn').addEventListener('click', function () {
    openNotesForPrint();
    window.print();
  });
  window.addEventListener('beforeprint', openNotesForPrint);
  window.addEventListener('afterprint', restoreNotesAfterPrint);

  window.addEventListener('resize', function () {
    if (panel.classList.contains('is-open')) { adjustMidMark(); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target === periodDays) {
      e.preventDefault();
      calculate();
    }
  });

  /* ══════════════════════════════════════════════════════════
     ⑦ 결과 이미지 생성 (모바일 '캡쳐하기' — 외부 라이브러리 없음)
     ══════════════════════════════════════════════════════════ */
  function wrapText(g, text, x, y, maxW, lh) {
    var chars = text.split(''), line = '';
    for (var i = 0; i < chars.length; i++) {
      var test = line + chars[i];
      if (g.measureText(test).width > maxW && line !== '') {
        g.fillText(line, x, y);
        y += lh;
        line = chars[i];
      } else {
        line = test;
      }
    }
    if (line) { g.fillText(line, x, y); y += lh; }
    return y;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y,     x + w, y + h, r);
    g.arcTo(x + w, y + h, x,     y + h, r);
    g.arcTo(x,     y + h, x,     y,     r);
    g.arcTo(x,     y,     x + w, y,     r);
    g.closePath();
  }

  function drawResult(g, W, H) {
    var P = 40, cw = W - P * 2;

    g.fillStyle = '#FFFFFF';
    g.fillRect(0, 0, W, H);

    /* 머리말 */
    g.textAlign = 'left';
    g.fillStyle = C.ink;
    g.font = 'bold 26px ' + SANS;
    g.fillText('연장결제기일 간이 계산기', P, 58);
    g.fillStyle = C.muted;
    g.font = '13px ' + SANS;
    g.fillText('결제기간 ' + state.days + unitLabel(), P, 84);

    /* 참고용 안내 */
    var ny = 112;
    g.fillStyle = C.accent;
    g.font = 'bold 13px ' + SANS;
    var alertTxt = '본 계산 결과는 참고용 입니다.';
    g.fillText(alertTxt, P, ny);
    var aw0 = g.measureText(alertTxt).width;
    g.fillStyle = C.muted;
    g.font = '13px ' + SANS;
    ny = wrapText(g, ' 공신력은 없으니 정확한 내용은 보험센터로 문의해 주세요.',
                  P + aw0, ny, cw - aw0, 21);
    ny = wrapText(g, '본 계산기는 물품인도일에 발생한 매출채권에 대해서만 연장결제기일을 계산합니다.',
                  P, ny + 2, cw, 21);

    /* 기간 비율 막대 */
    var by = ny + 16, bh = 32;
    var aw = Math.round(cw * state.spanA / (state.spanA + state.spanB));
    g.fillStyle = C.ink;     g.fillRect(P, by, aw, bh);
    g.fillStyle = C.accent;  g.fillRect(P + aw, by, cw - aw, bh);
    g.fillStyle = '#FFFFFF'; g.fillRect(P + aw - 1, by, 2, bh);

    g.font = 'bold 12.5px ' + SANS;
    g.textAlign = 'center';
    g.fillStyle = '#FFFFFF';
    g.fillText('결제기간 ' + state.days + unitLabel(), P + aw / 2, by + 21);
    g.fillText('결제기일 + ' + GRACE_MONTHS + '개월', P + aw + (cw - aw) / 2, by + 21);

    /* 세로로 쌓은 3개 마커 */
    var y = by + bh + 32;
    var rows = [
      { label: '물품인도일',   date: fmt(state.delivery), pill: '기산 ' + fmtShort(state.start), final: false },
      { label: '결제기일',     date: fmt(state.due),      pill: '',                              final: false },
      { label: '연장결제기일', date: fmt(state.base),     pill: '',                              final: true  }
    ];

    g.textAlign = 'left';
    rows.forEach(function (r, i) {
      g.fillStyle = r.final ? C.accent : C.muted;
      g.font = (r.final ? 'bold ' : '') + '13px ' + SANS;
      g.fillText(r.label, P, y);

      g.fillStyle = r.final ? C.accent : C.ink;
      g.font = 'bold ' + (r.final ? 29 : 25) + 'px ' + SANS;
      g.fillText(r.date, P, y + (r.final ? 37 : 33));

      var step = r.final ? 62 : 66;
      if (r.pill) {
        var py = y + 52;
        g.font = 'bold 12px ' + SANS;
        var pw = g.measureText(r.pill).width + 22;
        roundRect(g, P, py, pw, 22, 11);
        g.fillStyle = C.field;
        g.fill();
        g.strokeStyle = C.line;
        g.lineWidth = 1;
        g.stroke();
        g.fillStyle = C.muted;
        g.fillText(r.pill, P + 11, py + 15);
        step = 96;
      }
      y += step;

      if (i < rows.length - 1) {
        g.strokeStyle = C.line;
        g.lineWidth = 1;
        g.setLineDash([4, 4]);
        g.beginPath();
        g.moveTo(P, y - 22.5);
        g.lineTo(P + cw, y - 22.5);
        g.stroke();
        g.setLineDash([]);
      }
    });

    /* 연장결제기일 안내 (도장 + 문장) */
    y += 6;
    var boxH = 104;
    g.fillStyle = C.accentSoft;
    g.fillRect(P, y, cw, boxH);
    g.strokeStyle = C.accentLine;
    g.lineWidth = 1;
    g.strokeRect(P + .5, y + .5, cw - 1, boxH - 1);
    g.fillStyle = C.accent;
    g.fillRect(P, y, 3, boxH);

    var sx = P + 20, sy = y + 22, sw = 96, sh = 42;
    roundRect(g, sx, sy, sw, sh, 6);
    g.strokeStyle = C.accent;
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = C.accent;
    g.font = 'bold 12.5px ' + SANS;
    g.textAlign = 'center';
    g.fillText('연장결제기일', sx + sw / 2, sy + 26);

    g.textAlign = 'left';
    var tx = sx + sw + 18, tw = P + cw - tx - 18;
    g.fillStyle = C.accentText;
    g.font = 'bold 14px ' + SANS;
    var dTxt = fmt(state.base) + ' 다음 날부터';
    g.fillText(dTxt, tx, y + 40);
    g.font = '14px ' + SANS;
    wrapText(g, '발생하는 매출채권(인도 물품)은 보험대상이 아닙니다.', tx, y + 64, tw, 22);

    /* 꼬리말 */
    y += boxH + 28;
    g.fillStyle = C.muted;
    g.font = '12px ' + SANS;
    y = wrapText(g, '결제기일은 물품인도일 다음 달 1일부터 영업일 기준으로 계산하며, ' +
                    ' 연장결제기일은 결제기일에 2개월을 합산한 날입니다.',
                 P, y, cw, 20);
 				 
	/*		
    y = wrapText(g, '결제기일은 물품인도일 다음 달 1일부터 ' + (USE_BUSINESS_DAYS ? '영업일' : '역일') +
                    ' 기준으로 계산하며, 연장결제기일은 결제기일에 ' + GRACE_MONTHS + '개월을 합산한 날입니다.',
                 P, y, cw, 20);
		 
    if (state.moved || state.clamped) {
      g.fillStyle = C.accent;
      g.font = 'bold 12px ' + SANS;
      wrapText(g, $('adjustNote').textContent, P, y + 4, cw, 19);
    }
	*/

    g.fillStyle = C.muted;
    g.font = '11.5px ' + SANS;
    g.fillText('실제 기준일은 보험증권 및 약관이 우선합니다.', P, H - 26);
  }

  function buildCanvas() {
    var W = 760, H = 830, S = 2;
    var cv = document.createElement('canvas');
    cv.width  = W * S;
    cv.height = H * S;
    var g = cv.getContext('2d');
    g.scale(S, S);
    drawResult(g, W, H);
    return cv;
  }

  function note(msg) {
    captureNote.textContent = msg;
    captureNote.classList.add('is-open');
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    if ('download' in a) {
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      note('이미지를 저장했습니다. 다운로드 폴더 또는 사진 앱에서 확인하세요.');
    } else {
      window.open(url, '_blank');
      note('새 창의 이미지를 길게 눌러 사진에 저장하세요.');
    }
  }

  captureBtn.addEventListener('click', function () {
    if (!state.base) { return; }
    captureNote.classList.remove('is-open');

    var cv = buildCanvas();
    var name = '연장결제기일_' + fmtFile(state.base) + '.png';

    var finish = function (blob) {
      if (!blob) { note('이미지를 만들지 못했습니다. 화면을 직접 캡쳐해 주세요.'); return; }

      // 모바일 공유 시트 (사진 저장 · 메신저 전송). HTTPS 환경에서만 동작합니다.
      if (navigator.canShare && navigator.share) {
        try {
          var file = new File([blob], name, { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file], title: '연장결제기일' })
              .catch(function (err) {
                if (!err || err.name !== 'AbortError') { downloadBlob(blob, name); }
              });
            return;
          }
        } catch (err) { /* 저장 방식으로 진행 */ }
      }
      downloadBlob(blob, name);
    };

    if (cv.toBlob) {
      cv.toBlob(finish, 'image/png');
    } else {
      var a = document.createElement('a');
      a.href = cv.toDataURL('image/png');
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  });
})();
