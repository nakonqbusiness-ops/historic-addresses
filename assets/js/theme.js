(function() {
	var STORAGE_KEY = 'theme-preference';
	var themes = ['light', 'dark'];
	var icons = {
		light: '🌞',
		dark: '🌙'
	};

	function getStoredTheme() {
		try { 
			var stored = localStorage.getItem(STORAGE_KEY);
			// Migrate old 'system' theme to 'dark'
			if (stored === 'system') {
				localStorage.setItem(STORAGE_KEY, 'dark');
				return 'dark';
			}
			return stored || 'dark'; 
		} catch (e) { return 'dark'; }
	}

	function applyTheme(theme) {
		// Ensure theme is only light or dark
		if (theme !== 'light' && theme !== 'dark') {
			theme = 'dark';
		}
		var root = document.documentElement;
		root.setAttribute('data-theme', theme);
		var label = theme.charAt(0).toUpperCase() + theme.slice(1) + ' Mode';
		var btn = document.getElementById('theme-toggle');
		if (btn) {
			// Create switch with icons
			btn.innerHTML = '<span class="theme-icon sun" aria-hidden="true">' + icons.light + '</span>' +
				'<span class="theme-icon moon" aria-hidden="true">' + icons.dark + '</span>';
			btn.setAttribute('title', 'Switch theme (current: ' + label + ')');
			btn.setAttribute('aria-label', 'Toggle color theme, currently ' + label);
			btn.setAttribute('aria-pressed', theme === 'dark');
			btn.dataset.mode = theme;
		}
		var ev = new CustomEvent('data-theme-change', { detail: { theme: theme } });
		root.dispatchEvent(ev);
	}

	function nextTheme(current) {
		// Only cycle between light and dark
		return current === 'light' ? 'dark' : 'light';
	}

	var current = getStoredTheme();
	applyTheme(current);

	window.addEventListener('DOMContentLoaded', function() {
		var btn = document.getElementById('theme-toggle');
		if (!btn) return;
		btn.addEventListener('click', function() {
			current = nextTheme(current);
			try { localStorage.setItem(STORAGE_KEY, current); } catch (e) {}
			applyTheme(current);
		});
	});

	// Disable hidden shortcuts on admin page; ignore typing in inputs
	var onAdminPage = /(^|\/)admin\.html(\?|#|$)/.test(location.pathname + location.search + location.hash);
	function isFormTarget(t){
		if (!t) return false;
		var tag = (t.tagName||'').toLowerCase();
		return t.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
	}

	if (!onAdminPage) {
		// Secret shortcuts to open Admin (multiple options for reliability)
		window.addEventListener('keydown', function(e){
			if (isFormTarget(e.target)) return;
			// Option 1: Ctrl+Shift+A (or Cmd+Shift+A)
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
				e.preventDefault();
				location.href = 'admin.html';
				return;
			}
		});

		// Option 2: type the word "admin" outside inputs
		(function(){
			var buffer = '';
			var timer = null;
			window.addEventListener('keypress', function(e){
				if (!e.key || e.ctrlKey || e.metaKey || e.altKey) return;
				if (isFormTarget(e.target)) return;
				buffer += String(e.key).toLowerCase();
				if (timer) clearTimeout(timer);
				timer = setTimeout(function(){ buffer = ''; }, 1500);
				if (buffer.endsWith('admin')) {
					location.href = 'admin.html';
					buffer = '';
				}
			});
		})();

		// Option 3: click the site logo 5 times quickly
		(function(){
			var logo = document.querySelector('.logo');
			if (!logo) return;
			var clicks = 0;
			var t = null;
			logo.addEventListener('click', function(){
				clicks++;
				if (t) clearTimeout(t);
				t = setTimeout(function(){ clicks = 0; }, 1200);
				if (clicks >= 5) { location.href = 'admin.html'; }
			});
		})();

		// Option 4: long-press the site logo (1.5s)
		(function(){
			var logo = document.querySelector('.logo');
			if (!logo) return;
			var pressTimer = null;
			function start(e){
				if (isFormTarget(e.target)) return;
				clear();
				pressTimer = setTimeout(function(){ location.href = 'admin.html'; }, 1500);
			}
			function clear(){ if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }
			logo.addEventListener('mousedown', start);
			logo.addEventListener('touchstart', start, { passive: true });
			['mouseup','mouseleave','touchend','touchcancel'].forEach(function(ev){
				logo.addEventListener(ev, clear);
			});
		})();

		// Option 5: URL hash (#admin)
		if (location.hash === '#admin') {
			location.replace('admin.html');
		}
	}
})();

