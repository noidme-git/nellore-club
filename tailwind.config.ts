import type { Config } from 'tailwindcss';

// DESIGN.md §5, implemented verbatim.
//
// Every colour resolves to a CSS custom property declared in app/globals.css, so
// the light theme is a re-declaration of those variables under
// [data-theme="light"] and NOT a second set of utilities. That is the whole
// reason there is not a single `dark:` variant in the codebase: one copy of
// every utility keeps the site-wide CSS inside the 14 KB gz budget of
// DESIGN.md §9, and a theme swap is a single attribute write with no repaint of
// the stylesheet.
const config: Config = {
  // ARCHITECTURE.md §3. `lib/` is scanned because lib/format and lib/content
  // return class names for status pills and category glyphs; `content/` because
  // games.json and club.json are authoring sources that may name a utility.
  // Missing a glob here does not error — it silently ships a page with no
  // styles, which is why the list is deliberately wider than "just app/".
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    './content/**/*.json',
  ],

  // The product switches theme by writing document.documentElement.dataset.theme
  // from localStorage first and prefers-color-scheme only as a fallback
  // (DESIGN.md §2.1), so the media-query strategy would disagree with the user's
  // explicit choice. `dark:` must never appear in a class list (DESIGN.md §12
  // rule 12 makes it a build failure); this setting exists so that if one ever
  // slips through it keys off the attribute that is actually authoritative
  // instead of silently inverting on a phone set to light mode.
  darkMode: ['selector', '[data-theme="dark"]'],

  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: { DEFAULT: 'var(--surface)', 2: 'var(--surface-2)', 3: 'var(--surface-3)' },
        line: { DEFAULT: 'var(--line)', strong: 'var(--line-strong)' },
        fg: { DEFAULT: 'var(--fg)', muted: 'var(--fg-muted)', faint: 'var(--fg-faint)' },
        brand: {
          DEFAULT: 'var(--brand)',
          bright: 'var(--brand-bright)',
          fill: 'var(--brand-fill)',
          tint: 'var(--brand-tint)',
        },
        'on-brand': 'var(--on-brand)',
        info: { DEFAULT: 'var(--info)', tint: 'var(--info-tint)' },
        ok: { DEFAULT: 'var(--ok)', tint: 'var(--ok-tint)' },
        live: { DEFAULT: 'var(--live)', tint: 'var(--live-tint)' },
        focus: 'var(--focus)',
      },
      fontFamily: {
        sans: [
          'Inter',
          'Noto Sans Telugu',
          'Inter Fallback',
          'Nirmala UI',
          'Gautami',
          'Telugu Sangam MN',
          'system-ui',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Roboto Mono', 'DejaVu Sans Mono', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '0.875rem', letterSpacing: '0.06em', fontWeight: '700' }],
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.875rem', { lineHeight: '1.25rem' }],
        base: ['1rem', { lineHeight: '1.5rem' }],
        lg: ['1.125rem', { lineHeight: '1.625rem', letterSpacing: '-0.005em' }],
        xl: ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em' }],
        '2xl': ['1.5rem', { lineHeight: '1.875rem', letterSpacing: '-0.015em' }],
        '3xl': ['clamp(1.75rem, 6vw, 2.125rem)', { lineHeight: '1.15', letterSpacing: '-0.02em' }],
        display: ['clamp(2.125rem, 9vw, 3.5rem)', { lineHeight: '1.05', letterSpacing: '-0.03em' }],
        score: ['clamp(1.75rem, 8vw, 2.5rem)', { lineHeight: '1', letterSpacing: '-0.02em' }],
        code: ['1.25rem', { lineHeight: '1.5rem', letterSpacing: '0.14em' }],
      },
      borderRadius: { sm: '6px', md: '10px', lg: '14px', xl: '20px' },
      boxShadow: { 1: 'var(--shadow-1)', 2: 'var(--shadow-2)', 3: 'var(--shadow-3)' },
      spacing: {
        'safe-b': 'env(safe-area-inset-bottom)',
        header: '56px',
        'header-lg': '64px',
        bottombar: 'calc(56px + env(safe-area-inset-bottom))',
        touch: '44px',
      },
      minHeight: { touch: '44px' },
      minWidth: { touch: '44px' },
      maxWidth: { app: '1120px', prose: '68ch', sheet: '560px' },
      transitionDuration: { 1: '120ms', 2: '200ms', 3: '280ms', 4: '420ms' },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.16,1,0.30,1)',
        'in-out': 'cubic-bezier(0.40,0,0.20,1)',
        spring: 'cubic-bezier(0.34,1.40,0.64,1)',
      },
      keyframes: {
        'nc-pulse': { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
        'nc-shimmer': {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        'nc-flash': {
          '0%': { backgroundColor: 'var(--brand-tint)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'nc-sheet-in': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        'nc-advance': {
          from: { opacity: '0', transform: 'scale(.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'nc-pulse': 'nc-pulse 2s ease-in-out infinite',
        'nc-shimmer': 'nc-shimmer 1.5s linear infinite',
        'nc-flash': 'nc-flash 420ms cubic-bezier(0.16,1,0.30,1) 1',
        'nc-sheet-in': 'nc-sheet-in 280ms cubic-bezier(0.40,0,0.20,1)',
        'nc-advance': 'nc-advance 420ms cubic-bezier(0.34,1.40,0.64,1) 1',
      },
    },
  },

  // DESIGN.md §7 rejects every icon package and §4.4 rejects every animation
  // library; there is nothing left for a plugin to do, and each one is bytes.
  plugins: [],
};

export default config;
