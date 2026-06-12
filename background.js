// Meet 面談記録: 予約管理Worker（yoyaku）との通信を担当
// 管理者として https://yoyaku.triplek-rh.workers.dev にログイン済みのセッションCookieを使う
const BASE_URL = 'https://yoyaku.triplek-rh.workers.dev';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      let res;
      if (msg.type === 'lookup') {
        res = await fetch(`${BASE_URL}/ext/api/meet-booking?code=${encodeURIComponent(msg.code)}`, {
          credentials: 'include',
        });
      } else if (msg.type === 'save') {
        res = await fetch(`${BASE_URL}/ext/api/meet-record`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg.record),
        });
      } else {
        sendResponse({ ok: false, error: 'unknown message type' });
        return;
      }

      if (res.status === 401 || res.status === 403) {
        sendResponse({ ok: false, needLogin: true, loginUrl: `${BASE_URL}/admin` });
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        sendResponse({ ok: false, error: data.error || `HTTP ${res.status}` });
        return;
      }
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // 非同期でsendResponseを呼ぶ
});
