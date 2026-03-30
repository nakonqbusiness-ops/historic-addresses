// prom-invite.js
// To show: add <script src="assets/js/prom-invite.js"></script> anywhere in the page
// To remove: delete that one line. Nothing else to touch.
(function () {

    var style = document.createElement('style');
    style.textContent = `
        @keyframes promFadeIn {
            from { opacity: 0; }
            to   { opacity: 1; }
        }
        @keyframes promSlideUp {
            from { opacity: 0; transform: translateY(40px) scale(0.96); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes promGlow {
            0%,100% { text-shadow: 0 0 20px rgba(224,201,138,0.4), 0 0 40px rgba(205,133,63,0.2); }
            50%      { text-shadow: 0 0 40px rgba(224,201,138,0.8), 0 0 80px rgba(205,133,63,0.5); }
        }
        @keyframes promFloat {
            0%,100% { transform: translateY(0px) rotate(0deg); }
            33%     { transform: translateY(-12px) rotate(2deg); }
            66%     { transform: translateY(-6px) rotate(-1deg); }
        }
        @keyframes promPulse {
            0%,100% { opacity: 0.6; transform: scale(1); }
            50%      { opacity: 1; transform: scale(1.05); }
        }
        @keyframes confettiFall {
            0%   { transform: translateY(-10px) rotate(0deg); opacity: 1; }
            100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
        }
        @keyframes promDismiss {
            to { opacity: 0; transform: scale(1.03); }
        }

        #promInvite {
            position: fixed;
            inset: 0;
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1.5rem;
            background: rgba(0,0,0,0.96);
            animation: promFadeIn 0.8s ease both;
            cursor: pointer;
        }

        #promInvite .prom-confetti-wrap {
            position: absolute;
            inset: 0;
            overflow: hidden;
            pointer-events: none;
        }

        #promInvite .prom-confetti-piece {
            position: absolute;
            top: -20px;
            width: 8px; height: 8px;
            border-radius: 2px;
            animation: confettiFall linear infinite;
        }

        #promInvite .prom-card {
            position: relative;
            max-width: 560px;
            width: 100%;
            text-align: center;
            animation: promSlideUp 0.9s 0.2s cubic-bezier(0.22,1,0.36,1) both;
            pointer-events: none;
        }

        #promInvite .prom-emoji {
            font-size: clamp(3rem, 8vw, 5rem);
            display: block;
            margin-bottom: 1.5rem;
            animation: promFloat 4s ease-in-out infinite;
            line-height: 1;
        }

        #promInvite .prom-pre {
            font-family: "Baskerville","Garamond",Georgia,serif;
            font-size: clamp(0.85rem, 2vw, 1rem);
            letter-spacing: 0.25em;
            text-transform: uppercase;
            color: #cd853f;
            margin: 0 0 1rem;
            animation: promPulse 3s ease-in-out infinite;
        }

        #promInvite .prom-name {
            font-family: "Baskerville","Garamond",Georgia,serif;
            font-size: clamp(2.4rem, 7vw, 4.2rem);
            font-weight: 400;
            color: #e0c98a;
            margin: 0 0 0.5rem;
            line-height: 1.1;
            animation: promGlow 3s ease-in-out infinite;
        }

        #promInvite .prom-divider {
            width: 60px; height: 1px;
            background: linear-gradient(90deg, transparent, #cd853f, transparent);
            margin: 1.25rem auto;
        }

        #promInvite .prom-message {
            font-family: "Baskerville","Garamond",Georgia,serif;
            font-size: clamp(1.5rem, 4vw, 2.4rem);
            font-weight: 400;
            color: #fff;
            margin: 0 0 0.5rem;
            line-height: 1.35;
        }

        #promInvite .prom-class {
            font-family: "Mulish","Segoe UI",sans-serif;
            font-size: clamp(0.9rem, 2.5vw, 1.1rem);
            font-weight: 700;
            letter-spacing: 0.15em;
            text-transform: uppercase;
            color: #cd853f;
            margin: 1.5rem 0 0;
        }

        #promInvite .prom-hint {
            position: fixed;
            bottom: 2rem;
            left: 50%;
            transform: translateX(-50%);
            font-family: "Mulish","Segoe UI",sans-serif;
            font-size: 0.75rem;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: rgba(255,255,255,0.25);
            animation: promPulse 2.5s ease-in-out infinite;
            white-space: nowrap;
        }

        #promInvite.dismissing {
            animation: promDismiss 0.5s ease forwards;
        }
    `;
    document.head.appendChild(style);

    // ── Confetti pieces ──────────────────────────────────────
    var colors = ['#cd853f','#daa520','#e0c98a','#fff','#f5e6c8','#b8860b'];

    function makeConfetti(count) {
        var wrap = document.createElement('div');
        wrap.className = 'prom-confetti-wrap';
        for (var i = 0; i < count; i++) {
            var p = document.createElement('div');
            p.className = 'prom-confetti-piece';
            p.style.cssText = [
                'left:' + Math.random() * 100 + '%',
                'background:' + colors[Math.floor(Math.random() * colors.length)],
                'width:' + (4 + Math.random() * 8) + 'px',
                'height:' + (4 + Math.random() * 8) + 'px',
                'border-radius:' + (Math.random() > 0.5 ? '50%' : '2px'),
                'animation-duration:' + (3 + Math.random() * 5) + 's',
                'animation-delay:' + (Math.random() * 6) + 's',
                'opacity:' + (0.5 + Math.random() * 0.5)
            ].join(';');
            wrap.appendChild(p);
        }
        return wrap;
    }

    // ── Build overlay ────────────────────────────────────────
    var overlay = document.createElement('div');
    overlay.id = 'promInvite';

    overlay.appendChild(makeConfetti(40));

    var card = document.createElement('div');
    card.className = 'prom-card';
    card.innerHTML =
        '<span class="prom-emoji">🎓</span>' +
        '<p class="prom-pre">Покана за абитуриентски бал</p>' +
        '<h1 class="prom-name">Госпожо Григорова,</h1>' +
        '<div class="prom-divider"></div>' +
        '<p class="prom-message">чакаме Ви навън!</p>' +
        '<p class="prom-class">12 клас &nbsp;·&nbsp; Випуск 2026</p>';

    var hint = document.createElement('div');
    hint.className = 'prom-hint';
    hint.textContent = '✦ Докоснете, за да продължите ✦';

    overlay.appendChild(card);
    overlay.appendChild(hint);

    // dismiss on click anywhere
    overlay.addEventListener('click', function () {
        overlay.classList.add('dismissing');
        setTimeout(function () { overlay.remove(); }, 480);
    });

    // wait for body, then show
    function mount() { document.body.appendChild(overlay); }
    if (document.body) { mount(); }
    else { document.addEventListener('DOMContentLoaded', mount); }

})();
