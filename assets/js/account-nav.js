/* Shared account UI: a dynamic Вход/Профил link in the header, plus toast +
   login-prompt helpers reused by address pages. Loaded on every public page. */
(function () {
    var USER_ICON =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    var SHIELD_ICON =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

    function roleLabel(r) {
        return r === 'owner' ? 'Собственик'
             : r === 'admin' ? 'Админ'
             : r === 'moderator' ? 'Модератор'
             : '';
    }

    function injectAccountLink() {
        var nav = document.querySelector('header.site-header .nav');
        if (!nav || nav.querySelector('.nav-account')) return;

        var a = document.createElement('a');
        a.className = 'nav-account';
        a.href = 'login.html';
        a.innerHTML = USER_ICON + '<span>Вход</span>';
        nav.appendChild(a);

        fetch('/api/auth/me', { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (me) {
                if (!me) return;
                document.body.classList.add('is-auth');
                a.href = 'profile.html';
                var role = roleLabel(me.role);
                a.innerHTML = USER_ICON + '<span>Профил</span>' +
                    (role ? '<span class="nav-account-role">' + role + '</span>' : '');
                a.classList.add('is-auth');

                // Moderators & owners get a quick link to the moderation dashboard.
                if (me.role === 'owner' || me.role === 'moderator') {
                    if (!nav.querySelector('.nav-mod')) {
                        var mod = document.createElement('a');
                        mod.className = 'nav-mod';
                        mod.href = '/admin/moderation.html';
                        mod.innerHTML = SHIELD_ICON + '<span>Модерация</span>';
                        nav.insertBefore(mod, a);  // place just before the account pill
                    }
                }
            })
            .catch(function () {});
    }

    /* ── Global toast ────────────────────────────────────────────── */
    var toastTimer;
    window.haToast = function (msg, opts) {
        opts = opts || {};
        var t = document.getElementById('ha-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'ha-toast';
            t.className = 'ha-toast';
            document.body.appendChild(t);
        }
        t.innerHTML = '';
        var span = document.createElement('span');
        span.textContent = msg;
        t.appendChild(span);
        if (opts.action && opts.action.href) {
            var link = document.createElement('a');
            link.className = 'ha-toast-action';
            link.href = opts.action.href;
            link.textContent = opts.action.label || 'OK';
            t.appendChild(link);
        }
        t.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.classList.remove('show'); }, opts.duration || 3500);
    };

    /* Friendly prompt shown when a guest tries to save a place. */
    window.haPromptLogin = function (msg) {
        window.haToast(msg || 'Влезте, за да запазвате места', {
            action: { label: 'Вход', href: 'login.html' },
            duration: 5000
        });
    };

    if (document.readyState !== 'loading') injectAccountLink();
    else document.addEventListener('DOMContentLoaded', injectAccountLink);
})();

/* ── Donations: open Buy Me a Coffee in a focused, centered window ────────────
   Any donate trigger (footer button, profile card CTA, the about-page contact
   card) opens the BMC donation page in a centered popup window — instantly, with
   no third-party script on the page. On phones the OS opens it as a new tab.
   If the browser blocks the popup, we fall back to a normal new tab so donations
   never break. */
(function initDonate() {
    var BMC_URL  = 'https://buymeacoffee.com/historyaddress.bg';
    var SELECTOR = '.footer-donate, .pf-donate-cta, .js-donate';

    function donateTarget(el) {
        return el && el.closest ? el.closest(SELECTOR) : null;
    }

    function openDonate() {
        var w = 480, h = 760;
        var sw = window.innerWidth  || document.documentElement.clientWidth  || screen.width;
        var sh = window.innerHeight || document.documentElement.clientHeight || screen.height;
        var dx = window.screenX != null ? window.screenX : (window.screenLeft || 0);
        var dy = window.screenY != null ? window.screenY : (window.screenTop  || 0);
        var left = Math.max(0, dx + (sw - w) / 2);
        var top  = Math.max(0, dy + (sh - h) / 2);
        var feats = 'popup=yes,noopener,scrollbars=yes,resizable=yes,width=' + w +
                    ',height=' + h + ',left=' + Math.round(left) + ',top=' + Math.round(top);
        var win = window.open(BMC_URL, 'bmc-donate', feats);
        if (!win) window.open(BMC_URL, '_blank', 'noopener');   // popup blocked → new tab
    }

    document.addEventListener('click', function (e) {
        if (!donateTarget(e.target)) return;
        e.preventDefault();
        openDonate();
    });
})();

/* ── Minimal GDPR cookie notice ──────────────────────────────────────────────
   We use only essential cookies (login session + theme preference) and no
   third-party tracking, so this is a one-time informational notice. Acceptance
   is remembered in localStorage. The bar sits below the calendar popup so it
   never interferes with it on mobile (see .ha-cookie in styles.css). */
(function cookieNotice() {
    try { if (localStorage.getItem('cookie-consent') === '1') return; } catch (e) {}

    function build() {
        if (document.querySelector('.ha-cookie')) return;
        var bar = document.createElement('div');
        bar.className = 'ha-cookie';
        bar.setAttribute('role', 'dialog');
        bar.setAttribute('aria-label', 'Бисквитки');

        var txt = document.createElement('p');
        txt.className = 'ha-cookie-text';
        txt.innerHTML = 'Използваме само необходими бисквитки за вход и предпочитания — ' +
                        'без проследяване и реклами. <a href="/privacy.html">Научете повече</a>.';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ha-cookie-ok';
        btn.textContent = 'Разбрах';
        btn.addEventListener('click', function () {
            try { localStorage.setItem('cookie-consent', '1'); } catch (e) {}
            bar.classList.add('ha-cookie-hide');
            setTimeout(function () { if (bar.parentNode) bar.remove(); }, 350);
        });

        bar.appendChild(txt);
        bar.appendChild(btn);
        document.body.appendChild(bar);
    }

    if (document.readyState !== 'loading') build();
    else document.addEventListener('DOMContentLoaded', build);
})();
