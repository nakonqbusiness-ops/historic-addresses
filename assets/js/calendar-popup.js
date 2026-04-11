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
        .catch(function(err) { console.error('Error:', err); });

function showPopup(events) {
        var popup = document.createElement('div');
        popup.id = 'calendarPopup';
        
        var isMobile = window.innerWidth <= 768;
        var containerStyle = isMobile 
            ? 'position:fixed;bottom:15px;left:15px;right:15px;z-index:9999;' 
            : 'position:fixed;top:20px;right:20px;z-index:9999;max-width:380px;width:90%;';
        popup.style.cssText = containerStyle;

        var card = document.createElement('div');
        card.id = 'calendarCard';
        card.style.cssText = 'background:var(--card);border:2px solid var(--accent-strong);border-radius:25px;padding:12px 20px;box-shadow:0 10px 40px rgba(0,0,0,0.5);cursor:pointer;transition:all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);overflow:hidden;position:relative;';
        
        // --- МИНИ РЕЖИМ ---
        var miniContent = document.createElement('div');
        miniContent.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
        miniContent.innerHTML = '<span style="font-weight:700;color:var(--fg);display:flex;align-items:center;">📅 ' + events.length + (events.length === 1 ? ' събитие' : ' събития') + ' днес</span>' +
                                '<span style="font-size:0.8rem;color:var(--accent-soft);animation:pulse 2s infinite;">детайли ↑</span>';

        // --- ПЪЛЕН РЕЖИМ ---
        var fullContent = document.createElement('div');
        fullContent.style.display = 'none';
        
        // Заглавие (Вече без "свий" до него)
        var titleContainer = document.createElement('div');
        titleContainer.style.cssText = 'margin-bottom:15px;padding-bottom:10px;border-bottom:1px solid rgba(205,133,63,0.2);';
        titleContainer.innerHTML = '<h3 style="margin:0;font-size:1.1rem;color:var(--fg);">На този ден:</h3>';
        fullContent.appendChild(titleContainer);

        // Списък със събития
        events.forEach(function(event) {
            var item = document.createElement('a');
            item.href = 'address.html?slug=' + encodeURIComponent(event.slug);
            item.style.cssText = 'display:flex;align-items:center;padding:10px;margin-bottom:8px;background:rgba(205,133,63,0.1);border-radius:12px;text-decoration:none;color:var(--fg);';
            
            var icon = event.type === 'birth' ? '🎂' : '🕯️';
            var action = event.type === 'birth' ? 'роден(а)' : 'починал(а)';
            
            item.innerHTML = '<div style="font-size:1.3rem;margin-right:12px;">' + icon + '</div>' +
                             '<div>' +
                                '<div style="font-weight:700;font-size:0.9rem;">' + event.name + '</div>' +
                                '<div style="font-size:0.8rem;color:var(--muted);">Преди ' + event.years_ago + ' г. е ' + action + '</div>' +
                             '</div>';
            fullContent.appendChild(item);
        });

        // НОВИЯТ БУТОН "СВИЙ" (Най-отдолу)
        var shrinkHint = document.createElement('div');
        shrinkHint.style.cssText = 'text-align:center;margin-top:10px;font-size:0.8rem;color:var(--accent-soft);font-weight:600;padding-top:5px;';
        shrinkHint.innerHTML = 'свий обратно ↓';
        fullContent.appendChild(shrinkHint);

        // Бутон за окончателно затваряне (X)
        var closeBtn = document.createElement('button');
        closeBtn.innerHTML = '×';
        closeBtn.style.cssText = 'position:absolute;top:8px;right:15px;background:transparent;border:none;font-size:1.8rem;color:var(--muted);cursor:pointer;display:none;z-index:10;padding:0;line-height:1;';

        // ЛОГИКА
        card.onclick = function() {
            if (fullContent.style.display === 'none') {
                fullContent.style.display = 'block';
                miniContent.style.display = 'none';
                closeBtn.style.display = 'block';
                card.style.padding = '20px';
                card.style.borderRadius = '20px';
            } else {
                // Свиване при клик навсякъде по картата (освен върху линковете)
                fullContent.style.display = 'none';
                miniContent.style.display = 'flex';
                closeBtn.style.display = 'none';
                card.style.padding = '12px 20px';
                card.style.borderRadius = '25px';
            }
        };

        closeBtn.onclick = function(e) {
            e.stopPropagation(); 
            dismissPopup();
        };

        card.appendChild(miniContent);
        card.appendChild(fullContent);
        card.appendChild(closeBtn);
        popup.appendChild(card);
        
        var style = document.createElement('style');
        style.textContent = `
            @keyframes slideUp { from{transform:translateY(100px);opacity:0;} to{transform:translateY(0);opacity:1;} }
            @keyframes pulse { 0%{opacity:0.6;} 50%{opacity:1;} 100%{opacity:0.6;} }
        `;
        document.head.appendChild(style);
        
        card.style.animation = isMobile ? 'slideUp 0.6s ease' : 'slideInRight 0.5s ease';
        document.body.appendChild(popup);
    }
    function dismissPopup() {
        var popup = document.getElementById('calendarPopup');
        if (popup) {
            popup.style.opacity = '0';
            popup.style.transform = 'translateY(20px)';
            setTimeout(function() { popup.remove(); }, 300);
        }
        localStorage.setItem('calendar-popup-dismissed', new Date().toISOString().split('T')[0]);
    }
})();
