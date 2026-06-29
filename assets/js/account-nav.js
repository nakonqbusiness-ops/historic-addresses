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

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function injectAccountLink() {
        var header = document.querySelector('header.site-header');
        var nav = header && header.querySelector('.nav');
        if (!nav || nav.querySelector('.nav-account') || header.querySelector('.nav-user')) return;

        // "Предложи" — a normal nav link (gold, no box/button), on desktop and mobile.
        if (!nav.querySelector('.nav-suggest')) {
            var sg = document.createElement('a');
            sg.className = 'nav-suggest';
            sg.href = '/suggest.html';
            sg.textContent = 'Предложи';
            nav.appendChild(sg);
        }

        // Reserve the account slot SYNCHRONOUSLY with a fixed-size skeleton, so the async
        // /api/auth/me check can never shift the layout (no late "Вход" spawn / 3rd-row
        // jump while the cookie check is in flight — this was visible on heavy pages like
        // addresses/map where the DB serialises many queries and /me resolves late). The
        // skeleton has the EXACT box of the guest "Вход" pill (same classes + content, only
        // rendered as a neutral loading placeholder), so the nav lays out in its final shape
        // from the first paint. On resolve we either turn it into the real link (guest) or
        // remove it and show the fixed avatar (logged-in) — neither changes the row count.
        var skel = document.createElement('span');
        skel.className = 'nav-account nav-account-skel';
        skel.setAttribute('aria-hidden', 'true');
        skel.innerHTML = USER_ICON + '<span>Вход</span>';
        nav.appendChild(skel);
        function clearSkel() { if (skel && skel.parentNode) skel.parentNode.removeChild(skel); }

        function showGuest() {
            if (nav.querySelector('.nav-account:not(.nav-account-skel)') || header.querySelector('.nav-user')) return;
            var a = document.createElement('a');
            a.className = 'nav-account';
            a.href = '/login.html';   // absolute so it works from /admin/ pages too
            a.innerHTML = USER_ICON + '<span>Вход</span>';
            // Swap the skeleton in place (identical box) → seamless, zero layout shift.
            if (skel && skel.parentNode) skel.parentNode.replaceChild(a, skel);
            else nav.appendChild(a);
        }
        fetch('/api/auth/me', { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (me) {
                if (me) {
                    // LOGGED IN: show the compact avatar dropdown (also absorbs the theme toggle).
                    document.body.classList.add('is-auth');
                    clearSkel();
                    buildUserMenu(header, me);
                } else {
                    showGuest();
                }
            })
            .catch(function () { showGuest(); });
    }

    function buildUserMenu(header, me) {
        var name    = (me.display_name && me.display_name.trim()) || me.email || 'Профил';
        var initial = (name.trim().charAt(0) || '?').toUpperCase();
        var role    = roleLabel(me.role) || 'Потребител';
        var isMod   = me.role === 'owner' || me.role === 'admin' || me.role === 'moderator';
        var isAdmin = me.role === 'owner' || me.role === 'admin';
        // Staff must have 2FA; if they don't yet, point the staff links straight at the
        // 2FA enrol section so they land exactly where they need to act.
        var needs2fa  = !!me.totp_required && !me.totp_enabled;
        var dashHref  = needs2fa ? '/profile.html#twofa' : '/admin/dashboard.html';
        var modHref   = needs2fa ? '/profile.html#twofa' : '/admin/moderation.html';

        var wrap = document.createElement('div');
        wrap.className = 'nav-user';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nav-user-btn';
        btn.setAttribute('aria-haspopup', 'true');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-label', 'Профил меню');
        btn.innerHTML =
            '<span class="nav-user-avatar">' + escapeHtml(initial) + '</span>' +
            '<svg class="nav-user-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

        var menu = document.createElement('div');
        menu.className = 'nav-user-menu';
        menu.setAttribute('hidden', '');
        menu.innerHTML =
            '<div class="nav-user-head">' +
                '<div class="nav-user-name"></div>' +
                (role ? '<div class="nav-user-role">Роля: ' + escapeHtml(role) + '</div>' : '') +
            '</div>' +
            '<div class="nav-user-div"></div>' +
            '<a class="nav-user-item" href="/profile.html#activity">Моите предложения</a>' +
            '<a class="nav-user-item" href="/profile.html#achievements">Постижения и приноси</a>' +
            '<a class="nav-user-item" href="/profile.html#saved">Запазени локации</a>' +
            (isAdmin ? '<a class="nav-user-item" href="' + dashHref + '">Управление</a>' : '') +
            (isMod ? '<a class="nav-user-item" href="' + modHref + '">Модерация</a>' : '') +
            '<a class="nav-user-item" href="/profile.html#settings">Настройки</a>' +
            '<div class="nav-user-div"></div>' +
            '<div class="nav-user-theme"><span>Светъл / Тъмен режим</span><span class="nav-user-theme-slot"></span></div>' +
            '<div class="nav-user-div"></div>' +
            '<button class="nav-user-item nav-user-logout" type="button">Изход</button>';
        // textContent (not innerHTML) for the name → safe against XSS from display_name/email.
        menu.querySelector('.nav-user-name').textContent = name;

        wrap.appendChild(btn);
        wrap.appendChild(menu);
        header.appendChild(wrap);

        // Relocate the already-wired theme toggle into the menu's theme row.
        var toggle = document.getElementById('theme-toggle');
        if (toggle) menu.querySelector('.nav-user-theme-slot').appendChild(toggle);

        // Smooth open/close: closing plays a fade/slide-out animation (CSS) before the
        // menu is actually removed from the layout.
        function open()  { wrap.classList.remove('closing'); menu.removeAttribute('hidden'); btn.setAttribute('aria-expanded', 'true'); wrap.classList.add('open'); }
        function close() {
            if (menu.hasAttribute('hidden') || wrap.classList.contains('closing')) return;
            btn.setAttribute('aria-expanded', 'false');
            wrap.classList.remove('open');
            wrap.classList.add('closing');
            var fin = function () { wrap.classList.remove('closing'); menu.setAttribute('hidden', ''); };
            var to = setTimeout(fin, 220);
            menu.addEventListener('animationend', function h() { menu.removeEventListener('animationend', h); clearTimeout(to); fin(); }, { once: true });
        }
        btn.addEventListener('click', function (e) { e.stopPropagation(); if (menu.hasAttribute('hidden')) open(); else close(); });
        document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
        // A click on the theme row toggles the mode, not the menu.
        menu.querySelector('.nav-user-theme').addEventListener('click', function (e) { e.stopPropagation(); });
        // Clicking any link inside smoothly dismisses the menu (incl. same-page #tab links).
        Array.prototype.forEach.call(menu.querySelectorAll('a.nav-user-item'), function (link) {
            link.addEventListener('click', function () { close(); });
        });

        menu.querySelector('.nav-user-logout').addEventListener('click', function () {
            fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
                .catch(function () {})
                .then(function () { location.href = '/index.html'; });
        });
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
   card) opens the BMC donation page in a centered popup window - instantly, with
   no third-party script on the page. On phones the OS opens it as a new tab.
   If the browser blocks the popup, we fall back to a normal new tab so donations
   never break. */
(function initDonate() {
    var BMC_URL   = 'https://buymeacoffee.com/historyaddress.bg';
    var TERMS_URL = '/donation-terms.html';
    var SELECTOR  = '.footer-donate, .pf-donate-cta, .js-donate';

    function donateTarget(el) {
        return el && el.closest ? el.closest(SELECTOR) : null;
    }

    // Opens BMC in a focused, centred popup. Triggered by the consent button click
    // (a real user gesture), so window.open is allowed; falls back to a new tab.
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

    // ── Consent dialog (self-contained: injects its own styles so it works on
    //    every page). The donor must accept the donation terms before continuing. ──
    var modal = null;
    var armedAt = 0;   // timestamp before which modal clicks are ignored (ghost-click guard)
    function buildModal() {
        if (modal) return modal;
        var st = document.createElement('style');
        st.textContent =
            '.donate-consent{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;padding:1.25rem;background:rgba(0,0,0,0.62);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);}' +
            '.donate-consent[hidden]{display:none;}' +
            ".dc-card{width:100%;max-width:440px;background:var(--card,#1f1812);border:1px solid var(--border,rgba(139,115,85,0.3));border-radius:18px;padding:1.9rem;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,0.55);font-family:'Mulish',sans-serif;}" +
            '.dc-icon{width:54px;height:54px;margin:0 auto 1rem;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#cd853f,#daa520);color:#fff;}' +
            ".dc-card h3{font-family:'Cormorant Garamond',Georgia,serif;font-size:1.6rem;font-weight:700;color:var(--fg,#e8dcc8);margin:0 0 0.6rem;}" +
            '.dc-card p{font-size:0.92rem;line-height:1.6;color:var(--muted,#a89378);margin:0 0 1rem;}' +
            '.dc-terms{display:inline-block;color:var(--accent-strong,#cd853f);font-weight:700;font-size:0.9rem;text-decoration:none;margin-bottom:1.4rem;}' +
            '.dc-terms:hover{text-decoration:underline;}' +
            '.dc-actions{display:flex;gap:0.6rem;justify-content:center;}' +
            ".donate-consent button{padding:0.72rem 1.3rem;border-radius:10px;font-family:'Mulish',sans-serif;font-weight:700;font-size:0.9rem;cursor:pointer;border:1px solid transparent;position:relative;}" +
            '.donate-consent button::before{display:none!important;}' +
            '.dc-cancel{background:transparent;border-color:var(--border,rgba(139,115,85,0.35));color:var(--fg,#e8dcc8);}' +
            '.dc-agree{background:linear-gradient(135deg,#cd853f,#daa520);color:#1a1410;}' +
            '.dc-agree:hover{filter:brightness(1.06);}' +
            '@media(max-width:480px){.dc-actions{flex-direction:column-reverse;}.donate-consent button{width:100%;}}';
        document.head.appendChild(st);

        modal = document.createElement('div');
        modal.className = 'donate-consent';
        modal.setAttribute('hidden', '');
        modal.innerHTML =
            '<div class="dc-card" role="dialog" aria-modal="true" aria-labelledby="dcTitle">' +
                '<div class="dc-icon"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></div>' +
                '<h3 id="dcTitle">Подкрепете ни</h3>' +
                '<p>Дарението е напълно доброволно и безвъзмездно - срещу него не получавате допълнителни услуги, роли или функции. Продължавайки, потвърждавате, че сте се запознали и приемате нашите Общи условия за дарения.</p>' +
                '<a class="dc-terms" href="' + TERMS_URL + '" target="_blank" rel="noopener noreferrer">Прочети Общите условия за дарения →</a>' +
                '<div class="dc-actions">' +
                    '<button type="button" class="dc-cancel">Отказ</button>' +
                    '<button type="button" class="dc-agree">Приемам и продължавам</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(modal);

        // Ignore any interaction for a short window after opening. This defeats the
        // mobile "ghost click": the tap that opens the modal is followed ~300ms later
        // by a synthetic click that would otherwise land on the centred Agree button
        // and auto-confirm. Until armed, every modal click is swallowed.
        function tooSoon() { return Date.now() < armedAt; }
        modal.addEventListener('click', function (e) { if (tooSoon()) return; if (e.target === modal) hide(); });
        modal.querySelector('.dc-cancel').addEventListener('click', function () { if (tooSoon()) return; hide(); });
        modal.querySelector('.dc-agree').addEventListener('click', function () { if (tooSoon()) return; hide(); openDonate(); });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal && !modal.hasAttribute('hidden')) hide(); });
        return modal;
    }
    function show() {
        buildModal();
        armedAt = Date.now() + 450;                 // ignore clicks for 450ms
        modal.removeAttribute('hidden');
        document.body.style.overflow = 'hidden';
        setTimeout(function () { var b = modal.querySelector('.dc-agree'); if (b) b.focus(); }, 480);
    }
    function hide() { if (modal) { modal.setAttribute('hidden', ''); document.body.style.overflow = ''; } }

    document.addEventListener('click', function (e) {
        var t = donateTarget(e.target);
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        if (modal && !modal.hasAttribute('hidden')) return;   // already open - ignore
        show();
    }, true);   // capture phase: run before other link handlers
})();

/* ── Minimal GDPR cookie notice ──────────────────────────────────────────────
   We use only essential cookies (login session + theme preference) and no
   third-party tracking, so this is a one-time informational notice. Acceptance
   is remembered in localStorage. The bar sits below the calendar popup so it
   never interferes with it on mobile (see .ha-cookie in styles.css). */
(function cookieNotice() {
    try { if (localStorage.getItem('cookie-consent') === '1') return; } catch (e) {}

    // On mobile the calendar popup (#calPopup, bottom:15px z:9999) and this banner
    // both pin to the bottom. While the banner is up we (a) raise it above the
    // calendar so its button is always tappable, and (b) push the calendar popup up
    // by the banner's measured height so they never overlap.
    var st = document.createElement('style');
    st.textContent =
        '.ha-cookie{z-index:10001!important;}' +
        // Smoother, slightly longer exit for the banner.
        '.ha-cookie-hide{opacity:0!important;transform:translateY(18px) scale(0.985)!important;' +
            'transition:opacity .5s cubic-bezier(0.4,0,0.2,1),transform .5s cubic-bezier(0.4,0,0.2,1)!important;}' +
        '@media (max-width:768px){' +
            '#calPopup{transition:bottom .55s cubic-bezier(0.16,1,0.3,1);}' +
            'body.ha-cookie-shown #calPopup{bottom:calc(0.6rem + var(--ha-cookie-h,120px) + 14px)!important;}' +
        '}';
    document.head.appendChild(st);

    var bar = null;
    function syncHeight() {
        if (!bar) return;
        document.documentElement.style.setProperty('--ha-cookie-h', bar.offsetHeight + 'px');
    }

    function build() {
        if (document.querySelector('.ha-cookie')) return;
        bar = document.createElement('div');
        bar.className = 'ha-cookie';
        bar.setAttribute('role', 'dialog');
        bar.setAttribute('aria-label', 'Бисквитки');

        var txt = document.createElement('p');
        txt.className = 'ha-cookie-text';
        txt.innerHTML = 'Използваме само необходими бисквитки за вход и предпочитания - ' +
                        'без проследяване и реклами. <a href="/privacy.html">Научете повече</a>.';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ha-cookie-ok';
        btn.textContent = 'Разбрах';
        btn.addEventListener('click', function () {
            try { localStorage.setItem('cookie-consent', '1'); } catch (e) {}
            window.removeEventListener('resize', syncHeight);
            // Both start together: banner eases out while the calendar glides down - no gap.
            bar.classList.add('ha-cookie-hide');
            document.body.classList.remove('ha-cookie-shown');
            setTimeout(function () { if (bar.parentNode) bar.remove(); }, 560);
        });

        bar.appendChild(txt);
        bar.appendChild(btn);
        document.body.appendChild(bar);
        document.body.classList.add('ha-cookie-shown');
        syncHeight();
        window.addEventListener('resize', syncHeight);
    }

    if (document.readyState !== 'loading') build();
    else document.addEventListener('DOMContentLoaded', build);
})();
