// Meet 面談記録: Google Meetの通話画面に記録パネルを表示する
// 会議コード（URLの xxx-yyyy-zzz）から予約管理DBの該当予約を特定し、
// 来訪・営業結果・クローザー引き継ぎを記録する。
(() => {
  'use strict';

  // 退出後に記録パネルを開くため、会議コードはsessionStorageに覚えておく
  // （退出すると /landing 等に遷移してURLから会議コードが取れなくなるため）
  const SS_KEY = 'mlog-meet-code';

  // 会議コード（例: /abc-defg-hij）を現在のURLから取得する
  // 通常の /会議コード と /meet/会議コード の両方に対応する。
  // 初期表示と退出判定で同じ式を使い、通話中の誤判定を防ぐ。
  const meetingPathRe = /^\/(?:meet\/)?([a-z0-9]{2,}(?:-[a-z0-9]{2,}){1,3})(?:\/|$)/i;
  const m = location.pathname.match(meetingPathRe);

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
  let form = { attended: null, sales: null, closerName: '', closerAt: '',
    lineReason: '', closerSchedule: '', talentJob: '', lineReasonNote: '', lineMessage: '', lostReason: '', lostReasonNote: '' };

  // LINE交換の理由・日程の決め方・見送り理由（予約管理 Worker の routes/admin.ts と値を合わせること）
  const LINE_REASONS = [['closer', '今回の案件（クローザーへ繋ぐ）'], ['talent', '人材'], ['consult', '後ほど相談したい'], ['other', 'その他']];
  const CLOSER_SCHEDULES = [['timerex', 'TimeRexを送る'], ['decided', '日程決定済み']];
  const LOST_REASONS = [['price', '価格'], ['timing', '時期・余裕がない'], ['consider', '検討・家族相談'], ['competitor', '他社・スクール比較'], ['distrust', '不信感'], ['mismatch', 'ニーズ不一致'], ['other', 'その他']];
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
    form.lineReason     = b.line_reason || '';
    form.closerSchedule = b.closer_schedule || '';
    form.talentJob      = b.talent_job || '';
    form.lineReasonNote = b.line_reason_note || '';
    form.lineMessage    = b.line_message || '';
    form.lostReason     = b.lost_reason || '';
    form.lostReasonNote = b.lost_reason_note || '';
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
          </div>
          ${(b.form_birthdate || b.form_age != null || b.form_gender) ? `<div class="mlog-meta">${[
            b.form_birthdate ? esc(b.form_birthdate) : null,
            b.form_age != null ? `${b.form_age}歳` : null,
            b.form_gender ? esc(b.form_gender) : null,
          ].filter(Boolean).join(' ／ ')}</div>` : ''}
          ${b.lancers_id ? `<div class="mlog-meta"><span class="mlog-copy" data-copy="${esc(b.lancers_id)}" title="クリックでコピー">ランサーズ: ${esc(b.lancers_id)}</span></div>` : b.cw_employee_id ? `<div class="mlog-meta"><span class="mlog-copy" data-copy="${esc(b.cw_employee_id)}" title="クリックでコピー">CW: ${esc(b.cw_employee_id)}</span></div>` : ''}
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

        ${form.attended === 1 && form.sales === 'lost' ? `
          <label class="mlog-label">見送り理由 <span class="mlog-opt-tag">任意</span></label>
          <select id="mlog-lost" class="mlog-select">
            <option value="">選択してください</option>
            ${LOST_REASONS.map(([k, l]) => `<option value="${k}"${form.lostReason === k ? ' selected' : ''}>${l}</option>`).join('')}
          </select>
          <input type="text" id="mlog-lost-note" class="mlog-input" style="margin-top:6px;" placeholder="補足（例: クローザーのSNSを聞かれて曖昧になった）" value="${esc(form.lostReasonNote)}">` : ''}

        ${form.attended === 1 && form.sales ? `
          <div class="mlog-sec">LINE交換・繋ぐまでの段取り</div>
          <label class="mlog-label">LINEを交換した理由</label>
          <div class="mlog-chips" data-group="lr">
            <button class="mlog-opt ${!form.lineReason ? 'on sel' : ''}" data-v="">交換していない</button>
            ${LINE_REASONS.filter(([k]) => k !== 'closer' || form.sales === 'won').map(([k, l]) =>
              `<button class="mlog-opt ${form.lineReason === k ? 'on sel' : ''}" data-v="${k}">${l}</button>`).join('')}
          </div>

          ${form.lineReason === 'closer' ? `
            <div class="mlog-box">
              <label class="mlog-label">クローザー</label>
              <input type="text" id="mlog-closer" class="mlog-input" placeholder="クローザーの名前" value="${esc(form.closerName)}">
              <label class="mlog-label">日程の決め方</label>
              <div class="mlog-chips" data-group="cs">
                ${CLOSER_SCHEDULES.map(([k, l]) => `<button class="mlog-opt ${form.closerSchedule === k ? 'on sel' : ''}" data-v="${k}">${l}</button>`).join('')}
              </div>
              ${form.closerSchedule ? `
                <label class="mlog-label">${form.closerSchedule === 'decided' ? '決まった日時 <span class="mlog-req">必須</span>' : '相手がTimeRexで入れた日時 <span class="mlog-opt-tag">入ったら記入</span>'}</label>
                <input type="datetime-local" id="mlog-closer-at" class="mlog-input" value="${esc(form.closerAt)}">` : ''}
            </div>` : ''}

          ${form.lineReason === 'talent' ? `
            <label class="mlog-label">どんな仕事を探しているか</label>
            <textarea id="mlog-talent" class="mlog-input mlog-ta" placeholder="例: 事務の在宅ワーク。平日夜と土日で週10時間">${esc(form.talentJob)}</textarea>` : ''}

          ${form.lineReason === 'other' ? `
            <label class="mlog-label">交換した理由（その他）</label>
            <input type="text" id="mlog-lr-note" class="mlog-input" placeholder="例: 知人を紹介してもらう" value="${esc(form.lineReasonNote)}">` : ''}

          ${form.lineReason ? `
            <label class="mlog-label">LINEで送ってほしいメッセージ <span class="mlog-opt-tag">任意</span></label>
            <textarea id="mlog-line-msg" class="mlog-input mlog-ta" placeholder="例: テストライティングの資料と、鈴鹿さんの紹介文を送ってください">${esc(form.lineMessage)}</textarea>` : ''}
        ` : ''}

        <button id="mlog-save" class="mlog-save" ${canSave() && !saving ? '' : 'disabled'}>${saving ? '保存中...' : recorded ? '更新する' : '保存する'}</button>
        <div id="mlog-msg" class="mlog-msg"></div>`;
    }

    // 退出後の記録画面は大きく表示する（記載忘れ防止のため見やすく）
    const big = autoOpen || leftCall;
    root.innerHTML = `
      <div id="mlog-panel"${big ? ' class="mlog-big"' : ''}>
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

    root.querySelectorAll('.mlog-btns, .mlog-chips').forEach(group => {
      group.querySelectorAll('.mlog-opt').forEach(btn => {
        btn.onclick = () => {
          const g = group.dataset.group;
          if (g === 'attended') {
            form.attended = Number(btn.dataset.v);
            if (form.attended === 0) form.sales = null;
          } else if (g === 'sales') {
            form.sales = btn.dataset.v;
            // 取れたら「今回の案件（クローザーへ繋ぐ）」を初期選択。取れなかったらその選択は外す
            if (form.sales === 'won' && !form.lineReason) form.lineReason = 'closer';
            if (form.sales !== 'won' && form.lineReason === 'closer') form.lineReason = '';
          } else if (g === 'lr') {
            form.lineReason = btn.dataset.v;
          } else if (g === 'cs') {
            form.closerSchedule = btn.dataset.v;
          }
          render();
        };
      });
    });

    root.querySelectorAll('.mlog-copy').forEach(el => {
      el.onclick = () => {
        const text = el.dataset.copy;
        const orig = el.textContent;
        const done = () => {
          el.textContent = '✓ コピーしました';
          setTimeout(() => { el.textContent = orig; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(() => {
            // CSP等でブロックされた場合はexecCommandにフォールバック
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            done();
          });
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          done();
        }
      };
    });

    const closer = root.querySelector('#mlog-closer');
    if (closer) closer.oninput = () => { form.closerName = closer.value; };
    const closerAt = root.querySelector('#mlog-closer-at');
    if (closerAt) closerAt.oninput = () => { form.closerAt = closerAt.value; refreshSaveBtn(); };
    const bindText = (sel, key) => { const el = root.querySelector(sel); if (el) el.oninput = () => { form[key] = el.value; }; };
    bindText('#mlog-talent', 'talentJob');
    bindText('#mlog-lr-note', 'lineReasonNote');
    bindText('#mlog-line-msg', 'lineMessage');
    bindText('#mlog-lost-note', 'lostReasonNote');
    const lost = root.querySelector('#mlog-lost');
    if (lost) lost.onchange = () => { form.lostReason = lost.value; };

    const save = root.querySelector('#mlog-save');
    if (save) save.onclick = doSave;
  }

  function canSave() {
    if (!booking) return false;
    if (form.attended !== 0 && form.attended !== 1) return false;
    if (form.attended === 1 && form.sales !== 'won' && form.sales !== 'lost') return false;
    // 「日程決定済み」なら決まった日時が要る
    if (form.attended === 1 && form.lineReason === 'closer' && form.closerSchedule === 'decided' && !form.closerAt) return false;
    return true;
  }
  // 日時の入力だけで保存ボタンの可否が変わるので、パネルを描き直さずにボタンだけ更新する
  function refreshSaveBtn() {
    const b = root.querySelector('#mlog-save');
    if (b) b.disabled = !canSave() || saving;
  }

  async function doSave() {
    if (!canSave() || saving) return;
    saving = true;
    render();
    const came = form.attended === 1;
    const lr = came ? (form.lineReason || null) : null;
    const isCloser = lr === 'closer' && form.sales === 'won';
    const record = {
      id: booking.id,
      attended: form.attended,
      sales_result: came ? form.sales : null,
      closer_name: isCloser ? (form.closerName.trim() || null) : null,
      closer_meeting_at: isCloser && form.closerSchedule && form.closerAt ? new Date(form.closerAt).toISOString() : null,
      line_reason: lr,
      closer_schedule: isCloser ? (form.closerSchedule || null) : null,
      talent_job: lr === 'talent' ? (form.talentJob.trim() || null) : null,
      line_reason_note: lr === 'other' ? (form.lineReasonNote.trim() || null) : null,
      line_message: lr ? (form.lineMessage.trim() || null) : null,
      lost_reason: came && form.sales === 'lost' ? (form.lostReason || null) : null,
      lost_reason_note: came && form.sales === 'lost' ? (form.lostReasonNote.trim() || null) : null,
    };
    const res = await send({ type: 'save', record });
    saving = false;
    if (res && res.ok) {
      booking.attended = form.attended;
      booking.sales_result = record.sales_result;
      booking.closer_name = record.closer_name;
      booking.closer_meeting_at = record.closer_meeting_at;
      ['line_reason', 'closer_schedule', 'talent_job', 'line_reason_note', 'line_message', 'lost_reason', 'lost_reason_note']
        .forEach(k => { booking[k] = record[k]; });
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
