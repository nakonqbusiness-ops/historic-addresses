// calendar-popup.js - Add this file to assets/js/
(function() {
    var apiBase = window.location.protocol === 'file:' ? 'http://localhost:3000' : window.location.origin;
    
    // Check if popup was already dismissed today
    var today = new Date().toISOString().split('T')[0];
    var dismissed = localStorage.getItem('calendar-popup-dismissed');
    
    if (dismissed === today) {
        return; // Already dismissed today
    }
    
    // Fetch today's events
    fetch(apiBase + '/api/calendar/today')
        .then(function(res) { return res.json(); })
        .then(function(events) {
            if (events.length === 0) return; // No events today
            
            showPopup(events);
        })
        .catch(function(err) {
            console.error('Error loading calendar events:', err);
        });
    
    function showPopup(events) {
        // Create popup HTML
        var popup = document.createElement('div');
        popup.id = 'calendarPopup';
        popup.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;max-width:400px;width:90%;';
        
        var card = document.createElement('div');
        card.style.cssText = 'background:var(--card);border:2px solid var(--accent-strong);border-radius:16px;padding:1.5rem;box-shadow:0 12px 40px rgba(0,0,0,0.5);animation:slideInRight 0.4s ease;position:relative;';
        
        var closeBtn = document.createElement('button');
        closeBtn.innerHTML = '×';
        closeBtn.style.cssText = 'position:absolute;top:10px;right:10px;background:transparent;border:none;font-size:1.8rem;color:var(--muted);cursor:pointer;padding:0;width:30px;height:30px;line-height:1;transition:color 0.2s;';
        closeBtn.onmouseover = function() { this.style.color = 'var(--accent-strong)'; };
        closeBtn.onmouseout = function() { this.style.color = 'var(--muted)'; };
        closeBtn.onclick = function() {
            dismissPopup();
        };
        
        var title = document.createElement('h3');
        title.textContent = '📅 На този ден';
        title.style.cssText = 'margin:0 0 1rem 0;color:var(--fg);font-size:1.3rem;padding-right:30px;';
        
        var content = document.createElement('div');
        
        events.forEach(function(event) {
            var eventDiv = document.createElement('a');
            eventDiv.href = 'address.html?slug=' + encodeURIComponent(event.slug);
            eventDiv.style.cssText = 'display:block;padding:0.75rem;background:rgba(205,133,63,0.1);border-radius:10px;margin-bottom:0.75rem;text-decoration:none;color:var(--fg);transition:all 0.3s;';
            eventDiv.onmouseover = function() { 
                this.style.background = 'rgba(205,133,63,0.2)';
                this.style.transform = 'translateX(5px)';
            };
            eventDiv.onmouseout = function() { 
                this.style.background = 'rgba(205,133,63,0.1)';
                this.style.transform = 'translateX(0)';
            };
            
            var icon = event.type === 'birth' ? '🎂' : '🕯️';
            var action = event.type === 'birth' ? 'е роден' : 'е починал';
            var years = event.years_ago;
            var yearsText = years === 1 ? 'година' : 'години';
            
            eventDiv.innerHTML = '<div style="font-weight:700;margin-bottom:0.25rem;">' + icon + ' ' + event.name + '</div>' +
                '<div style="font-size:0.9rem;color:var(--muted);">Преди ' + years + ' ' + yearsText + ' ' + action + '</div>';
            
            content.appendChild(eventDiv);
        });
        
        var calendarLink = document.createElement('a');
        calendarLink.href = 'calendar.html';
        calendarLink.textContent = '→ Виж пълния календар';
        calendarLink.style.cssText = 'display:inline-block;margin-top:0.5rem;color:var(--accent-soft);text-decoration:none;font-weight:600;font-size:0.9rem;transition:color 0.2s;';
        calendarLink.onmouseover = function() { this.style.color = 'var(--accent-strong)'; };
        calendarLink.onmouseout = function() { this.style.color = 'var(--accent-soft)'; };
        
        card.appendChild(closeBtn);
        card.appendChild(title);
        card.appendChild(content);
        card.appendChild(calendarLink);
        popup.appendChild(card);
        
        // Add animation keyframes
        var style = document.createElement('style');
        style.textContent = '@keyframes slideInRight{from{opacity:0;transform:translateX(100px);}to{opacity:1;transform:translateX(0);}}';
        document.head.appendChild(style);
        
        document.body.appendChild(popup);
    }
    
    function dismissPopup() {
        var popup = document.getElementById('calendarPopup');
        if (popup) {
            popup.style.animation = 'slideOutRight 0.3s ease';
            setTimeout(function() {
                popup.remove();
            }, 300);
        }
        
        // Save dismissal for today
        var today = new Date().toISOString().split('T')[0];
        localStorage.setItem('calendar-popup-dismissed', today);
    }
    
    // Add slideOut animation
    var style = document.createElement('style');
    style.textContent = '@keyframes slideOutRight{to{opacity:0;transform:translateX(100px);}}';
    document.head.appendChild(style);
})();
