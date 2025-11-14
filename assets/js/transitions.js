(function() {
	// Track if we're navigating via browser back/forward
	var isPopState = false;
	
	// Handle browser back/forward button
	window.addEventListener('pageshow', function(event) {
		// Remove any stuck exit animations when page is shown from cache
		if (event.persisted || (window.performance && window.performance.navigation.type === 2)) {
			document.body.classList.remove('page-exiting');
		}
	});
	
	// Detect popstate (back/forward navigation)
	window.addEventListener('popstate', function() {
		isPopState = true;
		document.body.classList.remove('page-exiting');
	});
	
	// Page exit animation on link clicks
	document.addEventListener('DOMContentLoaded', function() {
		var links = document.querySelectorAll('a[href]:not([href^="#"]):not([href^="javascript:"]):not([href^="mailto:"]):not([href^="tel:"])');
		links.forEach(function(link) {
			link.addEventListener('click', function(e) {
				// Skip animation if navigating via browser back/forward
				if (isPopState) {
					isPopState = false;
					return;
				}
				
				var href = link.getAttribute('href');
				if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
				if (href.startsWith('http') && !href.includes(window.location.hostname) && !href.includes('localhost')) return;
				
				// Don't animate if clicking the same page
				if (href === window.location.pathname || href === window.location.href.split('#')[0]) return;
				
				e.preventDefault();
				document.body.classList.add('page-exiting');
				setTimeout(function() {
					window.location.href = href;
				}, 300);
			});
		});
	});

	// Entrance animations for elements
	window.addEventListener('DOMContentLoaded', function() {
		// Animate header
		var header = document.querySelector('.site-header');
		if (header) {
			header.classList.add('slide-in-left');
		}

		// Animate hero section
		var hero = document.querySelector('.hero');
		if (hero) {
			hero.classList.add('scale-in');
		}

		// Animate cards with stagger
		var cards = document.querySelectorAll('.card, .thumb');
		cards.forEach(function(card, idx) {
			card.classList.add('slide-up');
			card.style.animationDelay = (idx * 0.1) + 's';
		});

		// Animate page title
		var pageTitle = document.querySelector('.page-title');
		if (pageTitle) {
			pageTitle.classList.add('slide-up');
		}

		// Animate toolbar
		var toolbar = document.querySelector('.toolbar');
		if (toolbar) {
			toolbar.classList.add('fade-in');
		}

		// Animate grid items
		var gridItems = document.querySelectorAll('.grid > *');
		gridItems.forEach(function(item, idx) {
			item.classList.add('slide-up');
			item.style.animationDelay = (idx * 0.08) + 's';
		});

		// Animate detail content
		var detail = document.querySelector('.detail');
		if (detail) {
			detail.classList.add('fade-in');
		}
	});
})();

