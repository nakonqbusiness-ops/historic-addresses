(function() {
    var apiBase = window.location.protocol === 'file:' ? 'http://localhost:3000' : window.location.origin;
    
    var todayStr = new Date().toISOString().split('T')[0];
    var dismissed = localStorage.getItem('calendar-popup-dismissed');
    
    if (dismissed === todayStr) return;

    fetch(apiBase + '/api/calendar/today')
        .then(function(res) { return res.json(); })
        .then(function(events) {
            if (!events || events.length === 0) return;
            showPopup(events);
        })
        .catch(function(err) {
            console.error('Error loading today events:', err);
        });

    function showPopup(events) {
        var popup = document.createElement('div');
        popup.id = 'calendarPopup';
        popup.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;max-width:380px;width:calc(100% - 40px);pointer-events:none;';
        
        var card = document.createElement('div');
        card.style.cssText = 'background:var(--card);border:2px solid var(--accent-strong);border-radius:16px;padding:1.5rem;box-shadow:0 12px 40px rgba(0,0,0,0.5);animation:slideInRight 0.4s ease;position:relative;pointer-events:auto;';
        
        var closeBtn = document.createElement('button');
        closeBtn.innerHTML = '×';
        closeBtn.style.cssText = 'position:absolute;top:5px;right:10px;background:transparent;border:none;font-size:1.8rem;color:var(--muted);cursor:pointer;padding:0;width:30px;height:30px;line-height:1;z-index:10;';
        closeBtn.onclick = dismissPopup;
        
        var title = document.createElement('h3');
        title.textContent = '📅 На този ден';
        title.style.cssText = 'margin:0 0 1rem 0;color:var(--fg);font-size:1.2rem;';
        
        var content = document.createElement('div');
        
        events.forEach(function(event) {
            var eventDiv = document.createElement('a');
            eventDiv.href = 'address.html?slug=' + encodeURIComponent(event.slug);
            eventDiv.style.cssText = 'display:block;padding:0.75rem;background:rgba(205,133,63,0.1);border-radius:10px;margin-bottom:0.75rem;text-decoration:none;color:var(--fg);transition:all 0.3s;';
            
            // Взимаме ГОТОВИТЕ години от сървъра (същата променлива като в големия календар)
            var years = event.years_ago; 
            var icon = event.type === 'birth' ? '🎂' : '🕯️';
            var action = event.type === 'birth' ? 'е роден' : 'е починал';
            var yearsText = (years === 1) ? 'година' : 'години';
            
            eventDiv.innerHTML = 
                '<div style="font-weight:700;margin-bottom:0.2rem;">' + icon + ' ' + event.name + '</div>' +
                '<div style="font-size:0.85rem;color:var(--muted);">Преди ' + years + ' ' + yearsText + ' ' + action + '</div>';
            
            content.appendChild(eventDiv);
        });
        
        var footer = document.createElement('a');
        footer.href = 'calendar.html';
        footer.textContent = '→ Към пълния календар';
        footer.style.cssText = 'display:inline-block;margin-top:0.5rem;color:var(--accent-soft);text-decoration:none;font-weight:600;font-size:0.9rem;';
        
        card.appendChild(closeBtn);
        card.appendChild(title);
        card.appendChild(content);
        card.appendChild(footer);
        popup.appendChild(card);
        
        var style = document.createElement('style');
        style.textContent = `
            @keyframes slideInRight { from { opacity: 0; transform: translateX(50px); } to { opacity: 1; transform: translateX(0); } }
            @keyframes slideOutRight { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(50px); } }
            @media (max-width: 480px) {
                #calendarPopup { top: auto !important; bottom: 20px !important; right: 10px !important; left: 10px !important; width: auto !important; }
            }
        `;
        document.head.appendChild(style);
        document.body.appendChild(popup);
    }
    
    function dismissPopup() {
        var popup = document.getElementById('calendarPopup');
        if (popup) {
            popup.style.animation = 'slideOutRight 0.3s ease forwards';
            setTimeout(function() { popup.remove(); }, 300);
        }
        localStorage.setItem('calendar-popup-dismissed', todayStr);
    }
})();
