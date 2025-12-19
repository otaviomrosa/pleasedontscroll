// js/script.js

document.addEventListener('DOMContentLoaded', () => {
    const menuToggle = document.querySelector('.menu-toggle');
    const mobileOverlay = document.querySelector('.mobile-menu-overlay');
    const logoImage = document.querySelector('.logo-img');
    const body = document.body;

    if (menuToggle && mobileOverlay) {
        menuToggle.addEventListener('click', () => {
            // 1. Toggle Active Classes
            menuToggle.classList.toggle('is-active');
            mobileOverlay.classList.toggle('is-active');
            
            // 2. Lock Scroll when menu is open
            body.classList.toggle('no-scroll');

            // 3. Optional: Invert Logo color to white if overlay is dark
            if (mobileOverlay.classList.contains('is-active')) {
                logoImage.style.filter = "brightness(100)"; // Make logo white
            } else {
                logoImage.style.filter = "brightness(0)"; // Back to black
            }
        });

        // Close menu when a link is clicked
        const mobileLinks = document.querySelectorAll('.mobile-link');
        mobileLinks.forEach(link => {
            link.addEventListener('click', () => {
                menuToggle.classList.remove('is-active');
                mobileOverlay.classList.remove('is-active');
                body.classList.remove('no-scroll');
                logoImage.style.filter = "brightness(0)";
            });
        });
    }

    // ===== Nav blur on scroll (progressive to 1 * viewport height) =====
    const nav = document.querySelector('nav');
    if (nav) {
        // set CSS var for nav height so content doesn't jump
        function setNavHeight() {
            const h = nav.offsetHeight + 'px';
            document.documentElement.style.setProperty('--nav-height', h);
            // also ensure the hero has a top padding equal to nav height
            const hero = document.querySelector('.hero');
            if (hero) hero.style.paddingTop = h;
        }

        setNavHeight();
        window.addEventListener('resize', setNavHeight);

        // Scroll -> blur computation
        let ticking = false;
        const MAX_BLUR = 12; // px at full viewport scroll
        const MAX_ALPHA = 0.14; // background alpha at full viewport scroll

        function onScroll() {
            if (!ticking) {
                window.requestAnimationFrame(() => {
                    const scroll = window.scrollY || window.pageYOffset || 0;
                    const viewport = Math.max(window.innerHeight, 1);
                    const t = Math.min(1, scroll / viewport);

                    const blur = (t * MAX_BLUR).toFixed(2);
                    const alpha = (t * MAX_ALPHA).toFixed(3);

                    const blurValue = `blur(${blur}px)`;
                    nav.style.webkitBackdropFilter = blurValue;
                    nav.style.backdropFilter = blurValue;
                    nav.style.backgroundColor = `rgba(255,255,255, ${alpha})`;

                    // subtle compacting as we scroll a full viewport (optional)
                    nav.style.transform = `translateY(${t * 0}px)`;

                    ticking = false;
                });
                ticking = true;
            }
        }

        // initialize (in case page is loaded scrolled)
        onScroll();
        window.addEventListener('scroll', onScroll, { passive: true });
    }
});