// calendar-popup.js
(function() {
    var apiBase = window.location.protocol === 'file:' ? 'http://localhost:3000' : window.location.origin;

    var today = new Date().toISOString().split('T')[0];
    if (localStorage.getItem('calendar-popup-dismissed') === today) return;

    fetch(apiBase + '/api/calendar/today')
        .then(function(res) { return res.json(); })
        .then(function(events) {
            if (events.length === 0) return;
            injectStyles();
            if (window.innerWidth <= 768) {
                showMobilePill(events);
            } else {
                showDesktopPopup(events);
            }
        })
        .catch(function(err) {
            console.error('Error loading calendar events:', err);
        });

    /* ── Shared styles ─────────────────────────────────────── */
    function injectStyles() {
        var style = document.createElement('style');
        style.textContent = `
            /* ── Desktop popup ────────────────────────────── */
            @keyframes cpSlideIn {
                from { opacity: 0; transform: translateY(16px) scale(0.97); }
                to   { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes cpSlideOut {
                to { opacity: 0; transform: translateY(12px) scale(0.96); }
            }
            @keyframes cpShimmer {
                from { background-position: 200% 0; }
                to   { background-position: -200% 0; }
            }
            @keyframes cpPulse {
                0%,100% { opacity: 1; transform: scale(1); }
                50%      { opacity: 0.5; transform: scale(0.7); }
            }

            #calendarPopup {
                position: fixed;
                bottom: 1.5rem;
                right: 1.5rem;
                z-index: 9999;
                width: min(380px, calc(100vw - 2rem));
                font-family: "Baskerville", "Garamond", Georgia, serif;
                animation: cpSlideIn 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
            }

            #calendarPopup .cp-card {
                background: var(--card);
                border: 1px solid var(--border);
                border-radius: 18px;
                overflow: hidden;
                box-shadow: 0 20px 60px rgba(0,0,0,0.45), 0 0 0 1px rgba(205,133,63,0.15);
            }

            #calendarPopup .cp-stripe {
                height: 3px;
                background: linear-gradient(90deg, #cd853f, #daa520, #cd853f);
                background-size: 200% 100%;
                animation: cpShimmer 3s linear infinite;
            }

            #calendarPopup .cp-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 1rem 1.25rem 0.75rem;
                border-bottom: 1px solid var(--border);
            }

            #calendarPopup .cp-title {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                font-size: 0.7rem;
                font-weight: 700;
                letter-spacing: 0.14em;
                text-transform: uppercase;
                color: var(--accent-strong);
            }

            #calendarPopup .cp-dot {
                width: 6px; height: 6px;
                border-radius: 50%;
                background: var(--accent-strong);
                animation: cpPulse 2s ease-in-out infinite;
            }

            #calendarPopup .cp-close {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 28px; height: 28px;
                border-radius: 50%;
                border: 1px solid var(--border);
                background: transparent;
                color: var(--muted);
                font-size: 1rem;
                cursor: pointer;
                line-height: 1;
                transition: all 0.2s;
                padding: 0;
            }
            #calendarPopup .cp-close:hover {
                background: rgba(205,133,63,0.12);
                border-color: var(--accent-strong);
                color: var(--accent-strong);
            }

            #calendarPopup .cp-body {
                padding: 1rem 1.25rem;
                display: flex;
                flex-direction: column;
                gap: 0.6rem;
                max-height: 280px;
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color: var(--accent-strong) transparent;
            }

            #calendarPopup .cp-event {
                display: flex;
                align-items: center;
                gap: 0.85rem;
                padding: 0.75rem 0.9rem;
                border-radius: 10px;
                border: 1px solid var(--border);
                background: rgba(205,133,63,0.05);
                text-decoration: none;
                color: var(--fg);
                transition: all 0.25s ease;
                position: relative;
                overflow: hidden;
            }
            #calendarPopup .cp-event::before {
                content: '';
                position: absolute;
                left: 0; top: 0; bottom: 0;
                width: 3px;
                background: var(--accent-strong);
                transform: scaleY(0);
                transform-origin: bottom;
                transition: transform 0.25s ease;
                border-radius: 0 2px 2px 0;
            }
            #calendarPopup .cp-event:hover {
                background: rgba(205,133,63,0.12);
                border-color: rgba(205,133,63,0.4);
                transform: translateX(3px);
            }
            #calendarPopup .cp-event:hover::before { transform: scaleY(1); }

            #calendarPopup .cp-event-icon {
                font-size: 1.6rem;
                flex-shrink: 0;
                line-height: 1;
            }
            #calendarPopup .cp-event-name {
                font-size: 0.97rem;
                font-weight: 700;
                color: var(--fg);
                line-height: 1.2;
                margin-bottom: 0.15rem;
            }
            #calendarPopup .cp-event-sub {
                font-size: 0.78rem;
                color: var(--muted);
                font-family: "Mulish", sans-serif;
            }

            #calendarPopup .cp-footer {
                padding: 0.75rem 1.25rem 1rem;
                border-top: 1px solid var(--border);
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            #calendarPopup .cp-footer-date {
                font-size: 0.72rem;
                color: var(--muted);
                font-family: "Mulish", sans-serif;
                opacity: 0.7;
            }
            #calendarPopup .cp-link {
                font-size: 0.78rem;
                font-weight: 700;
                color: var(--accent-strong);
                text-decoration: none;
                letter-spacing: 0.04em;
                display: flex;
                align-items: center;
                gap: 0.3rem;
                transition: gap 0.2s;
            }
            #calendarPopup .cp-link:hover { gap: 0.55rem; }

            /* ── Mobile pill ───────────────────────────────── */
            @keyframes cpPillIn {
                from { opacity: 0; transform: translateY(20px); }
                to   { opacity: 1; transform: translateY(0); }
            }

            #calendarPill {
                position: fixed;
                bottom: 1rem;
                left: 50%;
                transform: translateX(-50%);
                z-index: 9999;
                font-family: "Baskerville", "Garamond", Georgia, serif;
                animation: cpPillIn 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
                width: calc(100vw - 2rem);
                max-width: 420px;
            }

            /* the compact pill bar */
            #calendarPill .pill-bar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 0.75rem;
                padding: 0.7rem 1rem;
                background: var(--card);
                border: 1px solid rgba(205,133,63,0.45);
                border-radius: 999px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(205,133,63,0.1);
                cursor: pointer;
                transition: all 0.2s ease;
            }
            #calendarPill .pill-bar:hover {
                border-color: var(--accent-strong);
                box-shadow: 0 10px 36px rgba(0,0,0,0.45);
            }

            #calendarPill .pill-left {
                display: flex;
                align-items: center;
                gap: 0.55rem;
                min-width: 0;
                flex: 1;
                overflow: hidden;
            }
            #calendarPill .pill-dot {
                width: 7px; height: 7px;
                border-radius: 50%;
                background: var(--accent-strong);
                flex-shrink: 0;
                animation: cpPulse 2s ease-in-out infinite;
            }
            #calendarPill .pill-text {
                font-size: 0.82rem;
                font-weight: 700;
                color: var(--fg);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                min-width: 0;
                flex: 1;
            }
            #calendarPill .pill-text em {
                color: var(--accent-strong);
                font-style: normal;
            }
            #calendarPill .pill-right {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                flex-shrink: 0;
            }
            #calendarPill .pill-expand {
                font-size: 0.72rem;
                color: var(--accent-strong);
                font-weight: 700;
                letter-spacing: 0.06em;
            }
            #calendarPill .pill-dismiss {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 22px; height: 22px;
                border-radius: 50%;
                border: 1px solid var(--border);
                background: transparent;
                color: var(--muted);
                font-size: 0.85rem;
                cursor: pointer;
                line-height: 1;
                transition: all 0.2s;
                padding: 0;
            }
            #calendarPill .pill-dismiss:hover {
                background: rgba(205,133,63,0.15);
                border-color: var(--accent-strong);
                color: var(--accent-strong);
            }

            /* expanded panel slides up from the pill */
            #calendarPill .pill-panel {
                background: var(--card);
                border: 1px solid var(--border);
                border-radius: 16px;
                overflow: hidden;
                box-shadow: 0 20px 60px rgba(0,0,0,0.45);
                margin-bottom: 0.6rem;
                max-height: 0;
                opacity: 0;
                transition: max-height 0.4s cubic-bezier(0.22,1,0.36,1),
                            opacity 0.3s ease,
                            margin-bottom 0.3s ease;
                pointer-events: none;
            }
            #calendarPill .pill-panel.open {
                max-height: 400px;
                opacity: 1;
                pointer-events: all;
            }

            #calendarPill .pill-panel-stripe {
                height: 3px;
                background: linear-gradient(90deg, #cd853f, #daa520, #cd853f);
                background-size: 200% 100%;
                animation: cpShimmer 3s linear infinite;
            }

            #calendarPill .pill-panel-events {
                padding: 0.75rem 1rem;
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                max-height: 220px;
                overflow-y: auto;
            }

            #calendarPill .pill-event {
                display: flex;
                align-items: center;
                gap: 0.75rem;
                padding: 0.65rem 0.85rem;
                border-radius: 10px;
                border: 1px solid var(--border);
                background: rgba(205,133,63,0.05);
                text-decoration: none;
                color: var(--fg);
                transition: background 0.2s, border-color 0.2s;
            }
            #calendarPill .pill-event:hover {
                background: rgba(205,133,63,0.12);
                border-color: rgba(205,133,63,0.4);
            }
            #calendarPill .pill-event-icon { font-size: 1.3rem; flex-shrink: 0; line-height: 1; }
            #calendarPill .pill-event-name {
                font-size: 0.88rem;
                font-weight: 700;
                color: var(--fg);
                margin-bottom: 0.1rem;
                line-height: 1.2;
            }
            #calendarPill .pill-event-sub {
                font-size: 0.73rem;
                color: var(--muted);
                font-family: "Mulish", sans-serif;
            }

            #calendarPill .pill-panel-footer {
                padding: 0.6rem 1rem 0.75rem;
                border-top: 1px solid var(--border);
                text-align: center;
            }
            #calendarPill .pill-panel-link {
                font-size: 0.78rem;
                font-weight: 700;
                color: var(--accent-strong);
                text-decoration: none;
                letter-spacing: 0.04em;
            }
        `;
        document.head.appendChild(style);
    }

    /* ── Desktop popup ─────────────────────────────────────── */
    function showDesktopPopup(events) {
        var popup = document.createElement('div');
        popup.id = 'calendarPopup';

        var card = document.createElement('div');
        card.className = 'cp-card';

        var stripe = document.createElement('div');
        stripe.className = 'cp-stripe';

        var header = document.createElement('div');
        header.className = 'cp-header';

        var titleWrap = document.createElement('div');
        titleWrap.className = 'cp-title';
        var dot = document.createElement('div');
        dot.className = 'cp-dot';
        titleWrap.appendChild(dot);
        titleWrap.appendChild(document.createTextNode('На този ден'));

        var closeBtn = document.createElement('button');
        closeBtn.className = 'cp-close';
        closeBtn.innerHTML = '×';
        closeBtn.setAttribute('aria-label', 'Затвори');
        closeBtn.onclick = dismissDesktop;

        header.appendChild(titleWrap);
        header.appendChild(closeBtn);

        var body = document.createElement('div');
        body.className = 'cp-body';

        events.forEach(function(event) {
            var link = document.createElement('a');
            link.className = 'cp-event';
            link.href = 'address.html?slug=' + encodeURIComponent(event.slug);

            var icon = document.createElement('div');
            icon.className = 'cp-event-icon';
            icon.textContent = event.type === 'birth' ? '🎂' : '🕯️';

            var info = document.createElement('div');
            var name = document.createElement('div');
            name.className = 'cp-event-name';
            name.textContent = event.name;
            var sub = document.createElement('div');
            sub.className = 'cp-event-sub';
            sub.textContent = 'Преди ' + event.years_ago + ' ' +
                (event.years_ago === 1 ? 'година' : 'години') + ' — ' +
                (event.type === 'birth' ? 'роден(а)' : 'починал(а)');

            info.appendChild(name);
            info.appendChild(sub);
            link.appendChild(icon);
            link.appendChild(info);
            body.appendChild(link);
        });

        var footer = document.createElement('div');
        footer.className = 'cp-footer';

        var dateLabel = document.createElement('span');
        dateLabel.className = 'cp-footer-date';
        var d = new Date();
        dateLabel.textContent = d.toLocaleDateString('bg-BG', { day: 'numeric', month: 'long', year: 'numeric' });

        var calLink = document.createElement('a');
        calLink.className = 'cp-link';
        calLink.href = 'calendar.html';
        calLink.innerHTML = 'Виж календара <span>→</span>';

        footer.appendChild(dateLabel);
        footer.appendChild(calLink);

        card.appendChild(stripe);
        card.appendChild(header);
        card.appendChild(body);
        card.appendChild(footer);
        popup.appendChild(card);
        document.body.appendChild(popup);
    }

    function dismissDesktop() {
        var popup = document.getElementById('calendarPopup');
        if (!popup) return;
        popup.style.animation = 'cpSlideOut 0.3s ease forwards';
        setTimeout(function() { popup.remove(); }, 300);
        saveDismissed();
    }

    /* ── Mobile pill ───────────────────────────────────────── */
    function showMobilePill(events) {
        var pill = document.createElement('div');
        pill.id = 'calendarPill';

        /* expandable panel (rendered first so it sits above the bar) */
        var panel = document.createElement('div');
        panel.className = 'pill-panel';

        var panelStripe = document.createElement('div');
        panelStripe.className = 'pill-panel-stripe';

        var panelEvents = document.createElement('div');
        panelEvents.className = 'pill-panel-events';

        events.forEach(function(event) {
            var link = document.createElement('a');
            link.className = 'pill-event';
            link.href = 'address.html?slug=' + encodeURIComponent(event.slug);

            var icon = document.createElement('div');
            icon.className = 'pill-event-icon';
            icon.textContent = event.type === 'birth' ? '🎂' : '🕯️';

            var info = document.createElement('div');
            var name = document.createElement('div');
            name.className = 'pill-event-name';
            name.textContent = event.name;
            var sub = document.createElement('div');
            sub.className = 'pill-event-sub';
            sub.textContent = 'Преди ' + event.years_ago + ' ' +
                (event.years_ago === 1 ? 'година' : 'години') + ' — ' +
                (event.type === 'birth' ? 'роден(а)' : 'починал(а)');
            info.appendChild(name);
            info.appendChild(sub);
            link.appendChild(icon);
            link.appendChild(info);
            panelEvents.appendChild(link);
        });

        var panelFooter = document.createElement('div');
        panelFooter.className = 'pill-panel-footer';
        var panelLink = document.createElement('a');
        panelLink.className = 'pill-panel-link';
        panelLink.href = 'calendar.html';
        panelLink.textContent = '→ Виж пълния календар';
        panelFooter.appendChild(panelLink);

        panel.appendChild(panelStripe);
        panel.appendChild(panelEvents);
        panel.appendChild(panelFooter);

        /* compact pill bar */
        var bar = document.createElement('div');
        bar.className = 'pill-bar';

        var left = document.createElement('div');
        left.className = 'pill-left';

        var pdot = document.createElement('div');
        pdot.className = 'pill-dot';

        var text = document.createElement('div');
        text.className = 'pill-text';
        var count = events.length;
        var first = events[0];
        var icon = first.type === 'birth' ? '🎂' : '🕯️';
        if (count === 1) {
            text.innerHTML = icon + ' <em>' + first.name + '</em> — на този ден';
        } else {
            text.innerHTML = '📅 <em>' + count + ' събития</em> на този ден';
        }

        left.appendChild(pdot);
        left.appendChild(text);

        var right = document.createElement('div');
        right.className = 'pill-right';

        var expandLabel = document.createElement('span');
        expandLabel.className = 'pill-expand';
        expandLabel.textContent = 'Виж';

        var dismissBtn = document.createElement('button');
        dismissBtn.className = 'pill-dismiss';
        dismissBtn.innerHTML = '×';
        dismissBtn.setAttribute('aria-label', 'Затвори');
        dismissBtn.onclick = function(e) {
            e.stopPropagation();
            dismissMobile();
        };

        right.appendChild(expandLabel);
        right.appendChild(dismissBtn);
        bar.appendChild(left);
        bar.appendChild(right);

        /* toggle expand on bar click */
        var expanded = false;
        bar.onclick = function() {
            expanded = !expanded;
            panel.classList.toggle('open', expanded);
            expandLabel.textContent = expanded ? 'Скрий' : 'Виж';
        };

        pill.appendChild(panel);
        pill.appendChild(bar);
        document.body.appendChild(pill);
    }

    function dismissMobile() {
        var pill = document.getElementById('calendarPill');
        if (!pill) return;
        pill.style.animation = 'cpPillIn 0.25s ease reverse forwards';
        setTimeout(function() { pill.remove(); }, 250);
        saveDismissed();
    }

    function saveDismissed() {
        localStorage.setItem('calendar-popup-dismissed', new Date().toISOString().split('T')[0]);
    }
})();
