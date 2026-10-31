/* okie-sync: one set of settings on every screen, and export / import of them.
 *
 * Everything you set (favorites, rooms, design, glass, lock page, ...) is kept in Home Assistant's own storage for your user, so the browser, the phone app, the iPad and the
 * wall tablet show the same thing. Newest change wins; a screen pulls on start, when it comes back to the foreground and every five minutes. What belongs to one screen only
 * (its size) stays on that screen. "Export" saves all of it as a file, "Import" loads such a file (like a WordPress export), also into another Home Assistant.
 * Inside the Okie Home app the file goes through the iOS share sheet and file picker (window.webkit.messageHandlers.okieBackup).
 */
(function (g) {
  'use strict';
  var isNode = typeof module !== 'undefined' && module.exports;

  var KEY = 'okie_motor_settings';
  var DEVICE_ONLY = ['scale', 'rest', 'top_offset'];      // the size and the screensaver belong to one screen
  var PRIVATE = ['animaraKey'];      // never written into an exported file (a licence key is easy to share by accident); an import keeps the one you have
  var MAX_BYTES = 1024 * 1024;

  function clone(o) { return JSON.parse(JSON.stringify(o == null ? {} : o)); }
  function isPlain(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  /** The part of the user's settings that is shared between screens. */
  function shared(user) { var o = clone(user); DEVICE_ONLY.forEach(function (k) { delete o[k]; }); return o; }
  function deviceOnly(user) { var o = {}; DEVICE_ONLY.forEach(function (k) { if (user && user[k] !== undefined) o[k] = clone(user[k]); }); return o; }
  /** Every setting that has a value: the shared copy of another screen plus this screen's own. */
  function combine(remoteShared, localUser) { return Object.assign(clone(remoteShared), deviceOnly(localUser)); }
  /** How many single values a settings object holds (to tell a rich set from an empty one). */
  function size(o) {
    if (Array.isArray(o)) return o.length ? o.reduce(function (n, v) { return n + Math.max(1, size(v)); }, 0) : 0;
    if (isPlain(o)) return Object.keys(o).reduce(function (n, k) { return n + Math.max(1, size(o[k])); }, 0);
    return o === undefined || o === null ? 0 : 1;
  }
  /** Which copy a screen that was never synced should keep: the richer one; on a tie the one in Home Assistant. */
  function firstSyncWinner(localShared, remoteShared) { return size(localShared) > size(remoteShared) ? 'local' : 'remote'; }

  /** The file: everything, also the one-screen settings, with a stamp. */
  function buildExport(user, meta) {
    meta = meta || {};
    var settings = clone(user); PRIVATE.forEach(function (k) { delete settings[k]; });
    return { app: 'okie-motor', format: 1, version: String(meta.version || ''), exported: new Date(meta.now == null ? Date.now() : meta.now).toISOString(), settings: settings };
  }
  /** The settings an import puts in place: the file's, plus your own private ones (the file never carries them). Pure, tested. */
  function withPrivate(imported, localUser) { var o = clone(imported); PRIVATE.forEach(function (k) { if (o[k] === undefined && localUser && localUser[k] !== undefined) o[k] = clone(localUser[k]); }); return o; }
  /** Reads the text of an exported file: { ok, settings, exported, version, favorites, items } or { ok: false, error }. */
  function parseImport(text) {
    var s = String(text == null ? '' : text);
    if (s.length > MAX_BYTES) return { ok: false, error: 'toobig' };
    var o; try { o = JSON.parse(s); } catch (e) { return { ok: false, error: 'json' }; }
    if (!isPlain(o) || o.app !== 'okie-motor') return { ok: false, error: 'notours' };
    if (!isPlain(o.settings)) return { ok: false, error: 'nosettings' };
    var fav = Array.isArray(o.settings.favorites) ? o.settings.favorites.length : 0;
    return { ok: true, settings: o.settings, exported: o.exported || '', version: o.version || '', favorites: fav, items: size(o.settings) };
  }
  // One setup for every user: the admin who turns on "Everyone sees this setup" publishes it in Home Assistant's system data (only an admin can write it,
  // every user can read it); the screens of the other users follow it. Their own sync switch stays theirs.
  var SHARED_KEY = 'okie_motor_shared';
  /** What the publisher puts out: the shared settings without its own sync switches. Pure, tested. */
  function publishBlob(user) { var o = shared(user); delete o.sync; return o; }
  /** What a follower's screen ends up with: the published setup, plus this screen's size and its own sync switches. Pure, tested. */
  function followed(sharedData, localUser) {
    var o = combine(sharedData, localUser); delete o.sync;
    if (localUser && isPlain(localUser.sync)) { o.sync = clone(localUser.sync); delete o.sync.publish; }
    return o;
  }
  function stamp(d) { var p = function (n) { return (n < 10 ? '0' : '') + n; }; d = d || new Date(); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function fileName(d) { return 'okie-motor-settings-' + stamp(d) + '.json'; }

  var api = { SHARED_KEY: SHARED_KEY, publishBlob: publishBlob, followed: followed, KEY: KEY, DEVICE_ONLY: DEVICE_ONLY, shared: shared, deviceOnly: deviceOnly, combine: combine, size: size, firstSyncWinner: firstSyncWinner, buildExport: buildExport, withPrivate: withPrivate, PRIVATE: PRIVATE, parseImport: parseImport, fileName: fileName };
  if (isNode) { module.exports = api; return; }
  if (typeof document === 'undefined') return;

  var UI = g.OkieMotor.ui, h = UI.h;
  var live = null;                // the mounted instance: { ctx, pushNow, applyUser }

  function de(ctx) { try { return String(ctx.lang()).slice(0, 2) === 'de'; } catch (e) { return false; } }
  function say(ctx, en, deText) { return de(ctx) ? deText : en; }
  function userOf(ctx) { return ctx.store.get('settings', {}) || {}; }

  api.mount = function (ctx) {
    var applying = false, pushTimer = 0, pulled = false, off = null, timer = 0;
    status = { checked: 0, remoteT: 0, pushed: 0, error: '', follows: '', publishing: false, sharedError: '' };
    var noop = function () { return null; };
    function enabled() { var s = (ctx.settings.get().sync || {}); return s.enabled !== false; }
    function me() { var hs = ctx.hass ? ctx.hass() : null; return hs && hs.user ? hs.user : {}; }
    function publishing() { var s = (ctx.settings.get().sync || {}); return !!s.publish && !!me().is_admin; }
    /** The admin's screen: puts this setup where every user's screen can read it. */
    function publishNow() {
      if (!publishing()) return Promise.resolve(null);
      var u = me(), t = Date.now();
      return ctx.callWS({ type: 'frontend/set_system_data', key: SHARED_KEY, value: { t: t, by: u.id || '', byName: u.name || '', data: publishBlob(userOf(ctx)) } })
        .then(function () { status.publishing = true; status.sharedError = ''; return true; }, function (e) { status.publishing = false; status.sharedError = String((e && (e.code || e.message)) || 'failed'); return null; });
    }
    function unpublish() {
      return ctx.callWS({ type: 'frontend/get_system_data', key: SHARED_KEY }).then(function (r) {
        var v = r && r.value; if (!v || v.by !== me().id) return null;      // only the one who shares takes it back
        return ctx.callWS({ type: 'frontend/set_system_data', key: SHARED_KEY, value: null });
      }).then(function () { status.publishing = false; }, noop);
    }
    function pushNow() {
      if (!enabled()) return Promise.resolve(null);
      var t = Date.now(); ctx.store.set('settings.t', t); status.pushed = t;
      publishNow();
      return ctx.callWS({ type: 'frontend/set_user_data', key: KEY, value: { t: t, data: shared(userOf(ctx)) } }).catch(noop);
    }
    /** Another user's screen: takes the published setup when it is newer than the one it took last. true when something changed. */
    function takeShared(v, force) {
      status.follows = '';
      if (!v || typeof v !== 'object' || !isPlain(v.data) || !v.by || v.by === me().id) return false;      // nothing published, or published from this very user
      status.follows = v.byName || '?';
      if (!force && (+v.t || 0) <= (+ctx.store.get('shared.t', 0) || 0)) return false;
      applyUser(followed(v.data, userOf(ctx)));
      ctx.store.set('shared.t', +v.t || Date.now()); ctx.store.set('rooms.t', Date.now());      // an older rooms copy of this user must not win over it afterwards
      return true;
    }
    function pullShared(force) {
      return ctx.callWS({ type: 'frontend/get_system_data', key: SHARED_KEY }).then(function (r) { return takeShared(r && r.value, force); }, function () { status.follows = ''; return false; });      // an older Home Assistant has no system data: each user keeps their own
    }
    /** Replaces this screen's settings; the old ones are kept once in "settings.backup" so nothing is lost for good. */
    function applyUser(next, keepBackup) {
      if (keepBackup !== false) { try { ctx.store.set('settings.backup', { t: Date.now(), data: userOf(ctx) }); } catch (e) { /* storage full */ } }
      applying = true;
      try { ctx.settings.reset(); ctx.settings.set(next); } finally { applying = false; }
    }
    function pullNow(force) {
      if (!enabled() && !force) { pulled = true; return Promise.resolve(null); }
      return pullShared(force).then(function (took) {
        if (status.follows) { pulled = true; status.checked = Date.now(); status.error = ''; return took; }      // this user follows the published setup: their own copy is not used
        return pullUser(force);
      });
    }
    function pullUser(force) {
      return ctx.callWS({ type: 'frontend/get_user_data', key: KEY }).then(function (r) {
        var v = r && r.value, mine = shared(userOf(ctx)), t0 = +ctx.store.get('settings.t', 0) || 0;
        pulled = true; status.checked = Date.now(); status.remoteT = v && v.data ? +v.t || 0 : 0; status.error = '';
        if (force) { if (!v || typeof v !== 'object' || !v.data) return false; applyUser(combine(v.data, userOf(ctx))); ctx.store.set('settings.t', +v.t || Date.now()); return true; }      // Get settings from Home Assistant: the shared copy, whatever the times say
        if (!v || typeof v !== 'object' || !v.data) { return size(mine) > 0 ? pushNow() : null; }      // nothing stored yet: this screen's settings become the shared ones
        if (t0 === 0 && size(mine) > 0 && firstSyncWinner(mine, v.data) === 'local') return pushNow();   // never synced and richer than the shared copy: do not wipe it
        if ((+v.t || 0) <= t0) return null;
        applyUser(combine(v.data, userOf(ctx)));
        ctx.store.set('settings.t', +v.t);
        return true;
      }, function (e) { pulled = true; status.checked = Date.now(); status.error = String((e && (e.message || e.code)) || 'failed'); return force ? Promise.reject(e) : null; });
    }
    off = ctx.settings.on('change', function (p) {
      if (!applying && p && isPlain(p.sync) && p.sync.publish !== undefined) { if (p.sync.publish) publishNow(); else unpublish(); }      // Everyone sees this setup: on publishes at once, off takes it back
      if (applying || !pulled) return;                      // a first pull comes before any push, so a fresh screen never overwrites the shared copy
      clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 900);
    });
    function visible() { if (document.visibilityState === 'visible') pullNow(); }
    document.addEventListener('visibilitychange', visible);
    timer = setInterval(pullNow, 5 * 60000);
    pullNow();
    var unsub = null;      // a change the admin makes reaches the other users' screens at once, not only at the next pull
    try {
      var conn = ctx.hass && ctx.hass() && ctx.hass().connection;
      if (conn && conn.subscribeMessage) conn.subscribeMessage(function (ev) { if (enabled() && pulled) takeShared(ev && ev.value); }, { type: 'frontend/subscribe_system_data', key: SHARED_KEY }).then(function (u) { unsub = u; }, noop);
    } catch (e) { /* no live updates: the pulls still bring it */ }
    if (publishing()) status.publishing = true;
    live = { ctx: ctx, pushNow: pushNow, applyUser: applyUser, pullNow: pullNow, following: function () { return !!status.follows; } };
    return { dispose: function () { if (unsub) { try { unsub(); } catch (e) { /* gone */ } } if (off) off(); clearTimeout(pushTimer); clearInterval(timer); document.removeEventListener('visibilitychange', visible); if (live && live.ctx === ctx) live = null; } };
  };

  // ------------------------------------------------------------ status / get now ----
  var status = { checked: 0, remoteT: 0, pushed: 0, error: '' };
  function when(t, de0) {
    if (!t) return de0 ? 'nie' : 'never';
    var d = new Date(t), p = function (n) { return (n < 10 ? '0' : '') + n; }, today = new Date().toDateString() === d.toDateString();
    return (today ? '' : d.getDate() + '.' + (d.getMonth() + 1) + '. ') + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  /** Settings > About > Backup & sync: who this screen is signed in as and when it last talked to Home Assistant, so two screens can be compared. */
  api.following = function () { return !!(live && live.following && live.following()); };
  api.statusText = function (ctx) {
    ctx = ctx || (live && live.ctx); if (!ctx) return '–';
    var d = de(ctx), hs = ctx.hass ? ctx.hass() : null, user = hs && hs.user ? (hs.user.name || hs.user.id || '?') : '?';
    var mine = +ctx.store.get('settings.t', 0) || 0;
    if (status.follows) return say(ctx, 'User ' + user + ' · shows the setup of ' + status.follows + ' (Everyone sees this setup) · checked ' + when(status.checked, d), 'Benutzer ' + user + ' · zeigt die Einrichtung von ' + status.follows + ' (Alle sehen diese Einrichtung) · geprüft ' + when(status.checked, d));
    if (status.sharedError) return say(ctx, 'User ' + user + ' · could not share the setup with everyone (' + status.sharedError + '; needs an admin and a recent Home Assistant)', 'Benutzer ' + user + ' · Einrichtung konnte nicht geteilt werden (' + status.sharedError + '; braucht einen Admin und ein aktuelles Home Assistant)');
    if (status.error) return say(ctx, 'User ' + user + ' · could not reach Home Assistant (' + status.error + ')', 'Benutzer ' + user + ' · Home Assistant nicht erreicht (' + status.error + ')');
    return d ? 'Benutzer ' + user + ' · geteilte Kopie ' + when(status.remoteT, d) + ' · dieser Bildschirm ' + when(mine, d) + ' · geprüft ' + when(status.checked, d)
             : 'User ' + user + ' · shared copy ' + when(status.remoteT, d) + ' · this screen ' + when(mine, d) + ' · checked ' + when(status.checked, d) + (status.publishing ? ' · every user sees this setup' : '');
  };
  /** Get settings from Home Assistant: replaces this screen's settings and rooms with the shared copy now (a backup of the old ones is kept). */
  api.pullNow = function (ctx) {
    ctx = ctx || (live && live.ctx); if (!ctx || !live) return Promise.resolve(false);
    var RM = g.OkieMotor.rooms;
    return live.pullNow(true).then(function (got) {
      return (RM && RM.sync && RM.sync.pull ? RM.sync.pull(ctx, true) : Promise.resolve(null)).then(function (gotRooms) {
        var ok = got || gotRooms;
        ctx.toast(ok ? 'success' : 'info', ok ? say(ctx, 'Settings taken from Home Assistant', 'Einstellungen aus Home Assistant übernommen') : say(ctx, 'Home Assistant has no shared settings for this user yet', 'Home Assistant hat für diesen Benutzer noch keine geteilten Einstellungen'));
        return !!ok;
      });
    }, function () { ctx.toast('error', say(ctx, 'Could not reach Home Assistant', 'Home Assistant nicht erreicht')); return false; });
  };

  // ------------------------------------------------------------ export / import ----
  function bridge() { try { return g.webkit && g.webkit.messageHandlers && g.webkit.messageHandlers.okieBackup; } catch (e) { return null; } }

  api.exportNow = function (ctx) {
    ctx = ctx || (live && live.ctx); if (!ctx) return;
    var text = JSON.stringify(buildExport(userOf(ctx), { version: g.OkieMotor.version }), null, 2), name = fileName();
    var native = bridge();
    if (native) { native.postMessage({ action: 'export', name: name, json: text }); return; }
    try {
      var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      var a = h('a', { href: url, download: name, style: { display: 'none' } });
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
      ctx.toast('success', say(ctx, 'Settings exported: ' + name, 'Einstellungen exportiert: ' + name));
    } catch (e) {
      ctx.sheet({ title: say(ctx, 'Export settings', 'Einstellungen exportieren'), content: function (close) {
        var ta = h('textarea', { readonly: true, rows: 10, style: { width: '100%', font: '12px monospace' } }, text);
        return h('div', null, h('p', null, say(ctx, 'Copy this text into a file named ' + name + '.', 'Kopiere diesen Text in eine Datei namens ' + name + '.')), ta, h('div.actrow', null, h('button.act', { onclick: close }, ctx.t ? ctx.t('card.close') : 'OK')));
      } });
    }
  };

  api.importFlow = function (ctx) {
    ctx = ctx || (live && live.ctx); if (!ctx) return;
    var native = bridge();
    if (native) { native.postMessage({ action: 'import' }); return; }       // the app answers with importText()
    var inp = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      var fr = new FileReader(); fr.onload = function () { api.importText(String(fr.result), ctx); inp.remove(); }; fr.readAsText(f);
    });
    document.body.appendChild(inp); inp.click();
  };

  /** Called with the text of a file (by the file picker above or by the app). Asks once, then replaces the settings of this screen and shares them. */
  api.importText = function (text, ctx) {
    ctx = ctx || (live && live.ctx); if (!ctx) return;
    var r = parseImport(text);
    if (!r.ok) {
      var why = { json: ['That is not a settings file.', 'Das ist keine Einstellungsdatei.'], notours: ['That file is not from the Okie Motor.', 'Diese Datei stammt nicht vom Okie Motor.'], nosettings: ['The file has no settings in it.', 'Die Datei enthält keine Einstellungen.'], toobig: ['The file is too big.', 'Die Datei ist zu groß.'] }[r.error] || ['Could not read the file.', 'Datei nicht lesbar.'];
      ctx.toast('error', say(ctx, why[0], why[1])); return;
    }
    var when = r.exported ? r.exported.slice(0, 10) : '';
    ctx.sheet({ title: say(ctx, 'Import settings', 'Einstellungen importieren'), content: function (close) {
      return h('div', null,
        h('p', null, say(ctx, 'Replace the settings of this card with the file' + (when ? ' from ' + when : '') + '? It holds ' + r.favorites + ' favorites and ' + r.items + ' settings in all. Your current settings are kept once as a backup.',
          'Die Einstellungen dieser Karte durch die Datei' + (when ? ' vom ' + when : '') + ' ersetzen? Sie enthält ' + r.favorites + ' Favoriten und insgesamt ' + r.items + ' Einstellungen. Deine jetzigen Einstellungen bleiben einmal als Sicherung erhalten.')),
        h('div.actrow', null,
          h('button.act', { onclick: close }, ctx.t ? ctx.t('card.close') : 'Cancel'),
          h('button.act.danger', { onclick: function () {
            var next = withPrivate(r.settings, userOf(ctx));
            if (live) { live.applyUser(next); live.pushNow(); } else { ctx.settings.reset(); ctx.settings.set(next); }
            ctx.toast('success', say(ctx, 'Settings imported', 'Einstellungen importiert')); close();
          } }, say(ctx, 'Import', 'Importieren'))));
    } });
  };

  g.OkieMotor.defaults = Object.assign(g.OkieMotor.defaults || {}, { sync: { enabled: true, publish: false } });
  g.OkieMotor.sync = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
