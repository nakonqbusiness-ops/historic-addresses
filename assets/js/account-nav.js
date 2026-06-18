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
        a.href = '/login.html';   // absolute so it works from /admin/ pages too
        a.innerHTML = USER_ICON + '<span>Вход</span>';
        nav.appendChild(a);

        fetch('/api/auth/me', { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (me) {
                if (!me) return;
                document.body.classList.add('is-auth');
                a.href = '/profile.html';   // absolute so it works from /admin/ pages too
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
                '<p>Дарението е напълно доброволно и безвъзмездно — срещу него не получавате допълнителни услуги, роли или функции. Продължавайки, потвърждавате, че сте се запознали и приемате нашите Общи условия за дарения.</p>' +
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
        if (modal && !modal.hasAttribute('hidden')) return;   // already open — ignore
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
        txt.innerHTML = 'Използваме само необходими бисквитки за вход и предпочитания — ' +
                        'без проследяване и реклами. <a href="/privacy.html">Научете повече</a>.';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ha-cookie-ok';
        btn.textContent = 'Разбрах';
        btn.addEventListener('click', function () {
            try { localStorage.setItem('cookie-consent', '1'); } catch (e) {}
            window.removeEventListener('resize', syncHeight);
            bar.classList.add('ha-cookie-hide');            // banner eases out (~0.5s)
            setTimeout(function () {
                if (bar.parentNode) bar.remove();
                document.body.classList.remove('ha-cookie-shown');   // THEN the calendar glides down
            }, 520);
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
