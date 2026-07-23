(() => {
  const MOBILE_BREAKPOINT = 920;
  const STYLE_ID = 'sm-mobile-nav-styles';

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .sm-mobile-nav-toggle,
      .sm-mobile-nav-backdrop {
        display: none;
      }

      @media (max-width: ${MOBILE_BREAKPOINT}px) {
        .topbar.sm-nav-enhanced {
          position: sticky;
          top: max(8px, env(safe-area-inset-top));
          z-index: 1002;
          display: grid !important;
          grid-template-columns: minmax(0, 1fr) 48px;
          align-items: center !important;
          flex-direction: initial !important;
          gap: 12px !important;
          width: 100%;
          padding: 12px 14px !important;
          border-radius: 22px !important;
        }

        .topbar.sm-nav-enhanced .brand-chip {
          min-width: 0;
          max-width: 100%;
        }

        .topbar.sm-nav-enhanced .brand-chip > strong,
        .topbar.sm-nav-enhanced .brand-chip > span:last-child {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .sm-mobile-nav-toggle {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-direction: column;
          gap: 5px;
          width: 48px;
          height: 48px;
          padding: 0;
          border: 1px solid rgba(93, 177, 63, .34);
          border-radius: 15px;
          background: rgba(93, 177, 63, .1);
          color: #1a2530;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
        }

        .sm-mobile-nav-toggle span {
          display: block;
          width: 22px;
          height: 3px;
          border-radius: 999px;
          background: currentColor;
          transition: transform .2s ease, opacity .2s ease;
          transform-origin: center;
        }

        .topbar.sm-nav-enhanced.sm-nav-open .sm-mobile-nav-toggle span:nth-child(1) {
          transform: translateY(8px) rotate(45deg);
        }

        .topbar.sm-nav-enhanced.sm-nav-open .sm-mobile-nav-toggle span:nth-child(2) {
          opacity: 0;
        }

        .topbar.sm-nav-enhanced.sm-nav-open .sm-mobile-nav-toggle span:nth-child(3) {
          transform: translateY(-8px) rotate(-45deg);
        }

        .topbar.sm-nav-enhanced .topnav {
          position: fixed !important;
          top: var(--sm-mobile-nav-top, 82px) !important;
          left: 12px !important;
          right: 12px !important;
          z-index: 1003;
          display: grid !important;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px !important;
          max-height: calc(100dvh - var(--sm-mobile-nav-top, 82px) - 16px);
          margin: 0 !important;
          padding: 14px !important;
          overflow-y: auto;
          overscroll-behavior: contain;
          border: 1px solid rgba(229, 231, 235, .96);
          border-radius: 24px;
          background: rgba(255, 255, 255, .98);
          box-shadow: 0 24px 70px rgba(15, 23, 32, .24);
          backdrop-filter: blur(18px);
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transform: translateY(-10px) scale(.985);
          transform-origin: top center;
          transition: opacity .18s ease, transform .18s ease, visibility .18s ease;
        }

        .topbar.sm-nav-enhanced.sm-nav-open .topnav {
          opacity: 1;
          visibility: visible;
          pointer-events: auto;
          transform: translateY(0) scale(1);
        }

        .topbar.sm-nav-enhanced .topnav a {
          display: inline-flex !important;
          align-items: center;
          justify-content: center;
          width: 100%;
          min-height: 48px;
          height: auto !important;
          padding: 10px 12px !important;
          text-align: center;
          line-height: 1.2;
        }

        .sm-mobile-nav-backdrop {
          position: fixed;
          inset: 0;
          z-index: 1000;
          display: block;
          border: 0;
          background: rgba(15, 23, 32, .34);
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transition: opacity .18s ease, visibility .18s ease;
          backdrop-filter: blur(2px);
        }

        .sm-mobile-nav-backdrop.is-visible {
          opacity: 1;
          visibility: visible;
          pointer-events: auto;
        }

        body.sm-mobile-nav-lock {
          overflow: hidden;
          touch-action: none;
        }
      }

      @media (max-width: 480px) {
        .topbar.sm-nav-enhanced {
          grid-template-columns: minmax(0, 1fr) 46px;
          padding: 10px 12px !important;
        }

        .sm-mobile-nav-toggle {
          width: 46px;
          height: 46px;
        }

        .topbar.sm-nav-enhanced .topnav {
          grid-template-columns: 1fr;
          left: 10px !important;
          right: 10px !important;
          padding: 12px !important;
          border-radius: 22px;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .sm-mobile-nav-toggle span,
        .topbar.sm-nav-enhanced .topnav,
        .sm-mobile-nav-backdrop {
          transition: none !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  const navBars = [...document.querySelectorAll('.topbar')].filter((bar) => bar.querySelector('.topnav'));

  navBars.forEach((topbar, index) => {
    if (topbar.classList.contains('sm-nav-enhanced')) return;

    const nav = topbar.querySelector('.topnav');
    const navId = nav.id || `sm-mobile-nav-${index + 1}`;
    nav.id = navId;
    topbar.classList.add('sm-nav-enhanced');

    const toggle = document.createElement('button');
    toggle.className = 'sm-mobile-nav-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', navId);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open navigation');
    toggle.innerHTML = '<span></span><span></span><span></span>';

    const backdrop = document.createElement('button');
    backdrop.className = 'sm-mobile-nav-backdrop';
    backdrop.type = 'button';
    backdrop.tabIndex = -1;
    backdrop.setAttribute('aria-label', 'Close navigation');

    topbar.appendChild(toggle);
    document.body.appendChild(backdrop);

    const updateMenuPosition = () => {
      const rect = topbar.getBoundingClientRect();
      const top = Math.max(10, Math.round(rect.bottom + 8));
      nav.style.setProperty('--sm-mobile-nav-top', `${top}px`);
    };

    const closeMenu = ({ restoreFocus = false } = {}) => {
      topbar.classList.remove('sm-nav-open');
      backdrop.classList.remove('is-visible');
      document.body.classList.remove('sm-mobile-nav-lock');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation');
      if (restoreFocus) toggle.focus();
    };

    const openMenu = () => {
      updateMenuPosition();
      topbar.classList.add('sm-nav-open');
      backdrop.classList.add('is-visible');
      document.body.classList.add('sm-mobile-nav-lock');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Close navigation');
    };

    toggle.addEventListener('click', () => {
      if (topbar.classList.contains('sm-nav-open')) {
        closeMenu();
      } else {
        openMenu();
      }
    });

    backdrop.addEventListener('click', () => closeMenu({ restoreFocus: true }));
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) closeMenu();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && topbar.classList.contains('sm-nav-open')) {
        closeMenu({ restoreFocus: true });
      }
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > MOBILE_BREAKPOINT) {
        closeMenu();
      } else if (topbar.classList.contains('sm-nav-open')) {
        updateMenuPosition();
      }
    }, { passive: true });

    window.addEventListener('scroll', () => {
      if (topbar.classList.contains('sm-nav-open')) updateMenuPosition();
    }, { passive: true });
  });
})();
