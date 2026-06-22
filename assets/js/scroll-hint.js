/* Horizontal scroll hint: for tab strips that overflow sideways on small screens
   (the category tabs on map & addresses), overlay a small gold chevron at the strip's
   edge so users know there is more to swipe. Shows a RIGHT chevron while there is more
   to the right and a LEFT chevron once scrolled in; tapping it scrolls that way and the
   opposite chevron then appears. The arrows are overlays anchored to the strip's live
   bounding box (so they track transforms like the centred map pill) and are guarded so
   they never paint at a stale/zero position. Touch devices only (CSS-gated).
   Targets: .addr-segmented, .map-seg, any [data-scroll-hint]. */
(function () {
    var SELECTOR = '.addr-segmented, .map-seg, [data-scroll-hint]';
    var CHEVRON_R =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';
    var CHEVRON_L =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>';

    function attach(el) {
        if (el.__scrollHint) return;
        el.__scrollHint = true;

        var parent = el.parentElement;
        if (!parent) return;
        if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

        function makeArrow(side, svg) {
            var a = document.createElement('span');
            a.className = 'sh-arrow sh-' + side;
            a.setAttribute('aria-hidden', 'true');
            a.innerHTML = svg;
            a.addEventListener('click', function (e) {
                e.preventDefault();
                var dx = Math.round(el.clientWidth * 0.7) * (side === 'left' ? -1 : 1);
                el.scrollBy({ left: dx, behavior: 'smooth' });
            });
            parent.appendChild(a);
            return a;
        }
        var aRight = makeArrow('right', CHEVRON_R);
        var aLeft  = makeArrow('left',  CHEVRON_L);

        var raf = 0;
        function schedule() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; update(); }); }

        function place(arrow, x, top, pr) {
            arrow.style.left = (x - pr.left) + 'px';
            arrow.style.top  = (top - pr.top) + 'px';
        }
        function update() {
            var er = el.getBoundingClientRect();
            // Guard: if the strip isn't laid out yet (zero box / detached), hide rather
            // than position at a stale spot. This is what kept it "floating" before.
            if (er.width < 8 || er.height < 8) { aRight.classList.remove('show'); aLeft.classList.remove('show'); return; }
            var pr = parent.getBoundingClientRect();
            var mid = er.top + er.height / 2;
            var more = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;   // more to the right
            var back = el.scrollLeft > 2;                                     // can scroll left

            if (more) { place(aRight, er.right - 16, mid, pr); aRight.classList.add('show'); }
            else aRight.classList.remove('show');

            if (back) { place(aLeft, er.left + 16, mid, pr); aLeft.classList.add('show'); }
            else aLeft.classList.remove('show');
        }

        el.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        window.addEventListener('scroll', schedule, { passive: true });   // vertical page scroll moves the box
        if (window.ResizeObserver) {
            try {
                var ro = new ResizeObserver(schedule);
                ro.observe(el);
                ro.observe(parent);
            } catch (e) {}
        }
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
