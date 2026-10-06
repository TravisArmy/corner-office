/* Corner Office accounts, saved progress and leaderboard.
   The game keeps its state in the browser; this file copies it to and from the player's account.
   With no values in config.js the site runs in local demo mode and this file does nothing. */
(function () {
  var cfg = window.CORNER_CONFIG || {}, ready = !!(cfg.supabaseUrl && cfg.supabaseKey && window.supabase);
  var KEYS = ['cornerOfficeCharacter', 'cornerOfficeDaily.v1', 'cornerOfficeMetNepo', 'cornerOfficeSeenBlocks', 'cornerOfficeLastScene', 'cornerOfficeScreen'];
  var PROTECTED = /(office|career|character|leaderboard)\.html$/;
  var sb = ready ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey) : null, uid = null, timer = null, rawSet = Storage.prototype.setItem, rawDel = Storage.prototype.removeItem;
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function msg(e) { return (e && (e.message || e.error_description)) || 'Something went wrong. Please try again.'; }

  function stats() {
    var S = null; try { S = JSON.parse(get('cornerOfficeDaily.v1') || 'null'); } catch (e) {}
    var D = (S && S.days) || [], cp = 1, cb = 1, won = false, done = 0, k;
    D.forEach(function (r) { cp *= 1 + r.p; cb *= 1 + r.b; });
    for (k = 0; k * 3 + 3 <= D.length && !won; k++) { var p = 1, b = 1; D.slice(k * 3, k * 3 + 3).forEach(function (r) { p *= 1 + r.p; b *= 1 + r.b; }); won = p > b; done++; }
    var seen = +(get('cornerOfficeSeenBlocks') || 0);
    return { days_traded: D.length, benchmark: 'S&P 500', career_return: cp - 1, bench_return: cb - 1, active_return: cp - cb, floor: won && seen >= done ? 5 : 1 };
  }
  function push() {
    if (!ready || !uid) return Promise.resolve();
    var data = {}; KEYS.forEach(function (k) { var v = get(k); if (v !== null) data[k] = v; });
    var now = new Date().toISOString(), st = stats(); st.updated_at = now;
    return Promise.all([
      sb.from('saves').upsert({ id: uid, data: data, updated_at: now }),
      sb.from('profiles').update(st).eq('id', uid)
    ]).catch(function () {});
  }
  function schedule() { if (!ready || !uid) return; clearTimeout(timer); timer = setTimeout(push, 1200); }
  function clearLocal() { KEYS.concat(['cornerOfficeUser']).forEach(function (k) { try { rawDel.call(localStorage, k); } catch (e) {} }); }
  function pull() {
    return sb.from('saves').select('data').eq('id', uid).maybeSingle().then(function (r) {
      var d = (r.data && r.data.data) || {};
      KEYS.forEach(function (k) { try { if (d[k] !== undefined) rawSet.call(localStorage, k, d[k]); } catch (e) {} });
    });
  }
  function ensureProfile(user) {
    return sb.from('profiles').select('username').eq('id', user.id).maybeSingle().then(function (r) {
      if (r.data) return r.data.username;
      var name = (user.user_metadata && user.user_metadata.username) || ('Investor' + String(user.id).slice(0, 5));
      return sb.from('profiles').insert({ id: user.id, username: name }).then(function (i) {
        if (i.error) throw i.error;
        return sb.from('saves').upsert({ id: user.id, data: {} }).then(function () { return name; });
      });
    });
  }
  function enter(user) {
    uid = user.id;
    return ensureProfile(user).then(function (name) { try { rawSet.call(localStorage, 'cornerOfficeUser', name); } catch (e) {} return name; });
  }

  var Cloud = window.Cloud = {
    ready: ready,
    signUp: function (name, email, pw) {
      var pat = name.replace(/([\\%_])/g, '\\$1');
      return sb.from('profiles').select('id').ilike('username', pat).limit(1).then(function (r) {
        if (r.error) return { error: 'Could not reach the game server. Check that the setup text was run in Supabase.' };
        if (r.data && r.data.length) return { error: 'That investor name is taken. Try another.' };
        return sb.auth.signUp({ email: email, password: pw, options: { data: { username: name } } }).then(function (s) {
          if (s.error) return { error: msg(s.error) };
          if (!s.data.session) return { confirm: true };
          clearLocal();
          return enter(s.data.user).then(function () { return {}; }, function (e) { return { error: /duplicate|unique/i.test(msg(e)) ? 'That investor name is taken. Try another.' : msg(e) }; });
        });
      }).catch(function (e) { return { error: msg(e) }; });
    },
    signIn: function (email, pw) {
      return sb.auth.signInWithPassword({ email: email, password: pw }).then(function (s) {
        if (s.error) return { error: /confirm/i.test(msg(s.error)) ? 'Confirm your email first: open the link we sent you, then log in.' : 'That email and password do not match an account.' };
        clearLocal();
        return enter(s.data.user).then(pull).then(function () { return { hasCharacter: !!get('cornerOfficeCharacter') }; });
      }).catch(function (e) { return { error: msg(e) }; });
    },
    reset: function (email) { return sb.auth.resetPasswordForEmail(email).then(function (r) { return r.error ? { error: msg(r.error) } : {}; }); },
    signOut: function () { return push().then(function () { return sb.auth.signOut(); }).then(clearLocal, clearLocal); },
    leaderboard: function () {
      return sb.from('profiles').select('id,username,days_traded,benchmark,career_return,bench_return,active_return,floor').order('active_return', { ascending: false }).limit(100)
        .then(function (r) { return { rows: r.data || [], me: uid, error: r.error ? msg(r.error) : null }; });
    },
    push: push
  };
  if (!ready) return;

  // keep the account copy up to date whenever the game saves something
  Storage.prototype.setItem = function (k, v) { rawSet.call(this, k, v); if (KEYS.indexOf(k) >= 0) schedule(); };
  Storage.prototype.removeItem = function (k) { rawDel.call(this, k); if (KEYS.indexOf(k) >= 0) schedule(); };
  window.addEventListener('pagehide', function () { if (timer) { clearTimeout(timer); push(); } });

  var guarded = PROTECTED.test(location.pathname);
  if (guarded) document.documentElement.style.visibility = 'hidden';
  sb.auth.getSession().then(function (r) {
    var s = r.data && r.data.session;
    if (s) { uid = s.user.id; document.documentElement.style.visibility = ''; }
    else if (guarded) location.replace('login.html');
  });
  document.addEventListener('click', function (ev) {
    var a = ev.target.closest && ev.target.closest('a.out');
    if (!a) return; ev.preventDefault(); Cloud.signOut().then(function () { location.href = 'index.html'; });
  });
})();
