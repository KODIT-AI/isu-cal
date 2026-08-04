/* ==========================================================================
   이행지체 기준일 간이 계산기
   ------------------------------------------------------------------------
   계산 규칙

     ① 결제기간 기산일 = 물품인도일이 속한 달의 "다음 달 1일"
     ② 결제기일       = 기산일을 1일째로 하여 결제기간만큼 센 날
                        → 기산일 + (결제기간 − 1)일
     ③ 이행지체 기준일 = 결제기일의 2개월 뒤 같은 날짜
                        (그 날짜가 없으면 해당 월의 말일로 보정)

   예) 물품인도일 2026-08-20, 결제기간 31일
       ① 기산일 2026-09-01
       ② 결제기일 2026-09-01 + 30일 = 2026-10-01
       ③ 이행지체 기준일 2026-12-01
   ========================================================================== */
(function () {
  'use strict';

  /* ── 설정 ───────────────────────────────────────────────── */
  var DEFAULT_DAYS = 31;   // '모름' 선택 시 (다음 달 월말결제)
  var MIN_DAYS     = 1;
  var MAX_DAYS     = 180;
  var GRACE_MONTHS = 2;    // 결제기일 이후 연장 결제 기간(개월)
  var MOBILE_QUERY = '(max-width:680px)';

  var WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  var SANS = '"Pretendard","Apple SD Gothic Neo","Malgun Gothic","맑은 고딕",sans-serif';
  var C = {
    ink:        '#16233B',
    muted:      '#6E7889',
    line:       '#E3E7EE',
    field:      '#F5F7FA',
    accent:     '#B01B2E',
    accentSoft: '#FCEFF1',
    accentLine: '#EBC3C9',
    accentText: '#6B2029'
  };

  var state = {
    days: 0, delivery: null, start: null, due: null, base: null,
    clamped: false, spanA: 0, spanB: 0, pct: 50
  };

  /* ── DOM ────────────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  var deliveryDate  = $('deliveryDate');
  var periodDays    = $('periodDays');
  var modeUnknown   = $('modeUnknown');
  var modeManual    = $('modeManual');
  var deliveryError = $('deliveryError');
  var periodError   = $('periodError');
  var panel         = $('panel');
  var captureBtn    = $('captureBtn');
  var captureNote   = $('captureNote');

  function isMobile() { return window.matchMedia(MOBILE_QUERY).matches; }

  /* ── 날짜 유틸 (UTC 고정 · 타임존 영향 없음) ─────────────── */
  function toDate(iso) {
    var p = iso.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  }
  function lastDayOfMonth(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  }

  /** ① 해당 날짜가 속한 달의 다음 달 1일 */
  function nextMonthFirst(dt) {
    return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1));
  }
  /** n일 뒤 */
  function addDays(dt, n) {
    var d = new Date(dt.getTime());
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  }
  /** ③ n개월 뒤 같은 날짜 (없으면 말일로 보정) */
  function addMonths(dt, n) {
    var day    = dt.getUTCDate();
    var target = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + n, 1));
    var last   = lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth());
    target.setUTCDate(Math.min(day, last));
    return { date: target, clamped: day > last };
  }
  function diffDays(a, b) { return Math.round((b - a) / 86400000); }

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

  /* ── 입력 동작 ──────────────────────────────────────────── */
  function applyMode() {
    var manual = modeManual.checked;
    periodDays.readOnly = !manual;
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
  deliveryDate.addEventListener('input', function () {
    deliveryError.textContent = '';
  });

  /* ── 계산 ───────────────────────────────────────────────── */
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
      (deliveryError.textContent ? deliveryDate : periodDays).focus();
      return;
    }

    var delivery = toDate(iso);
    var start    = nextMonthFirst(delivery);        // ① 다음 달 1일
    var due      = addDays(start, days - 1);        // ② 기산일을 1일째로 포함
    var grace    = addMonths(due, GRACE_MONTHS);    // ③ 2개월 뒤 같은 날짜

    state.days     = days;
    state.delivery = delivery;
    state.start    = start;
    state.due      = due;
    state.base     = grace.date;
    state.clamped  = grace.clamped;

    render();
    panel.classList.add('is-open');
    adjustMidMark();
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function render() {
    var spanA = diffDays(state.delivery, state.due);  // 물품인도일 → 결제기일 (역일)
    var spanB = diffDays(state.due, state.base);      // 결제기일 → 이행지체 기준일 (역일)
    var pct   = (spanA + spanB) > 0 ? (spanA / (spanA + spanB)) * 100 : 50;

    state.spanA = spanA;
    state.spanB = spanB;
    state.pct   = pct;

    $('segA').style.width = pct.toFixed(2) + '%';
    $('segB').style.width = (100 - pct).toFixed(2) + '%';
    $('segAText').textContent = '결제기간 ' + state.days + '일';
    $('markMid').style.left = pct.toFixed(2) + '%';

    $('outDelivery').textContent = fmt(state.delivery);
    $('outDue').textContent      = fmt(state.due);
    $('outBaseline').textContent = fmt(state.base);
    $('verdictDate').textContent = fmt(state.base);

    $('pillStart').textContent = '기산 ' + fmtShort(state.start);
    $('pillDue').textContent   = 'D+' + spanA;
    $('pillBase').textContent  = 'D+' + (spanA + spanB);

    $('panelBasis').textContent = '결제기간 ' + state.days + '일';
    $('clampNote').textContent  = state.clamped
      ? '2개월 뒤 같은 날짜가 없어 그 달의 말일로 처리했습니다.'
      : '';
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
    deliveryError.textContent = '';
    periodError.textContent = '';
    captureNote.classList.remove('is-open');
    panel.classList.remove('is-open');
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
    if (e.key === 'Enter' && (e.target === deliveryDate || e.target === periodDays)) {
      e.preventDefault();
      calculate();
    }
  });

  /* ══════════════════════════════════════════════════════════
     결과 이미지 생성 (모바일 '캡쳐하기' — 외부 라이브러리 없음)
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
    g.font = 'bold 27px ' + SANS;
    g.fillText('이행지체 기준일 간이 계산기', P, 62);
    g.fillStyle = C.muted;
    g.font = '13px ' + SANS;
    g.fillText('결제기간 ' + state.days + '일', P, 88);

    /* 기간 비율 막대 */
    var by = 116, bh = 34;
    var aw = Math.round(cw * state.spanA / (state.spanA + state.spanB));
    g.fillStyle = C.ink;     g.fillRect(P, by, aw, bh);
    g.fillStyle = C.accent;  g.fillRect(P + aw, by, cw - aw, bh);
    g.fillStyle = '#FFFFFF'; g.fillRect(P + aw - 1, by, 2, bh);

    g.font = 'bold 12.5px ' + SANS;
    g.textAlign = 'center';
    g.fillStyle = '#FFFFFF';
    g.fillText('결제기간 ' + state.days + '일', P + aw / 2, by + 22);
    g.fillText('연장 결제 기간 ' + GRACE_MONTHS + '개월', P + aw + (cw - aw) / 2, by + 22);

    /* 세로로 쌓은 3개 마커 */
    var y = by + bh + 34;
    var rows = [
      { label: '물품인도일',     date: fmt(state.delivery), pill: '기산 ' + fmtShort(state.start),    final: false },
      { label: '결제기일',       date: fmt(state.due),      pill: 'D+' + state.spanA,                 final: false },
      { label: '이행지체 기준일', date: fmt(state.base),     pill: 'D+' + (state.spanA + state.spanB), final: true  }
    ];

    g.textAlign = 'left';
    rows.forEach(function (r, i) {
      g.fillStyle = r.final ? C.accent : C.muted;
      g.font = (r.final ? 'bold ' : '') + '13px ' + SANS;
      g.fillText(r.label, P, y);

      g.fillStyle = r.final ? C.accent : C.ink;
      g.font = 'bold ' + (r.final ? 30 : 26) + 'px ' + SANS;
      g.fillText(r.date, P, y + (r.final ? 38 : 34));

      var py = y + (r.final ? 56 : 52);
      g.font = 'bold 12px ' + SANS;
      var pw = g.measureText(r.pill).width + 22;
      roundRect(g, P, py, pw, 22, 11);
      g.fillStyle = r.final ? C.accentSoft : C.field;
      g.fill();
      g.strokeStyle = r.final ? C.accentLine : C.line;
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = r.final ? C.accent : C.muted;
      g.fillText(r.pill, P + 11, py + 15);

      y += r.final ? 96 : 100;

      if (i < rows.length - 1) {
        g.strokeStyle = C.line;
        g.lineWidth = 1;
        g.setLineDash([4, 4]);
        g.beginPath();
        g.moveTo(P, y - 30.5);
        g.lineTo(P + cw, y - 30.5);
        g.stroke();
        g.setLineDash([]);
      }
    });

    /* 기준일 안내 (도장 + 문장) */
    y += 4;
    var boxH = state.clamped ? 128 : 104;
    g.fillStyle = C.accentSoft;
    g.fillRect(P, y, cw, boxH);
    g.strokeStyle = C.accentLine;
    g.lineWidth = 1;
    g.strokeRect(P + .5, y + .5, cw - 1, boxH - 1);
    g.fillStyle = C.accent;
    g.fillRect(P, y, 3, boxH);

    var sx = P + 20, sy = y + 20, sw = 74, sh = 48;
    roundRect(g, sx, sy, sw, sh, 6);
    g.strokeStyle = C.accent;
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = C.accent;
    g.font = 'bold 12.5px ' + SANS;
    g.textAlign = 'center';
    g.fillText('이행지체', sx + sw / 2, sy + 21);
    g.fillText('기준일',   sx + sw / 2, sy + 38);

    g.textAlign = 'left';
    var tx = sx + sw + 18, tw = P + cw - tx - 18;
    g.fillStyle = C.accentText;
    g.font = 'bold 14px ' + SANS;
    var dw = g.measureText(fmt(state.base)).width;
    g.fillText(fmt(state.base), tx, y + 40);
    g.font = '14px ' + SANS;
    var ny = wrapText(g, ' 이후 발생하는 매출채권은, 미수채권이 남아 있는 경우 보험금이 지급되지 않습니다.',
                      tx + dw, y + 40, tw - dw, 22);
    if (state.clamped) {
      g.fillStyle = C.accent;
      g.font = 'bold 12.5px ' + SANS;
      wrapText(g, '2개월 뒤 같은 날짜가 없어 그 달의 말일로 처리했습니다.', tx, ny + 4, tw, 20);
    }

    y += boxH + 30;
    g.fillStyle = C.muted;
    g.font = '12px ' + SANS;
    wrapText(g, '결제기간은 물품인도일 다음 달 1일부터 계산하며, 이행지체 기준일은 결제기일의 2개월 뒤 같은 날짜입니다.',
             P, y, cw, 20);

    g.fillStyle = C.muted;
    g.font = '11.5px ' + SANS;
    g.fillText('참고용 간이 계산 결과이며, 실제 기준일은 보험증권 및 약관이 우선합니다.', P, H - 26);
  }

  function buildCanvas() {
    var W = 760, H = 760, S = 2;
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
    var name = '이행지체기준일_' + fmtFile(state.base) + '.png';

    var finish = function (blob) {
      if (!blob) { note('이미지를 만들지 못했습니다. 화면을 직접 캡쳐해 주세요.'); return; }

      // 모바일 공유 시트 (사진 저장 · 메신저 전송). HTTPS 환경에서만 동작합니다.
      if (navigator.canShare && navigator.share) {
        try {
          var file = new File([blob], name, { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file], title: '이행지체 기준일' })
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
