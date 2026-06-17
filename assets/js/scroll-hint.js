/* Horizontal scroll hint: for tab strips / rows that overflow sideways on small
   screens (e.g. the category tabs on map & addresses), show a small gold arrow at
   the right edge that nudges the user to scroll and scrolls on tap. The arrow only
   appears while there is more content to the right and hides at the end.
   Targets: .addr-segmented, .map-seg, and any element with [data-scroll-hint]. */
(function () {
    var SELECTOR = '.addr-segmented, .map-seg, [data-scroll-hint]';
    var CHEVRON =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<polyline points="9 18 15 12 9 6"/></svg>';

    function attach(el) {
        if (el.__scrollHint) return;
        el.__scrollHint = true;

        // Decorative affordance: the tabs themselves remain directly reachable by
        // keyboard/AT, so hide the arrow from assistive tech to keep the tablist clean.
        var arrow = document.createElement('span');
        arrow.className = 'sh-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.innerHTML = CHEVRON;
        arrow.addEventListener('click', function (e) {
            e.preventDefault();
            el.scrollBy({ left: Math.round(el.clientWidth * 0.6), behavior: 'smooth' });
        });
        el.appendChild(arrow);

        function update() {
            // -2px tolerance for sub-pixel rounding so the arrow reliably hides at the end.
            var more = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
            el.classList.toggle('sh-on', more);
        }

        el.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        if (window.ResizeObserver) { try { new ResizeObserver(update).observe(el); } catch (e) {} }
        // Run after layout settles (fonts, async content).
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
