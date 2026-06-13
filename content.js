// Meet 面談記録: Google Meetの通話画面に記録パネルを表示する
// 会議コード（URLの xxx-yyyy-zzz）から予約管理DBの該当予約を特定し、
// 来訪・営業結果・クローザー引き継ぎを記録する。
(() => {
  'use strict';

  // 退出後に記録パネルを開くため、会議コードはsessionStorageに覚えておく
  // （退出すると /landing 等に遷移してURLから会議コードが取れなくなるため）
  const SS_KEY = 'mlog-meet-code';

  // 会議コード（例: /abc-defg-hij）を現在のURLから取得する
  const m = location.pathname.match(/^\/([a-z0-9]{2,}(?:-[a-z0-9]{2,}){1,3})(?:\/|$)/i);

  // 通話画面なら会議コードを覚えておく。
  // 退出後の画面（会議コードがURLにない）では、覚えておいたコードを使い、
  // 記録パネルを自動で開く（= 記載忘れ防止）。
  let autoOpen = false;
  let MEET_CODE;
  if (m) {
    MEET_CODE = m[1].toLowerCase();
    try { sessionStorage.setItem(SS_KEY, MEET_CODE); } catch (_) {}
  } else {
    let saved = null;
    try { saved = sessionStorage.getItem(SS_KEY); } catch (_) {}
    if (!saved) return; // 通話に入っていないMeetページ（トップ等）では何もしない
    MEET_CODE = saved;
    autoOpen = true; // 退出直後なので記録画面をすぐ出す
    try { sessionStorage.removeItem(SS_KEY); } catch (_) {}
  }

  // ---- 状態 ----
  let lookup = null;      // { booking, candidates, owner_names }
  let booking = null;     // 表示・記録対象の予約
  let form = { attended: null, sales: null, closerName: '', closerAt: '' };
  let expanded = autoOpen; // 退出直後は記録画面を開いた状態で表示する
  let saving = false;

  // ---- DOM ----
  const root = document.createElement('div');
  root.id = 'mlog-root';
  document.documentElement.appendChild(root);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' });
  }

  function send(msg) {
    return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
  }

  // 予約データからフォーム初期値を読み込む（記録済みなら編集として開く）
  function loadForm(b) {
    form.attended  = b.attended == null ? null : b.attended;
    form.sales     = b.sales_result || null;
    form.closerName = b.closer_name || '';
    form.closerAt  = b.closer_meeting_at
      ? new Date(new Date(b.closer_meeting_at).getTime() + 9 * 3600_000).toISOString().slice(0, 16)
      : '';
  }

  async function init() {
    const res = await send({ type: 'lookup', code: MEET_CODE });
    if (!res || !res.ok) {
      lookup = { error: res?.error, needLogin: res?.needLogin, loginUrl: res?.loginUrl };
    } else {
      lookup = res.data;
      booking = lookup.booking;
      if (booking) loadForm(booking);
    }
    render();
  }

  function ownerName(n) {
    return (lookup && lookup.owner_names && lookup.owner_names[n]) || ('担当' + n);
  }

  // ---- 描画 ----
  function render() {
    const recorded = booking && booking.attended != null;
    const needAction = booking && !recorded;

    if (!expanded) {
      root.innerHTML = `
        <button id="mlog-pill" title="面談記録を開く">
          📋 面談記録${needAction ? '<span class="mlog-dot"></span>' : recorded ? ' ✓' : ''}
        </button>`;
      root.querySelector('#mlog-pill').onclick = () => { expanded = true; render(); };
      return;
    }

    let body = '';
    if (!lookup) {
      body = `<div class="mlog-empty">読み込み中...</div>`;
    } else if (lookup.needLogin) {
      body = `
        <div class="mlog-empty">
          予約管理にログインが必要です。<br>
          <a href="${esc(lookup.loginUrl || 'https://yoyaku.triplek-rh.workers.dev/admin')}" target="_blank">管理画面を開いてログイン</a>した後、
          <button class="mlog-link" id="mlog-reload">再読み込み</button>してください。
        </div>`;
    } else if (lookup.error) {
      body = `<div class="mlog-empty">取得エラー: ${esc(lookup.error)}<br><button class="mlog-link" id="mlog-reload">再読み込み</button></div>`;
    } else if (!booking) {
      const cands = lookup.candidates || [];
      body = `
        <div class="mlog-empty">この会議コードに対応する予約が見つかりません。</div>
        ${cands.length ? `
          <label class="mlog-label">前後3時間の予約から選択</label>
          <select id="mlog-cand" class="mlog-select">
            <option value="">選択してください</option>
            ${cands.map(c => `<option value="${c.id}">${fmtDate(c.slot_start)} ${fmtTime(c.slot_start)} ${esc(c.form_name || c.google_name || c.google_email)}（${esc(ownerName(c.owner))}）</option>`).join('')}
          </select>` : ''}`;
    } else {
      const b = booking;
      body = `
        <div class="mlog-info">
          <div class="mlog-name">${esc(b.form_name || b.google_name || b.google_email)}</div>
          <div class="mlog-meta">
            ${fmtDate(b.slot_start)} ${fmtTime(b.slot_start)}〜${fmtTime(b.slot_end)} ／ 担当: ${esc(ownerName(b.owner))}
            ${b.form_age != null ? `／ ${b.form_age}歳` : ''}${b.form_gender ? ` ${esc(b.form_gender)}` : ''}
          </div>
          ${b.lancers_id ? `<div class="mlog-meta">ランサーズ: ${esc(b.lancers_id)}</div>` : ''}
          ${b.notes_doc_url ? `<div class="mlog-meta"><a href="${esc(b.notes_doc_url)}" target="_blank">📝 Gemini議事録を開く</a></div>` : ''}
          ${recorded ? `<div class="mlog-saved-tag">記録済み（変更して再保存できます）</div>` : ''}
        </div>

        <label class="mlog-label">相手は来ましたか？ <span class="mlog-req">必須</span></label>
        <div class="mlog-btns" data-group="attended">
          <button class="mlog-opt ${form.attended === 1 ? 'on good' : ''}" data-v="1">来た</button>
          <button class="mlog-opt ${form.attended === 0 ? 'on bad' : ''}" data-v="0">来なかった</button>
        </div>

        ${form.attended === 1 ? `
          <label class="mlog-label">営業は取れましたか？ <span class="mlog-req">必須</span></label>
          <div class="mlog-btns" data-group="sales">
            <button class="mlog-opt ${form.sales === 'won' ? 'on good' : ''}" data-v="won">取れた</button>
            <button class="mlog-opt ${form.sales === 'lost' ? 'on bad' : ''}" data-v="lost">取れなかった</button>
          </div>` : ''}

        ${form.attended === 1 && form.sales === 'won' ? `
          <label class="mlog-label">クローザーへの引き継ぎ <span class="mlog-opt-tag">任意</span></label>
          <input type="text" id="mlog-closer" class="mlog-input" placeholder="クローザーの名前" value="${esc(form.closerName)}">
          <label class="mlog-label" style="margin-top:6px;">クローザーと話す日時</label>
          <input type="datetime-local" id="mlog-closer-at" class="mlog-input" value="${esc(form.closerAt)}">` : ''}

        <button id="mlog-save" class="mlog-save" ${canSave() && !saving ? '' : 'disabled'}>${saving ? '保存中...' : recorded ? '更新する' : '保存する'}</button>
        <div id="mlog-msg" class="mlog-msg"></div>`;
    }

    root.innerHTML = `
      <div id="mlog-panel">
        <div class="mlog-head">
          <span>📋 面談記録</span>
          <button id="mlog-min" title="折りたたむ">−</button>
        </div>
        <div class="mlog-body">${body}</div>
      </div>`;

    // ---- イベント ----
    root.querySelector('#mlog-min').onclick = () => { expanded = false; render(); };
    const reload = root.querySelector('#mlog-reload');
    if (reload) reload.onclick = () => { lookup = null; render(); init(); };

    const cand = root.querySelector('#mlog-cand');
    if (cand) cand.onchange = () => {
      const c = (lookup.candidates || []).find(x => String(x.id) === cand.value);
      if (c) { booking = c; loadForm(c); render(); }
    };

    root.querySelectorAll('.mlog-btns').forEach(group => {
      group.querySelectorAll('.mlog-opt').forEach(btn => {
        btn.onclick = () => {
          if (group.dataset.group === 'attended') {
            form.attended = Number(btn.dataset.v);
            if (form.attended === 0) form.sales = null;
          } else {
            form.sales = btn.dataset.v;
          }
          render();
        };
      });
    });

    const closer = root.querySelector('#mlog-closer');
    if (closer) closer.oninput = () => { form.closerName = closer.value; };
    const closerAt = root.querySelector('#mlog-closer-at');
    if (closerAt) closerAt.oninput = () => { form.closerAt = closerAt.value; };

    const save = root.querySelector('#mlog-save');
    if (save) save.onclick = doSave;
  }

  function canSave() {
    if (!booking) return false;
    if (form.attended !== 0 && form.attended !== 1) return false;
    if (form.attended === 1 && form.sales !== 'won' && form.sales !== 'lost') return false;
    return true;
  }

  async function doSave() {
    if (!canSave() || saving) return;
    saving = true;
    render();
    const record = {
      id: booking.id,
      attended: form.attended,
      sales_result: form.attended === 1 ? form.sales : null,
      closer_name: form.sales === 'won' ? (form.closerName.trim() || null) : null,
      closer_meeting_at: form.sales === 'won' && form.closerAt ? new Date(form.closerAt).toISOString() : null,
    };
    const res = await send({ type: 'save', record });
    saving = false;
    if (res && res.ok) {
      booking.attended = form.attended;
      booking.sales_result = record.sales_result;
      booking.closer_name = record.closer_name;
      booking.closer_meeting_at = record.closer_meeting_at;
      render();
      const msg = root.querySelector('#mlog-msg');
      if (msg) { msg.textContent = '✓ ダッシュボードに記録しました'; msg.className = 'mlog-msg ok'; }
    } else {
      render();
      const msg = root.querySelector('#mlog-msg');
      if (msg) {
        msg.textContent = res?.needLogin ? '管理画面へのログインが必要です' : ('保存失敗: ' + (res?.error || '不明なエラー'));
        msg.className = 'mlog-msg ng';
      }
    }
  }

  // ---- 退出検知 ----
  // MeetはSPAなので退出の仕方が一定しない（URLが変わる場合・変わらず
  // 「通話から退出しました」画面になる場合の両方がある）。記載忘れ防止のため、
  // 以下3つのいずれかで退出を検知したら記録パネルを自動で開く。
  //   (1) URLから会議コードが消えた（ポーリング: contentスクリプトのworld分離に強い）
  //   (2) 退出後画面に特有のボタン/テキスト（「再参加」等）が出た（DOM監視）
  //   (3) 退出ボタンをクリックした（保険）
  let leftCall = false;
  function fireLeftCall() {
    if (leftCall) return;
    leftCall = true;
    try { sessionStorage.removeItem(SS_KEY); } catch (_) {}
    expanded = true;
    render();
    if (!lookup) init();
  }

  // (1) URLポーリング
  const meetingPathRe = /^\/[a-z0-9]{2,}(?:-[a-z0-9]{2,}){1,3}(?:\/|$)/i;
  setInterval(() => {
    if (!leftCall && !meetingPathRe.test(location.pathname)) fireLeftCall();
  }, 1000);

  // (2)(3) 退出ボタン / 退出後画面の検知
  // aria-labelやテキストは言語設定で変わるので日英の両方を見る。
  const LEAVE_LABEL_RE  = /退出|leave call|通話から退出/i;
  const RETURNED_TEXT_RE = /退出しました|再参加|もう一度参加|return to home|rejoin|you left the (?:meeting|call)/i;

  // 退出後画面が出たか（再参加ボタン等のテキスト）をページ全体から探す
  function postCallScreenShown() {
    // パネル自身のテキストは除外したいので body のテキストのみ見る（簡易）
    const t = document.body ? document.body.innerText : '';
    return RETURNED_TEXT_RE.test(t);
  }

  const mo = new MutationObserver(() => {
    if (leftCall) { mo.disconnect(); return; }
    if (postCallScreenShown()) fireLeftCall();
  });
  if (document.body) mo.observe(document.body, { childList: true, subtree: true });

  // 退出ボタンのクリックを capture フェーズで捕捉（保険）。
  // ボタンはレンダーされ直すのでdocument委譲で拾う。
  document.addEventListener('click', (e) => {
    if (leftCall) return;
    const el = e.target && e.target.closest
      ? e.target.closest('button,[role="button"],[aria-label]')
      : null;
    if (!el) return;
    const label = (el.getAttribute('aria-label') || el.textContent || '');
    if (LEAVE_LABEL_RE.test(label)) {
      // クリック直後はまだ通話画面。少し待って退出後画面に切り替わるのを確認してから開く
      setTimeout(() => { if (!meetingPathRe.test(location.pathname) || postCallScreenShown()) fireLeftCall(); }, 1200);
    }
  }, true);

  render();
  init();
})();
