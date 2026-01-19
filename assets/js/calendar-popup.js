// assets/js/calendar-popup.js
(function() {
    var apiBase = window.location.protocol === 'file:' ? 'http://localhost:3000' : window.location.origin;
    
    // Проверка дали поп-ъпът е бил затворен днес
    var todayStr = new Date().toISOString().split('T')[0];
    var dismissed = localStorage.getItem('calendar-popup-dismissed');
    
    if (dismissed === todayStr) {
        return; // Вече е затворен за днес
    }
    
    // Зареждане на днешните събития
    fetch(apiBase + '/api/calendar/today')
        .then(function(res) { return res.json(); })
        .then(function(events) {
            if (!events || events.length === 0) return; 
            showPopup(events);
        })
        .catch(function(err) {
            console.error('Error loading calendar events:', err);
        });
    
    function showPopup(events) {
        var currentYear = new Date().getFullYear();

        // Основен контейнер на поп-ъпа
        var popup = document.createElement('div');
        popup.id = 'calendarPopup';
        // Добавяме адаптивност чрез стиловете
        popup.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;max-width:380px;width:calc(100% - 40px);';
        
        var card = document.createElement('div');
        card.style.cssText = 'background:var(--card);border:2px solid var(--accent-strong);border-radius:16px;padding:1.5rem;box-shadow:0 12px 40px rgba(0,0,0,0.5);animation:slideInRight 0.4s ease;position:relative;';
        
        // Бутон за затваряне
        var closeBtn = document.createElement('button');
        closeBtn.innerHTML = '×';
        closeBtn.style.cssText = 'position:absolute;top:5px;right:10px;background:transparent;border:none;font-size:1.8rem;color:var(--muted);cursor:pointer;padding:0;width:30px;height:30px;line-height:1;transition:color 0.2s;z-index:10;';
        closeBtn.onclick = function() {
            dismissPopup();
        };
        
        var title = document.createElement('h3');
        title.textContent = '📅 На този ден';
        title.style.cssText = 'margin:0 0 1rem 0;color:var(--fg);font-size:1.2rem;padding-right:30px;';
        
        var content = document.createElement('div');
        
        events.forEach(function(event) {
            var eventDiv = document.createElement('a');
            eventDiv.href = 'address.html?slug=' + encodeURIComponent(event.slug);
            eventDiv.style.cssText = 'display:block;padding:0.75rem;background:rgba(205,133,63,0.1);border-radius:10px;margin-bottom:0.75rem;text-decoration:none;color:var(--fg);transition:all 0.3s;border:1px solid transparent;';
            
            eventDiv.onmouseover = function() { 
                this.style.background = 'rgba(205,133,63,0.2)';
                this.style.borderColor = 'var(--accent-soft)';
            };
            eventDiv.onmouseout = function() { 
                this.style.background = 'rgba(205,133,63,0.1)';
                this.style.borderColor = 'transparent';
            };
            
            // Логика за годините (защита от undefined)
            var eventYear = 0;
            if (event.full_date) {
                eventYear = parseInt(event.full_date.split('-')[0]);
            } else if (event.year) {
                eventYear = parseInt(event.year);
            }

            var years = (eventYear > 0) ? (currentYear - eventYear) : (event.years_ago || 0);
            var icon = event.type === 'birth' ? '🎂' : '🕯️';
            var action = event.type === 'birth' ? 'е роден' : 'е починал';
            
            // Граматика за български
            var yearsText = (years % 10 === 1 && years % 100 !== 11) ? 'година' : 'години';
            
            eventDiv.innerHTML = 
                '<div style="font-weight:700;margin-bottom:0.2rem;">' + icon + ' ' + event.name + '</div>' +
                '<div style="font-size:0.85rem;color:var(--muted);">Преди ' + years + ' ' + yearsText + ' ' + action + '</div>';
            
            content.appendChild(eventDiv);
        });
        
        var calendarLink = document.createElement('a');
        calendarLink.href = 'calendar.html';
        calendarLink.textContent = '→ Към пълния календар';
        calendarLink.style.cssText = 'display:inline-block;margin-top:0.5rem;color:var(--accent-soft);text-decoration:none;font-weight:600;font-size:0.9rem;';
        
        card.appendChild(closeBtn);
        card.appendChild(title);
        card.appendChild(content);
        card.appendChild(calendarLink);
        popup.appendChild(card);
        
        // Добавяме анимациите в head
        var style = document.createElement('style');
        style.textContent = `
            @keyframes slideInRight {
                from { opacity: 0; transform: translateX(50px); }
                to { opacity: 1; transform: translateX(0); }
            }
            @keyframes slideOutRight {
                from { opacity: 1; transform: translateX(0); }
                to { opacity: 0; transform: translateX(50px); }
            }
            @media (max-width: 480px) {
                #calendarPopup { top: auto !important; bottom: 20px !important; right: 10px !important; left: 10px !important; width: calc(100% - 20px) !important; max-width: none !important; }
            }
        `;
        document.head.appendChild(style);
        
        document.body.appendChild(popup);
    }
    
    function dismissPopup() {
        var popup = document.getElementById('calendarPopup');
        if (popup) {
            popup.style.animation = 'slideOutRight 0.3s ease forwards';
            setTimeout(function() {
                popup.remove();
            }, 300);
        }
        
        // Записваме, че е затворен днес
        var todayStr = new Date().toISOString().split('T')[0];
        localStorage.setItem('calendar-popup-dismissed', todayStr);
    }
})();
