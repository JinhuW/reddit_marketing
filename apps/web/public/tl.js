/* Threadline site snippet (<2 KB). <script src="https://app.example.com/tl.js" data-ws="acme" defer></script>
   Reads the first-party tl_vid cookie set by tracked links, sends a pageview, exposes tl.track(). */
((w, d) => {
  var s = d.currentScript,
    ws = s && s.getAttribute('data-ws'),
    host = s ? new URL(s.src).origin : '';
  var m = d.cookie.match(/(?:^|;\s*)tl_vid=([^;]+)/),
    vid = m && m[1];
  if (!vid) {
    try {
      vid = new URLSearchParams(location.search).get('tl_vid');
    } catch (e) {}
  }
  if (vid) d.cookie = 'tl_vid=' + vid + ';path=/;max-age=31536000;samesite=lax';
  function send(kind, data) {
    if (!ws || !vid) return;
    var body = JSON.stringify({
      ws: ws,
      vid: vid,
      kind: kind,
      email: data && data.email,
      url: location.href,
      ref: d.referrer || undefined,
    });
    fetch(host + '/api/tl/collect?ws=' + encodeURIComponent(ws), {
      method: 'POST',
      body: body,
      keepalive: true,
      mode: 'cors',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
  }
  w.tl = {
    track: (kind, data) => {
      if (kind === 'signup' || kind === 'trial') send(kind, data);
    },
    vid: () => vid,
  };
  send('pageview');
})(window, document);
