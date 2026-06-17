// calendar-popup.js
(function() {
    var apiBase = window.location.protocol === 'file:' ? 'http://localhost:3000' : window.location.origin;
    var today = new Date().toISOString().split('T')[0];
    var dismissed = localStorage.getItem('calendar-popup-dismissed');

    if (dismissed === today) return;

    fetch(apiBase + '/api/calendar/today')
        .then(function(res) { return res.json(); })
        .then(function(events) {
            if (events.length === 0) return;
            showPopup(events);
        })
        .catch(function(err) { console.error('Calendar popup error:', err); });

    function showPopup(events) {
        // Inject styles
        var style = document.createElement('style');
        style.textContent = [
            '@keyframes cpSlideUp{from{transform:translateY(24px);opacity:0}to{transform:translateY(0);opacity:1}}',
            '@keyframes cpSlideIn{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}',
            '@keyframes cpPulse{0%,100%{opacity:.5}50%{opacity:1}}',
            '@keyframes cpRing{0%,100%{box-shadow:0 0 0 0 rgba(201,169,110,0)}60%{box-shadow:0 0 0 6px rgba(201,169,110,0.18)}}',
            '#calPopup *{box-sizing:border-box;font-family:"Mulish","DM Sans",sans-serif}',
            '#calCard{background:linear-gradient(160deg,rgba(26,22,16,0.98) 0%,rgba(18,15,10,0.99) 100%);border:1px solid rgba(201,169,110,0.35);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.55),0 1px 0 rgba(201,169,110,0.15) inset;overflow:hidden;transition:all 0.35s cubic-bezier(0.16,1,0.3,1);position:relative}',
            '#calCard::before{content:"";position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(201,169,110,0.5),transparent);pointer-events:none}',
            '.cp-mini{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;gap:12px;cursor:pointer}',
            '.cp-mini-left{display:flex;align-items:center;gap:10px}',
            '.cp-mini-dot{width:8px;height:8px;border-radius:50%;background:#c9a96e;flex-shrink:0;animation:cpRing 2.4s ease-in-out infinite}',
            '.cp-mini-label{font-size:.78rem;font-weight:700;letter-spacing:.04em;color:#e8dcc8}',
            '.cp-mini-count{font-size:.68rem;font-weight:700;background:rgba(201,169,110,0.18);border:1px solid rgba(201,169,110,0.3);color:#c9a96e;padding:.15rem .5rem;border-radius:999px;letter-spacing:.04em}',
            '.cp-mini-chevron{font-size:.65rem;color:rgba(201,169,110,0.6);transition:transform .3s;flex-shrink:0;margin-left:auto}',
            '.cp-mini-chevron.open{transform:rotate(180deg)}',
            '.cp-full{display:none;border-top:1px solid rgba(201,169,110,0.12)}',
            '.cp-full-head{padding:14px 16px 10px;display:flex;align-items:center;justify-content:space-between}',
            '.cp-full-title{font-size:.62rem;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:rgba(201,169,110,0.7);margin:0}',
            '.cp-close{background:transparent;border:none;cursor:pointer;color:rgba(201,169,110,0.45);font-size:1rem;line-height:1;padding:2px 4px;transition:color .2s;display:flex;align-items:center;justify-content:center}',
            '.cp-close:hover{color:#c9a96e}',
            '.cp-events{padding:0 12px 14px;display:flex;flex-direction:column;gap:6px}',
            '.cp-event{display:flex;align-items:center;gap:12px;padding:10px 12px;background:rgba(201,169,110,0.06);border:1px solid rgba(201,169,110,0.12);border-radius:10px;text-decoration:none;color:#e8dcc8;transition:background .2s,border-color .2s}',
            '.cp-event:hover{background:rgba(201,169,110,0.12);border-color:rgba(201,169,110,0.28)}',
            '.cp-event-icon{font-size:1.2rem;flex-shrink:0;line-height:1}',
            '.cp-event-name{font-size:.84rem;font-weight:700;color:#f0e8d8;line-height:1.2;margin-bottom:.18rem}',
            '.cp-event-sub{font-size:.71rem;color:rgba(201,169,110,0.65);line-height:1}',
            '.cp-event-arrow{margin-left:auto;font-size:.75rem;color:rgba(201,169,110,0.4);flex-shrink:0;transition:transform .2s}',
            '.cp-event:hover .cp-event-arrow{transform:translateX(3px);color:rgba(201,169,110,0.8)}',
            '.cp-shrink{text-align:center;padding:8px 16px 13px;cursor:pointer}',
            '.cp-shrink span{font-size:.67rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(201,169,110,0.45);transition:color .2s}',
            '.cp-shrink:hover span{color:rgba(201,169,110,0.8)}'
        ].join('');
        document.head.appendChild(style);

        var isMobile = window.innerWidth <= 768;

        // Container
        var popup = document.createElement('div');
        popup.id = 'calPopup';
        popup.style.cssText = isMobile
            ? 'position:fixed;bottom:15px;left:15px;right:15px;z-index:9999;'
            : 'position:fixed;top:20px;right:20px;z-index:9999;max-width:340px;width:90%;';

        // Card
        var card = document.createElement('div');
        card.id = 'calCard';
        card.style.animation = isMobile ? 'cpSlideUp .5s cubic-bezier(0.16,1,0.3,1) both' : 'cpSlideIn .5s cubic-bezier(0.16,1,0.3,1) both';

        // ── MINI MODE ──
        var mini = document.createElement('div');
        mini.className = 'cp-mini';
        mini.innerHTML =
            '<div class="cp-mini-left">' +
                '<div class="cp-mini-dot"></div>' +
                '<span class="cp-mini-label">На този ден</span>' +
            '</div>' +
            '<span class="cp-mini-count">' + events.length + (events.length === 1 ? ' събитие' : ' събития') + '</span>' +
            '<span class="cp-mini-chevron" id="cpChevron">▲</span>';

        // ── FULL MODE ──
        var full = document.createElement('div');
        full.className = 'cp-full';
        full.id = 'cpFull';

        // Header row
        var head = document.createElement('div');
        head.className = 'cp-full-head';
        head.innerHTML = '<p class="cp-full-title">Календар на историята</p>';

        var closeBtn = document.createElement('button');
        closeBtn.className = 'cp-close';
        closeBtn.innerHTML = '✕';
        closeBtn.title = 'Затвори';
        closeBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            dismissPopup();
        });
        head.appendChild(closeBtn);
        full.appendChild(head);

        // Events list
        var eventsWrap = document.createElement('div');
        eventsWrap.className = 'cp-events';

        events.forEach(function(event) {
            var item = document.createElement('a');
            item.className = 'cp-event';
            item.href = 'address.html?slug=' + encodeURIComponent(event.slug);
            var icon = event.type === 'birth' ? '🎂' : '🕯️';
            var action = event.type === 'birth' ? 'роден/а' : 'починал/а';
            item.innerHTML =
                '<span class="cp-event-icon">' + icon + '</span>' +
                '<div>' +
                    '<div class="cp-event-name">' + event.name + '</div>' +
                    '<div class="cp-event-sub">Преди ' + event.years_ago + ' г. е ' + action + '</div>' +
                '</div>' +
                '<span class="cp-event-arrow">→</span>';
            eventsWrap.appendChild(item);
        });
        full.appendChild(eventsWrap);

        // Shrink hint
        var shrink = document.createElement('div');
        shrink.className = 'cp-shrink';
        shrink.innerHTML = '<span>свий ↑</span>';
        full.appendChild(shrink);

        // ── TOGGLE LOGIC ── (unchanged from original)
        var isOpen = false;

        function openFull() {
            isOpen = true;
            full.style.display = 'block';
            mini.style.display = 'none';
            document.getElementById('cpChevron').classList.add('open');
        }

        function closeFull() {
            isOpen = false;
            full.style.display = 'none';
            mini.style.display = 'flex';
            document.getElementById('cpChevron').classList.remove('open');
        }

        mini.addEventListener('click', function() {
            if (!isOpen) openFull();
        });

        shrink.addEventListener('click', function(e) {
            e.stopPropagation();
            closeFull();
        });

        // Clicking anywhere on the full card (except links and close) shrinks it
        full.addEventListener('click', function(e) {
            if (e.target.closest('.cp-event') || e.target.closest('.cp-close')) return;
            closeFull();
        });

        card.appendChild(mini);
        card.appendChild(full);
        popup.appendChild(card);
        document.body.appendChild(popup);
    }

    function dismissPopup() {
        var popup = document.getElementById('calPopup');
        if (popup) {
            popup.style.opacity = '0';
            popup.style.transform = 'translateY(16px)';
            popup.style.transition = 'all .25s ease';
            setTimeout(function() { popup.remove(); }, 260);
        }
        localStorage.setItem('calendar-popup-dismissed', new Date().toISOString().split('T')[0]);
    }
})();