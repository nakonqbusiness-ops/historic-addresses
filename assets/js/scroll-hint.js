/* Horizontal scroll hint: for tab strips that overflow sideways on small screens
   (the category tabs on map & addresses), overlay a small gold chevron on the strip's
   right edge so users know to scroll/tap to reach the rest (e.g. „Събития“). The arrow
   only appears on TOUCH devices (CSS-gated) and only while there is more to the right;
   tapping it scrolls. It is positioned as an overlay OUTSIDE the scroll clip, so it is
   never cut off. Targets: .addr-segmented, .map-seg, any [data-scroll-hint]. */
(function () {
    var SELECTOR = '.addr-segmented, .map-seg, [data-scroll-hint]';
    var CHEVRON =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<polyline points="9 18 15 12 9 6"/></svg>';

    function attach(el) {
        if (el.__scrollHint) return;
        el.__scrollHint = true;

        var parent = el.parentElement;
        if (!parent) return;
        // Give the parent a positioning context so the overlay can anchor to it.
        if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

        var arrow = document.createElement('span');
        arrow.className = 'sh-arrow';
        arrow.setAttribute('aria-hidden', 'true');   // tabs themselves stay reachable by AT
        arrow.innerHTML = CHEVRON;
        arrow.addEventListener('click', function (e) {
            e.preventDefault();
            el.scrollBy({ left: Math.round(el.clientWidth * 0.6), behavior: 'smooth' });
        });
        parent.appendChild(arrow);

        function update() {
            var more = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
            if (!more) { arrow.classList.remove('show'); return; }
            // getBoundingClientRect handles transforms (the map pill is translateX-centred).
            var er = el.getBoundingClientRect();
            var pr = parent.getBoundingClientRect();
            arrow.style.left = (er.right - pr.left - 16) + 'px';
            arrow.style.top  = (er.top - pr.top + er.height / 2) + 'px';
            arrow.classList.add('show');
        }

        el.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        if (window.ResizeObserver) { try { new ResizeObserver(update).observe(el); } catch (e) {} }
        update();
        setTimeout(update, 80);
        setTimeout(update, 400);
    }

    function init() {
        Array.prototype.forEach.call(document.querySelectorAll(SELECTOR), attach);
    }

    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
})();
