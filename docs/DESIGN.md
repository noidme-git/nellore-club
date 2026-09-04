# nellore.club — Visual Design System

**Status:** design spec, authoritative. Implement literally.
**Stack it must fit:** Tailwind CSS **3.4.17** (config-based, `extend`), PostCSS + Autoprefixer,
Next 15 static export, no runtime CSS-in-JS, no component library, no animation library.
**Sibling spec:** `docs/IA.md` (routes, flows, states, accessibility behaviour).

Every colour pair proposed below has a **computed WCAG 2.x contrast ratio stated next to it**. No
pair appears in this document that has not been calculated. Ratios were computed with the standard
sRGB relative-luminance formula.

---

## 1. Brand direction

### 1.1 The problem, stated honestly

One product must be credible to two audiences that despise each other's aesthetics:

- **A 19-year-old BGMI player.** Expects dark mode, hard contrast, big numbers, speed, and something
  that looks like it belongs next to Valorant and Free Fire. Reads soft pastels and rounded friendly
  UI as "for kids" and light-mode-only as "government website".
- **A 45-year-old chess or carrom player.** Expects legibility, dignity, and a club that looks like
  it will actually hold the ₹5,000 prize money and hand it over. Reads neon glow, angular slashes,
  glitch type and RGB gradients as "not for me — this is a video game website" and closes the tab.

Most platforms pick one and lose the other. Splitting the brand by category (a "gaming" skin and a
"classic" skin) is worse: it fragments the club, doubles the CSS, and tells the carrom player they
are the B-tier product.

### 1.2 The resolution: **Floodlight**

> **The direction is the scoreboard, not the skin.**

The one artifact every single game on this platform produces — BGMI, chess, carrom, cricket, kabaddi,
scrabble, volleyball — is **a number next to a name**. A scoreboard is universally legible, it is
already the visual language of both a stadium and a chess clock, and it belongs to nobody's
subculture. It is the only aesthetic that both audiences already accept as *theirs*.

So the brand is a **floodlit night scoreboard**: an almost-black field, a single warm amber light
source, enormous tabular numerals, and everything else quiet.

**Where the energy comes from** (for the 19-year-old): density of real data, huge score numerals,
hard-edged 1px structure, a live pulsing indicator, and one saturated amber that reads as heat.
**Where the credibility comes from** (for the 45-year-old): typographic discipline, generous line
height, no decoration that isn't information, real ₹ figures with real timestamps, and an
uncompromising light mode for people who read in daylight and hate dark UIs.

**Three rules that keep it on the rails:**

1. **No gamer clichés.** No angular parallelogram clipping, no glow/`box-shadow` bloom, no gradient
   text, no glitch, no monospace-as-a-personality, no "esports" italic display face.
2. **No club-house clichés.** No felt green, no wood grain, no serif-and-gold-laurel, no trophy
   photography, no ornamental borders.
3. **Amber is a light source, not a decoration.** It appears where the user's attention is supposed
   to go — the primary action, the winner, the live round, the prize money — and nowhere else. A page
   with amber in six places has a bug.

**Voice.** Short, factual, present tense, no hype. `32 teams · ₹10,000 prize pool · Registration
closes in 6h 12m`. Never "Epic showdown!!". The club earns excitement by having real numbers, not by
claiming excitement.

**Naming and marks:**

- **Wordmark:** `nellore` set in Inter 800 at `-0.04em` tracking, all lowercase, followed by `.club`
  in amber at the same weight. Shipped as **outlined SVG paths** (≈1.2 KB), not as text, so the
  header logo never depends on a webfont having loaded and never shifts.
- **Mark — "the Fork":** two strokes converging into one inside a 24×24 grid. It is literally a
  bracket junction: two entrants in, one winner out. It is game-agnostic by construction, it works at
  16 px, and it is a single `<path>` (~180 bytes).

  ```
  ┌──────────────┐
  │  ╲           │      path: M6 6 h4 a4 4 0 0 1 4 4 v4
  │   ╲____      │            M6 18 h4 a4 4 0 0 0 4-4
  │        ╲___  │            M14 12 h4
  │   ____/      │      stroke: currentColor, 2px, round caps/joins
  │  ╱           │
  └──────────────┘
  ```

- **Favicon / app icon:** the Fork in `--ink-950` on an amber `#FFC043` rounded square. SVG favicon +
  32 px ICO fallback + 180/192/512 PNGs for install (§9.4).

**Rejected directions:**

| Rejected | Why |
| --- | --- |
| Neon cyber-esports (violet/magenta on black, glow, angular clips) | Wins the 19-year-old, loses the carrom and chess players outright, and glow effects (`box-shadow` blur, backdrop filters) are the most expensive thing you can put on a mid-range Android GPU. |
| Warm "community club" (cream, forest green, serif, gold laurel) | Wins the 45-year-old, and the esports audience will not register for a BGMI scrim on a site that looks like a temple trust notice board. |
| Two skins, switched by game category | Doubles the CSS and the QA surface, and it institutionalises the split instead of solving it. The club is one club. |
| Indian-festive maximalism (marigold, kumkum red, rangoli patterns) | Genuinely appealing and locally resonant, but it is loud behind dense tabular data, it does not scale to a 63-node bracket, and it reads as seasonal — the site has to look right in March as well as at Diwali. The one thing kept from it is the warm amber, which is the honest overlap between a stadium floodlight, a trophy, and a marigold. |
| Copying `sandhyachess.club`'s royal-violet candy UI | It is the owner's other, adjacent property, and reusing it would make nellore.club look like a sub-site of the chess club rather than the umbrella the club actually is. Deliberate differentiation. |

---

## 2. Colour

### 2.1 Architecture

Every colour is a CSS custom property on `:root`, re-declared under `[data-theme="light"]`. Tailwind
names resolve to those variables (`colors: { brand: 'var(--brand)' }`), so **every class recipe in
this document is theme-agnostic** — there is not a single `dark:` variant in the codebase.

Theme resolution, in order: (1) `localStorage['nc:v1:theme']` if set to `dark`/`light`;
(2) `prefers-color-scheme`; (3) default `dark`. A 1-line blocking inline script in `<head>` sets
`document.documentElement.dataset.theme` before first paint to avoid a flash. `<meta name="color-
scheme" content="dark light">` is set so form controls and scrollbars follow.

**How that script is emitted, because there is exactly one legal way.** It lives in
`app/layout.tsx` and it is the **only** `dangerouslySetInnerHTML` in the codebase
(`ARCHITECTURE.md` §4 rule 5, which is written to allowlist this one occurrence by hash). In React
19 that is not a stylistic choice: `<script>{'…'}</script>` runs the string through React's text
escaper, so `&&`, `<` and quotes come out HTML-escaped and the script is syntactically broken. The
alternatives both fail visibly on first load — `public/theme.js` costs a render-blocking round trip
(~400 ms RTT on Slow 4G) on every cold view, and dropping it gives every dark-mode user a white
flash on every navigation.

Constraints on the snippet, all mechanically checked:

- it is a **compile-time string literal with no interpolation** — the build fails if it contains
  `${`;
- `scripts/csp-hashes.mjs` asserts its `sha256` appears in **every** page's hash list in
  `worker/csp-hashes.json`; a page missing it is a build failure, not a runtime flash;
- CI greps for `dangerouslySetInnerHTML` and fails on any occurrence other than this one.

```js
// the whole snippet; keep it one statement and keep it small — it blocks paint
try{var t=localStorage.getItem('nc:v1:theme');if(t!=='dark'&&t!=='light'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}
```

**Dark is the default.** The audience skews toward gaming, the site is used at night at venues, and
OLED phones are common. Light mode is not an afterthought: it is fully specified below and is what a
45-year-old reading a rules page in daylight will get if their phone says so.

### 2.2 Dark theme (default)

| Token | Hex | Role |
| --- | --- | --- |
| `--bg` | `#0B0F14` | page ground |
| `--surface` | `#131A23` | card, sheet, header |
| `--surface-2` | `#1C2634` | nested card, table header, input, tab strip |
| `--surface-3` | `#243040` | hover / pressed / selected row |
| `--line` | `#2C3846` | decorative hairline (dividers, card borders) |
| `--line-strong` | `#6B7A8C` | **structural** border: inputs, match nodes, checkbox — must be perceivable |
| `--fg` | `#F2F6FA` | primary text |
| `--fg-muted` | `#A9B7C6` | secondary text, labels |
| `--fg-faint` | `#8C9BAD` | tertiary text, timestamps, meta |
| `--brand` | `#FFC043` | amber: primary action, winner, live round, prize, focus accent |
| `--brand-bright` | `#FFD98A` | hover / active brand text |
| `--brand-tint` | `#2B2110` | amber pill background |
| `--on-brand` | `#0B0F14` | text on an amber fill |
| `--info` | `#5CC8F5` | links, scheduled state, informational |
| `--info-tint` | `#0C2734` | info pill background |
| `--ok` | `#3DD68C` | registration open, success, confirmed |
| `--ok-tint` | `#0F2A20` | success pill background |
| `--live` | `#FF6B6B` | live match, destructive action, error |
| `--live-tint` | `#2E1414` | live/error pill background |
| `--focus` | `#5CC8F5` | focus ring (cyan, so it stays visible on the amber button) |

**Verified contrast ratios (dark):**

| Foreground | Background | Ratio | Verdict |
| --- | --- | --- | --- |
| `--fg` `#F2F6FA` | `--bg` `#0B0F14` | **17.70** | AAA |
| `--fg` | `--surface` `#131A23` | **16.12** | AAA |
| `--fg` | `--surface-2` `#1C2634` | **14.05** | AAA |
| `--fg` | `--surface-3` `#243040` | **12.30** | AAA |
| `--fg-muted` `#A9B7C6` | `--bg` | **9.40** | AAA |
| `--fg-muted` | `--surface` | **8.57** | AAA |
| `--fg-muted` | `--surface-2` | **7.47** | AAA |
| `--fg-muted` | `--surface-3` | **6.54** | AAA |
| `--fg-faint` `#8C9BAD` | `--bg` | **6.78** | AAA |
| `--fg-faint` | `--surface` | **6.17** | AAA |
| `--fg-faint` | `--surface-2` | **5.38** | AA |
| `--fg-faint` | `--surface-3` | **4.71** | AA |
| `--brand` `#FFC043` | `--bg` | **11.78** | AAA |
| `--brand` | `--surface` | **10.73** | AAA |
| `--brand` | `--surface-2` | **9.35** | AAA |
| `--brand` | `--surface-3` | **8.19** | AAA |
| `--brand` | `--brand-tint` `#2B2110` | **9.70** | AAA |
| `--brand-bright` `#FFD98A` | `--bg` | **14.23** | AAA |
| `--on-brand` `#0B0F14` | `--brand` fill | **11.78** | AAA |
| `--info` `#5CC8F5` | `--bg` | **10.10** | AAA |
| `--info` | `--surface` | **9.20** | AAA |
| `--info` | `--surface-2` | **8.02** | AAA |
| `--info` | `--info-tint` `#0C2734` | **8.14** | AAA |
| `--on-brand` on `--info` fill | — | **10.10** | AAA |
| `--ok` `#3DD68C` | `--bg` | **10.25** | AAA |
| `--ok` | `--surface` | **9.33** | AAA |
| `--ok` | `--ok-tint` `#0F2A20` | **8.16** | AAA |
| `--live` `#FF6B6B` | `--bg` | **6.93** | AAA |
| `--live` | `--surface` | **6.31** | AAA |
| `--live` | `--surface-2` | **5.50** | AA |
| `--live` | `--live-tint` `#2E1414` | **6.17** | AAA |
| `--on-brand` on `--live` fill | — | **6.93** | AAA |
| `--line-strong` `#6B7A8C` | `--bg` | **4.38** | passes 1.4.11 (≥3) |
| `--line-strong` | `--surface` | **3.99** | passes 1.4.11 |
| `--line-strong` | `--surface-2` | **3.48** | passes 1.4.11 |
| `--line-strong` | `--surface-3` | **3.05** | passes 1.4.11 |
| `--focus` `#5CC8F5` | `--bg` | **10.10** | passes 1.4.11 |

**Hard rules from the numbers above:**

- `--fg-faint` is **not** permitted on `--surface-3` for text below 16 px… it measures 4.71 which
  passes AA for all sizes, so it *is* permitted — but it is the tightest pair in the system. Do not
  darken any surface or lighten any faint token without re-running the check.
- `--line` (`#2C3846`, 1.61 on `--bg`) is **decorative only**. Any border that communicates the
  boundary of an interactive control — input, checkbox, radio, match node, segmented-control
  divider — must use `--line-strong`.
- **Never place `--brand`, `--ok`, `--info` or `--live` as a *fill* under white text.** They are
  bright colours; text on them is always `--on-brand` (`#0B0F14`).

### 2.3 The one collision, and how it is managed

Amber is conventionally "warning". Here amber is the **brand**. Rather than pretend that is fine,
the system removes the collision by construction:

> **There is no amber status.** The status ramp is green (open) / cyan (scheduled) / red (live,
> error, destructive) / slate (draft, completed, cancelled, queued). Amber never appears in a status
> pill, ever.

Where a genuine warning is needed ("this will reset 3 matches", "you have unsaved changes",
"registration closes in 40 minutes"), the system uses the **`--live` red family plus an explicit
warning glyph and sentence**, or a plain neutral banner for the merely informational. Countdown
urgency is expressed by a **ticking number**, not by a colour change.

This costs one convention and buys an unambiguous meaning for amber: **amber means "you", "your
action", or "winning"**. Primary button, active tab, winner bar, champion badge, prize figure. That
consistency is what makes the interface scannable at a glance on a phone in a noisy hall.

### 2.4 Light theme

| Token | Hex | Role |
| --- | --- | --- |
| `--bg` | `#FFFFFF` | |
| `--surface` | `#F5F8FB` | |
| `--surface-2` | `#E9EFF5` | |
| `--surface-3` | `#DCE5EE` | |
| `--line` | `#DDE4EC` | decorative |
| `--line-strong` | `#6F7F92` | structural |
| `--fg` | `#0B0F14` | |
| `--fg-muted` | `#46566A` | |
| `--fg-faint` | `#516275` | |
| `--brand` | `#7A4E00` | **brand as text/icon** (bronze) |
| `--brand-bright` | `#5C3B00` | hover state for brand text |
| `--brand-fill` | `#FFC043` | brand as a *fill* (buttons, winner bar, active underline) |
| `--brand-tint` | `#FFF0D4` | amber pill background |
| `--on-brand` | `#0B0F14` | text on `--brand-fill` |
| `--info` | `#0A5E85` | |
| `--info-tint` | `#DDF0FA` | |
| `--ok` | `#0E6B45` | |
| `--ok-tint` | `#DFF5EA` | |
| `--live` | `#B3261E` | |
| `--live-tint` | `#FDE7E5` | |
| `--focus` | `#0A5E85` | |

**Verified contrast ratios (light):**

| Foreground | Background | Ratio | Verdict |
| --- | --- | --- | --- |
| `--fg` `#0B0F14` | `#FFFFFF` | **19.22** | AAA |
| `--fg` | `--surface` `#F5F8FB` | **18.03** | AAA |
| `--fg` | `--surface-2` `#E9EFF5` | **16.59** | AAA |
| `--fg` | `--surface-3` `#DCE5EE` | **15.09** | AAA |
| `--fg-muted` `#46566A` | `#FFFFFF` | **7.50** | AAA |
| `--fg-muted` | `--surface-2` | **6.48** | AAA |
| `--fg-muted` | `--surface-3` | **5.89** | AA |
| `--fg-faint` `#516275` | `#FFFFFF` | **6.26** | AAA |
| `--fg-faint` | `--surface` | **5.87** | AAA |
| `--fg-faint` | `--surface-2` | **5.41** | AA |
| `--fg-faint` | `--surface-3` | **4.92** | AA |
| `--brand` `#7A4E00` | `#FFFFFF` | **7.20** | AAA |
| `--brand` | `--surface` | **6.75** | AAA |
| `--brand` | `--surface-3` | **5.65** | AA |
| `--brand` | `--brand-tint` `#FFF0D4` | **6.40** | AAA |
| `--on-brand` `#0B0F14` | `--brand-fill` `#FFC043` | **11.78** | AAA |
| `--info` `#0A5E85` | `#FFFFFF` | **7.11** | AAA |
| `--info` | `--info-tint` `#DDF0FA` | **6.07** | AAA |
| white on `--info` fill | — | **7.11** | AAA |
| `--ok` `#0E6B45` | `#FFFFFF` | **6.55** | AAA |
| `--ok` | `--ok-tint` `#DFF5EA` | **5.73** | AA |
| white on `--ok` fill | — | **6.55** | AAA |
| `--live` `#B3261E` | `#FFFFFF` | **6.54** | AAA |
| `--live` | `--live-tint` `#FDE7E5` | **5.52** | AA |
| white on `--live` fill | — | **6.54** | AAA |
| `--line-strong` `#6F7F92` | `#FFFFFF` | **4.10** | passes 1.4.11 |
| `--line-strong` | `--surface` | **3.84** | passes 1.4.11 |
| `--line-strong` | `--surface-2` | **3.54** | passes 1.4.11 |
| `--line-strong` | `--surface-3` | **3.22** | passes 1.4.11 |
| `--focus` `#0A5E85` | `#FFFFFF` | **7.11** | passes 1.4.11 |
| `--focus` | `--surface-3` | **5.58** | passes 1.4.11 |

**The light-mode amber rule:** `#FFC043` on white is **1.61:1** and is *never* used as text or as an
icon in light mode. `--brand` in light mode is the bronze `#7A4E00`; `--brand-fill` is the amber and
only ever carries `--on-brand` text on top. Components reference `--brand` for ink and `--brand-fill`
for fills, and in **dark mode `--brand-fill: var(--brand)`** so one recipe serves both themes.

### 2.5 Full ramps (for the Tailwind config)

Provided so a designer can reach for an in-between step without inventing one. Only the semantic
tokens above should appear in component recipes; these exist for charts, tints and one-off surfaces.

```
ink   50 #F2F6FA  100 #DFE7EF  200 #C2CEDC  300 #A9B7C6  400 #8C9BAD  500 #6B7A8C
      600 #4E5D6E  700 #364454  800 #243040  850 #1C2634  900 #131A23  950 #0B0F14
amber 50 #FFF6E3  100 #FFE9B8  200 #FFD98A  300 #FFC043  400 #F0A81E  500 #C98A12
      600 #A06D0C  700 #7A4E00  800 #5C3B00  900 #3B2500
sky   50 #E6F6FE  100 #C3EAFC  200 #94DBFA  300 #5CC8F5  400 #2FAEE0  500 #1B8CBB
      600 #0A5E85  700 #08496A  800 #06364E  900 #0C2734
mint  50 #E4FAF0  100 #BDF2DC  200 #86E7BE  300 #3DD68C  400 #1FB973  500 #149660
      600 #0E6B45  700 #0A5233  800 #073B25  900 #0F2A20
rose  50 #FEECEA  100 #FDD3CF  200 #FFA9A6  300 #FF6B6B  400 #ED4B4B  500 #D02F2F
      600 #B3261E  700 #8A1D17  800 #64150F  900 #2E1414
```

---

## 3. Typography

### 3.1 Font choices

| Role | Family | Delivery | Bytes |
| --- | --- | --- | --- |
| **Everything Latin** (UI, body, headings, numerals) | **Inter Variable** (`wght 100–900`) | Self-hosted `woff2`, **subset** to `U+0000-00FF, U+2013-2014, U+2018-201D, U+2022, U+2026, U+2192, U+20B9, U+2713, U+25CF` | **≈ 24 KB** |
| **Telugu** | **Noto Sans Telugu** (weights 400 + 700, or the variable file) | Self-hosted `woff2`, `unicode-range: U+0C00-0C7F, U+200C-200D` | ≈ 46 KB, **downloaded only if a Telugu glyph is actually rendered** |
| **Monospace** (room codes, recovery codes, UTR, join codes) | **System stack** — `ui-monospace, SFMono-Regular, "Roboto Mono", "DejaVu Sans Mono", monospace` | none | **0 KB** |

**Why one Latin family and not a display face.** A second family costs 20–40 KB and one more
render-blocking decision on a 400 kbps connection. Inter Variable spans 100–900 in a single file, so
the "display" voice is produced typographically — weight 800, tracking `-0.03em`, tight leading —
at zero additional bytes. The one place a distinctive letterform matters (the wordmark) is shipped as
**SVG outlines**, so it is pixel-identical before the font loads and costs 1.2 KB once.

**Why Inter specifically.** It has true tabular figures (`tnum`), a slashed zero (`zero`), a
disambiguated `1/l/I`, and it renders acceptably at 12 px on low-DPI Android. Scores, ₹ amounts, seed
numbers, room codes and points tables are the entire product; a font without `tnum` would make every
number column jitter as scores update.

**Why Noto Sans Telugu.** It is the only freely licensed Telugu face with full conjunct coverage and
a matching x-height to Inter, and the club's audience will see Telugu tournament names and, later,
Telugu UI. `Gautami`, `Nirmala UI` and `Telugu Sangam MN` are named as fallbacks so the pre-download
paint is still correct Telugu, not tofu.

### 3.2 Loading strategy

```css
/* 1. Inter — the only font we preload. */
@font-face {
  font-family: 'Inter';
  src: url('/fonts/inter-var-subset.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0000-00FF, U+2013-2014, U+2018-201D, U+2022, U+2026,
                 U+2192, U+20B9, U+2713, U+25CF;
}

/* 2. Metric-matched fallback so `swap` causes ~zero layout shift.
      Values are the Inter-vs-Arial adjustments; do not "tidy" them. */
@font-face {
  font-family: 'Inter Fallback';
  src: local('Arial'), local('Roboto'), local('Helvetica Neue');
  ascent-override: 90.49%;
  descent-override: 22.56%;
  line-gap-override: 0%;
  size-adjust: 107.06%;
}

/* 3. Telugu — NOT preloaded. unicode-range means the browser fetches this file
      only when a codepoint in the range is actually painted, so 95% of page
      views never pay for it. */
@font-face {
  font-family: 'Noto Sans Telugu';
  src: url('/fonts/noto-telugu-var.woff2') format('woff2-variations');
  font-weight: 400 700;
  font-display: swap;
  unicode-range: U+0C00-0C7F, U+200C-200D;
}
```

```html
<link rel="preload" href="/fonts/inter-var-subset.woff2" as="font" type="font/woff2" crossorigin>
```

Font stack applied to `body`:

```
font-family: 'Inter', 'Noto Sans Telugu', 'Inter Fallback',
             'Nirmala UI', 'Gautami', 'Telugu Sangam MN',
             system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
```

Fonts are served with `Cache-Control: public, max-age=31536000, immutable` (the Worker already
matches `\.woff2?$`). **Never** load from Google Fonts: it is a third-party connection, an extra DNS
+ TLS handshake on a 400 ms-RTT link, and it forces `connect-src`/`font-src` holes in the CSP.

**Rejected:** loading a variable font at full Latin coverage (≈ 95 KB) — the subset above covers every
character the UI can produce, and organizer-entered Telugu is handled by the second face.
**Rejected:** `font-display: optional` — it would leave first-time visitors on the fallback for the
whole session, and the amber-on-dark wordmark/heading rhythm is part of the brand.

### 3.3 Type scale

Mobile-first. Base is **16 px** and body text never goes below 16 px on mobile (it also prevents iOS
input zoom). `clamp()` handles the three largest steps; everything else is fixed.

| Token | Size / line-height | Tracking | Weight | Use |
| --- | --- | --- | --- | --- |
| `text-2xs` | 11px / 14px | `+0.06em`, uppercase | 700 | badge, eyebrow, tab-bar label |
| `text-xs` | 12px / 16px | `0` | 400–600 | meta rows, timestamps, table captions |
| `text-sm` | 14px / 20px | `0` | 400–600 | secondary text, table cells, chips |
| `text-base` | 16px / 24px | `0` | 400 | body copy, inputs |
| `text-lg` | 18px / 26px | `-0.005em` | 500–600 | card titles, list primary text |
| `text-xl` | 20px / 28px | `-0.01em` | 700 | section headings |
| `text-2xl` | 24px / 30px | `-0.015em` | 700 | page heading (mobile h1) |
| `text-3xl` | `clamp(28px, 6vw, 34px)` / 1.15 | `-0.02em` | 800 | tournament title |
| `text-display` | `clamp(34px, 9vw, 56px)` / 1.05 | `-0.03em` | 800 | home hero only |
| `text-score` | `clamp(28px, 8vw, 40px)` / 1 | `-0.02em` | 800 | the scoreboard numeral |
| `text-code` | 20px / 24px | `+0.14em`, uppercase | 600, mono | room code, recovery code |

Numeric utilities (add as Tailwind plugin utilities or `@layer utilities`):

```css
.nums-tab  { font-variant-numeric: tabular-nums slashed-zero; }
.nums-prop { font-variant-numeric: proportional-nums; }
```

`.nums-tab` is **mandatory** on: every score cell, points table, leaderboard points column, seed
number, countdown, ₹ amount, and match number. Without it, a score changing from 9 to 10 shifts the
whole column and the eye loses its place.

Prose defaults: `max-width: 68ch` on rules/legal pages, `text-wrap: pretty` on `<p>`,
`text-wrap: balance` on `h1`–`h3`, `hyphens: none` (Telugu hyphenation is wrong in every engine).

---

## 4. Spacing, radii, shadows, motion

### 4.1 Spacing

4 px base; Tailwind's default scale is already this, so use it unmodified. Layout constants:

| Constant | Mobile | ≥768px | ≥1024px |
| --- | --- | --- | --- |
| Page gutter | 16px | 24px | 24px |
| Content max-width | — | 720px (prose) | 1120px (app) |
| Header height | 56px | 64px | 64px |
| Bottom bar height | `56px + env(safe-area-inset-bottom)` | — | — |
| Card padding | 16px | 20px | 20px |
| Section vertical rhythm | 32px | 48px | 64px |
| Stack gap (list items) | 8px | 12px | 12px |

Extra Tailwind spacing keys: `safe-b: env(safe-area-inset-bottom)`, `header: 56px`,
`header-lg: 64px`, `bottombar: calc(56px + env(safe-area-inset-bottom))`.

### 4.2 Radii

| Token | Value | Applied to |
| --- | --- | --- |
| `rounded-sm` | 6px | chips, badges, small inputs, skeleton bars |
| `rounded-md` | 10px | **buttons**, inputs, select, match node |
| `rounded-lg` | 14px | cards, sheets (top corners), modals |
| `rounded-xl` | 20px | hero panels, the poster frame |
| `rounded-full` | 9999px | avatars, status pills, the live dot |

Radii are moderate on purpose. Very round (20 px+) reads friendly/consumer and undercuts the
scoreboard; square (0–2 px) reads brutalist/dev-tool and undercuts approachability for the older
cohort. 10 px on a button is the middle both audiences read as "professional app".

### 4.3 Elevation

**In dark mode, shadows are nearly invisible; elevation is expressed by surface step + hairline.**
This is the rule most dark themes get wrong.

| Level | Dark | Light |
| --- | --- | --- |
| **0** page | `bg-bg` | `bg-bg` |
| **1** card | `bg-surface` + `border border-line` | `bg-bg` + `border border-line` + `shadow-1` |
| **2** raised / hover | `bg-surface-2` + `border border-line` | `bg-bg` + `shadow-2` |
| **3** sheet / modal / popover | `bg-surface` + `border border-line` + `shadow-3` | `bg-bg` + `shadow-3` |

```css
--shadow-1: 0 1px 2px rgb(11 15 20 / .06), 0 1px 1px rgb(11 15 20 / .04);   /* light */
--shadow-2: 0 4px 12px -4px rgb(11 15 20 / .10), 0 2px 4px -2px rgb(11 15 20 / .06);
--shadow-3: 0 24px 48px -16px rgb(11 15 20 / .22), 0 8px 16px -8px rgb(11 15 20 / .12);
/* dark overrides: 1 and 2 become `none`; 3 becomes a plain deep drop: */
[data-theme='dark'] { --shadow-1: none; --shadow-2: none;
                      --shadow-3: 0 24px 48px -12px rgb(0 0 0 / .70); }
```

No `backdrop-filter: blur()` anywhere. It is the single most expensive effect on mid-range Android
GPUs and it makes a sticky header stutter on scroll. Sticky surfaces are opaque.

### 4.4 Motion

```css
--dur-1: 120ms;   /* press, hover, colour change */
--dur-2: 200ms;   /* toast in/out, tab underline slide, chip swap */
--dur-3: 280ms;   /* bottom sheet, modal, route transition */
--dur-4: 420ms;   /* bracket advance flash, score change flash — fires once */
--ease-out:   cubic-bezier(0.16, 1, 0.30, 1);   /* default: enters and moves */
--ease-in-out:cubic-bezier(0.40, 0, 0.20, 1);   /* symmetric: sheet, accordion */
--ease-spring:cubic-bezier(0.34, 1.40, 0.64, 1);/* ONLY the winner-advance animation */
```

The complete motion inventory — anything not on this list should not move:

1. Button press: `active:translate-y-px` + `active:brightness-95`, `--dur-1`.
2. Tab underline: `transform: translateX()` on a shared 2 px amber bar, `--dur-2 --ease-out`.
3. Bottom sheet: `translateY(100%) → 0`, `--dur-3 --ease-in-out`; backdrop fades `0 → 0.6`.
4. Toast: slide up 8 px + fade, `--dur-2`; auto-dismiss after 5 s (8 s if it has an action).
5. Live dot pulse: `@keyframes nc-pulse { 0%,100%{opacity:1} 50%{opacity:.35} }`, `2s ease-in-out
   infinite`.
6. Score change flash: background `--brand-tint → transparent`, `--dur-4`, once.
7. Winner advance: the winner's name scales `0.96 → 1` and fades in at the destination node,
   `--dur-4 --ease-spring`, once.
8. Skeleton shimmer: `@keyframes nc-shimmer` translating a 1.5 s linear gradient. (A single
   `background-position` animation on a `linear-gradient`, not a pseudo-element sweep, so it is one
   composited layer.)

**Reduced motion.** `@media (prefers-reduced-motion: reduce)`: all `transition-duration` and
`animation-duration` → `1ms` **except** opacity-only transitions, which are clamped to 120 ms so
appearance changes are still perceivable rather than instant-popping. The live dot loses its
animation and gains a `ring-2 ring-live` static ring. Auto-scroll (`scrollIntoView`) uses `behavior:
'auto'`. Hold-to-confirm is replaced by a dialog (see `docs/IA.md` §5, Journey 4e).

**No animation library.** `framer-motion` / `motion` is 25–40 KB gz for eight effects that are all
CSS transitions. That is a quarter of the entire JS budget.

---

## 5. Tailwind configuration

`tailwind.config.ts` — the `extend` block to implement verbatim. Everything resolves to a CSS
variable so light/dark needs no `dark:` variants.

```ts
theme: {
  extend: {
    colors: {
      bg: 'var(--bg)',
      surface: { DEFAULT: 'var(--surface)', 2: 'var(--surface-2)', 3: 'var(--surface-3)' },
      line: { DEFAULT: 'var(--line)', strong: 'var(--line-strong)' },
      fg: { DEFAULT: 'var(--fg)', muted: 'var(--fg-muted)', faint: 'var(--fg-faint)' },
      brand: { DEFAULT: 'var(--brand)', bright: 'var(--brand-bright)',
               fill: 'var(--brand-fill)', tint: 'var(--brand-tint)' },
      'on-brand': 'var(--on-brand)',
      info: { DEFAULT: 'var(--info)', tint: 'var(--info-tint)' },
      ok:   { DEFAULT: 'var(--ok)',   tint: 'var(--ok-tint)' },
      live: { DEFAULT: 'var(--live)', tint: 'var(--live-tint)' },
      focus: 'var(--focus)',
    },
    fontFamily: {
      sans: ['Inter', 'Noto Sans Telugu', 'Inter Fallback', 'Nirmala UI', 'Gautami',
             'Telugu Sangam MN', 'system-ui', 'sans-serif'],
      mono: ['ui-monospace', 'SFMono-Regular', 'Roboto Mono', 'DejaVu Sans Mono', 'monospace'],
    },
    fontSize: {
      '2xs':  ['0.6875rem', { lineHeight: '0.875rem', letterSpacing: '0.06em',  fontWeight: '700' }],
      xs:     ['0.75rem',   { lineHeight: '1rem' }],
      sm:     ['0.875rem',  { lineHeight: '1.25rem' }],
      base:   ['1rem',      { lineHeight: '1.5rem' }],
      lg:     ['1.125rem',  { lineHeight: '1.625rem', letterSpacing: '-0.005em' }],
      xl:     ['1.25rem',   { lineHeight: '1.75rem',  letterSpacing: '-0.01em' }],
      '2xl':  ['1.5rem',    { lineHeight: '1.875rem', letterSpacing: '-0.015em' }],
      '3xl':  ['clamp(1.75rem, 6vw, 2.125rem)', { lineHeight: '1.15', letterSpacing: '-0.02em' }],
      display:['clamp(2.125rem, 9vw, 3.5rem)',  { lineHeight: '1.05', letterSpacing: '-0.03em' }],
      score:  ['clamp(1.75rem, 8vw, 2.5rem)',   { lineHeight: '1',    letterSpacing: '-0.02em' }],
      code:   ['1.25rem',   { lineHeight: '1.5rem', letterSpacing: '0.14em' }],
    },
    borderRadius: { sm: '6px', md: '10px', lg: '14px', xl: '20px' },
    boxShadow: { 1: 'var(--shadow-1)', 2: 'var(--shadow-2)', 3: 'var(--shadow-3)' },
    spacing: {
      'safe-b': 'env(safe-area-inset-bottom)',
      header: '56px', 'header-lg': '64px',
      bottombar: 'calc(56px + env(safe-area-inset-bottom))',
      touch: '44px',
    },
    minHeight:  { touch: '44px' },
    minWidth:   { touch: '44px' },
    maxWidth:   { app: '1120px', prose: '68ch', sheet: '560px' },
    transitionDuration: { 1: '120ms', 2: '200ms', 3: '280ms', 4: '420ms' },
    transitionTimingFunction: {
      out: 'cubic-bezier(0.16,1,0.30,1)',
      'in-out': 'cubic-bezier(0.40,0,0.20,1)',
      spring: 'cubic-bezier(0.34,1.40,0.64,1)',
    },
    keyframes: {
      'nc-pulse':    { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
      'nc-shimmer':  { '0%': { backgroundPosition: '200% 0' }, '100%': { backgroundPosition: '-200% 0' } },
      'nc-flash':    { '0%': { backgroundColor: 'var(--brand-tint)' }, '100%': { backgroundColor: 'transparent' } },
      'nc-sheet-in': { from: { transform: 'translateY(100%)' }, to: { transform: 'translateY(0)' } },
      'nc-advance':  { from: { opacity: '0', transform: 'scale(.96)' }, to: { opacity: '1', transform: 'scale(1)' } },
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
```

Two shared recipes live in `@layer components` because they repeat on nearly every control:

```css
@layer components {
  /* One focus treatment for the whole product. The 2px offset in the page colour
     guarantees the ring is legible even on the amber fill. */
  .nc-focus {
    @apply outline-none focus-visible:outline focus-visible:outline-2
           focus-visible:outline-offset-2 focus-visible:outline-focus;
  }
  /* Expands a visually small control to a 44px hit area without changing layout. */
  .nc-hit::after {
    content: ''; position: absolute; inset: 50% auto auto 50%;
    width: 44px; height: 44px; transform: translate(-50%, -50%);
  }
}
```

---

## 6. Component inventory

Class recipes are literal Tailwind 3.4 and use only the tokens above. `cx()` is `clsx`.

### 6.1 Button

Base (all variants):
`inline-flex items-center justify-center gap-2 rounded-md font-bold whitespace-nowrap
select-none transition-[transform,filter,background-color,border-color] duration-1 ease-out
active:translate-y-px disabled:opacity-40 disabled:pointer-events-none nc-focus`

| Size | Classes |
| --- | --- |
| `sm` | `h-9 min-w-touch px-3 text-sm` — only inside dense tables/toolbars, still 44px hit via `nc-hit` |
| `md` (default) | `h-11 min-w-touch px-4 text-[15px] leading-none` |
| `lg` | `h-14 px-6 text-lg` — sticky CTAs, live-scoring lock button |

| Variant | Classes | Contrast |
| --- | --- | --- |
| `primary` | `bg-brand-fill text-on-brand hover:brightness-105 active:brightness-95` | 11.78 |
| `secondary` | `bg-surface-2 text-fg border border-line-strong hover:bg-surface-3` | 14.05 / border 3.48 |
| `ghost` | `bg-transparent text-fg-muted hover:bg-surface-2 hover:text-fg` | 9.40 |
| `link` | `h-auto px-0 text-info underline underline-offset-2 hover:text-fg` | 10.10 |
| `danger` | `bg-live text-on-brand hover:brightness-105` | 6.93 |
| `danger-outline` | `bg-transparent text-live border border-live hover:bg-live-tint` | 6.93 |

States: `loading` → content is replaced by a 16 px spinner + the label stays in an `sr-only` span;
button gets `aria-busy="true"` and `disabled`. `success` → the label swaps to `✓ Saved` for 1.5 s.
Icon-only → `w-11 px-0` plus a mandatory `aria-label`.

**Hold-to-confirm variant** (`Lock result`, `Apply correction`): `lg` + `relative overflow-hidden`,
with a child `<span>` absolutely positioned that animates `width: 0 → 100%` over 1200 ms in
`bg-on-brand/15`. `aria-describedby` points at a hint: *"Press and hold for 1 second, or press Enter
to confirm in a dialog."*

### 6.2 Input / Textarea

`w-full h-11 rounded-md bg-surface-2 text-fg placeholder:text-fg-faint border border-line-strong
px-3 text-base nc-focus disabled:opacity-50 read-only:bg-surface`

- Invalid: `border-live` + `aria-invalid="true"` + `aria-describedby` → an error `<p>` with
  `text-sm text-live` and an inline warning glyph. **Never** rely on the red border alone.
- Label: `block text-sm font-semibold text-fg-muted mb-1.5` — always visible, never a placeholder.
- Hint: `mt-1 text-xs text-fg-faint`.
- Numeric fields (score, UTR, in-game ID): add `nums-tab inputmode="numeric"` and, for the score
  steppers, `text-center text-score`.
- Code fields (recovery code, room code entry): `font-mono text-code uppercase tracking-[0.14em]`,
  **paste is never intercepted**, and the field is a single input, not a per-character grid.
- Textarea: same recipe with `h-auto min-h-[96px] py-2.5 leading-6`.

### 6.3 Select

Native `<select>` only (a custom listbox is 6 KB, worse on Android, and worse with a screen reader).
`h-11 w-full rounded-md bg-surface-2 text-fg border border-line-strong pl-3 pr-9 text-base nc-focus
appearance-none bg-[url(chevron)] bg-no-repeat bg-[right_0.75rem_center] bg-[length:16px]` with the
chevron as an inline `data:` SVG whose `stroke` is baked from `--fg-muted` per theme (two tiny
declarations, one per `[data-theme]`).

### 6.4 Tabs (round strip, tournament sub-nav, profile tabs)

Container: `relative flex gap-1 overflow-x-auto scroll-smooth snap-x snap-proximity
[scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-b border-line`
Tab: `snap-start shrink-0 h-11 px-3 inline-flex items-center gap-1.5 text-sm font-semibold
text-fg-muted hover:text-fg nc-focus relative`
Active: `text-fg` + `after:absolute after:inset-x-2 after:-bottom-px after:h-0.5
after:bg-brand-fill after:rounded-full` + `aria-current="page"` + `font-bold`.
Three signals — underline, weight, `aria-current` — only one of which is colour.

### 6.5 Card

`rounded-lg bg-surface border border-line p-4 md:p-5 shadow-1`
Interactive card adds: `transition-colors duration-1 hover:bg-surface-2
focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus`
and the whole card is made clickable by a stretched link (`<a class="after:absolute after:inset-0">`)
so the tap target is the card but the accessible name is the heading.

### 6.6 Tournament card

The most-repeated composite on the site. Fixed height (168 px mobile) so lists never shift.

```
┌──────────────────────────────────────────────┐
│ [◈ BGMI]  esport               ● LIVE        │  game badge + category + status pill
│                                              │
│ BGMI Diwali Cup                              │  text-lg font-bold, 2-line clamp
│ Sat 12 Nov · 6:00 PM IST · Club Arena        │  text-sm text-fg-muted, nums-tab
│                                              │
│ ₹150 entry   ₹10,000 prize   28/32 teams     │  text-sm; ₹ figures text-brand font-bold
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░  87% full             │  capacity bar
└──────────────────────────────────────────────┘
```

`group relative flex flex-col gap-2 rounded-lg bg-surface border border-line p-4 shadow-1
transition-colors duration-1 hover:bg-surface-2`

- Capacity bar: `h-1 w-full rounded-full bg-surface-3 overflow-hidden` with an inner
  `h-full bg-brand-fill` at `style={{width: pct}}`, plus a text label (`28/32 teams`) because a bar
  alone is not accessible. `role="progressbar"` with `aria-valuenow/min/max/text`.
- When `pct >= 90`, the bar stays amber (it is not a warning) and the text label becomes
  `Only 4 slots left` in `font-bold`.
- Cancelled tournaments: the title gets `line-through text-fg-faint` and the card `opacity-70`.

### 6.7 Game badge

**Monochrome by design.** `inline-flex items-center gap-1.5 h-6 px-2 rounded-sm bg-surface-2
text-fg-muted text-2xs border border-line` with a 14 px inline SVG category glyph
(`gamepad` / `pawn` / `ball`) and the game's short name.

**Rejected: a colour per game.** Fourteen game colours would collide with the four status colours,
would be undiscoverable (nobody learns that teal means scrabble), and would fail 1.4.1 unless every
one also carried a glyph — at which point the glyph is doing all the work and the colour is noise.
The game record may carry an optional `accent` used **only** to tint the glyph, and the
implementation must assert it measures ≥ 3:1 against `--surface-2` or fall back to `--fg-muted`.

### 6.8 Status pill

`inline-flex items-center gap-1.5 h-6 pl-1.5 pr-2.5 rounded-full text-2xs font-bold` + variant. Every
pill is `glyph + UPPERCASE TEXT + colour` — see `docs/IA.md` §8.3 for the enforced mapping.

| State | Classes | Glyph |
| --- | --- | --- |
| Registration open | `bg-ok-tint text-ok` | plus-circle |
| Scheduled | `bg-info-tint text-info` | calendar |
| Live | `bg-live-tint text-live` | `<span class="w-2 h-2 rounded-full bg-live animate-nc-pulse motion-reduce:animate-none" aria-hidden>` |
| Completed | `bg-surface-2 text-fg-muted` | check |
| Cancelled | `bg-surface-2 text-fg-faint` | x |
| Payment pending | `bg-surface-2 text-fg-muted` | rupee-clock |
| Queued (offline) | `bg-surface-2 text-fg-muted` | cloud-off |

Contrast: ok/ok-tint **8.16**, info/info-tint **8.14**, live/live-tint **6.17**, fg-muted/surface-2
**7.47**, fg-faint/surface-2 **5.38** — all AA or better.

### 6.9 Bracket match node

Two renderings from one data shape.

**Rounds mode (328 px wide, ~136 px tall):**

Wrapper: `relative rounded-md bg-surface border border-line-strong overflow-hidden`
Live wrapper adds: `border-l-[3px] border-l-live`
Meta row: `flex items-center justify-between px-3 h-8 bg-surface-2 text-xs text-fg-faint nums-tab`
Entrant row: `flex items-center gap-2 h-11 px-3 border-t border-line`
  - winner: `bg-brand-tint/40 font-bold text-fg` + a 3 px left bar
    (`before:absolute before:left-0 before:w-[3px] before:h-11 before:bg-brand-fill`) + a `✓` glyph
  - loser: `text-fg-faint`
  - seed: `w-5 shrink-0 text-xs text-fg-faint nums-tab`
  - name: `flex-1 min-w-0 truncate text-[15px]`
  - score: `w-10 text-right text-xl font-extrabold nums-tab`
  - TBD row: `text-fg-faint italic` with no score cell
Footer links: `flex items-center justify-between px-3 h-8 text-xs text-info border-t border-line`

**Map mode (168 × 68 px):** same structure, `text-sm`, entrant rows `h-8`, no footer (the connector
SVG carries the lineage), and `data-focused` gets `outline outline-2 outline-focus outline-offset-2`
from the roving-tabindex grid.

Connectors: one inline `<svg class="absolute inset-0 pointer-events-none" aria-hidden="true">` of
`<path>` elements, `stroke: var(--line-strong)` at 1.5 px; the path a winner actually travelled is
`stroke: var(--brand-fill)` at 2 px.

### 6.10 Standings / points table

`w-full text-sm nums-tab border-separate border-spacing-0`
`thead th`: `sticky top-header bg-surface-2 text-2xs text-fg-muted text-left px-3 h-9
border-b border-line first:rounded-tl-lg last:rounded-tr-lg`
`tbody td`: `px-3 h-12 border-b border-line`
Rank cell: `w-8 text-fg-faint nums-tab`; ranks 1–3 get `text-brand font-extrabold`.
Points cell: `text-right font-extrabold text-lg text-fg`.
Zebra: none — use the 1 px `--line` rule instead; zebra striping halves the effective contrast of the
alternate rows and buys nothing at 12 columns.
**Qualification cut-line:** a `border-b-2 border-brand-fill` on the last qualifying row plus a full-
width caption row beneath it: `Top 4 qualify for playoffs` in `text-2xs text-brand`.
**Below 480 px** wide tables (cricket, BR points) switch to a **stacked card list**: one card per
entrant with the rank + name as the heading and the numeric columns as a 3-column definition grid.
Horizontal scroll is the fallback only for `/admin/` tables, and always with a
`overflow-x-auto` container that carries `tabindex="0"` and `role="region" aria-label` so it is
keyboard-scrollable (WCAG 2.1.1).

### 6.11 Leaderboard row

`flex items-center gap-3 h-16 px-3 rounded-md hover:bg-surface-2 nc-focus`
`#rank` `w-9 text-right text-lg font-extrabold nums-tab text-fg-faint` (top 3: `text-brand`) ·
avatar 36 px · `flex-1 min-w-0` with handle `text-[15px] font-semibold truncate` over
`text-xs text-fg-faint` display name · trend `text-xs` with glyph + signed number ·
points `text-xl font-extrabold nums-tab`.
Own row when sticky at the bottom: same recipe + `bg-surface-2 border-t border-line-strong
shadow-3` and a `You` chip.

### 6.12 Avatar

Deterministic, generated, **zero network**: a 5×5 mirrored identicon rendered as inline SVG rects
from a hash of the user/team id, on one of eight fixed background tints from the ramps in §2.5, with
the initials overlaid in `--on-brand` at `font-extrabold`. Sizes: 24 / 32 / 36 / 48 / 72 px.
`rounded-full overflow-hidden shrink-0`, `role="img"` with `aria-label="{name}"`.
Uploaded avatars are **not** in v1 (see §9.3).

### 6.13 Modal & bottom sheet

**On mobile every modal is a bottom sheet.** Sheets are reachable one-handed; centred dialogs are not.

Backdrop: `fixed inset-0 z-40 bg-[rgb(0_0_0/.6)]` (`--dur-2` opacity fade), click-to-dismiss for
non-destructive sheets only.
Sheet: `fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-lg bg-surface
border-t border-line shadow-3 pb-safe-b animate-nc-sheet-in`
Grab handle: `mx-auto mt-2 h-1 w-9 rounded-full bg-line-strong` (decorative, `aria-hidden`).
Header: `sticky top-0 bg-surface px-4 h-14 flex items-center justify-between border-b border-line`
with an `h2` and a 44 px close button.
Desktop (≥768 px): `sm:inset-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2
sm:w-full sm:max-w-sheet sm:rounded-lg sm:border`.

Behaviour: rendered in a portal; `role="dialog" aria-modal="true"` with `aria-labelledby`; focus
moves to the heading on open and is **trapped**; `Esc` closes; focus returns to the trigger;
`overflow: hidden` on `<body>` with scroll-position restoration. Sheets that own a URL
(`/t/<slug>/m/<n>/`) push history so Android back closes them.

### 6.14 Toast

Container: `fixed left-1/2 -translate-x-1/2 z-[60] w-[calc(100%-32px)] max-w-sheet
bottom-[calc(theme(spacing.bottombar)+12px)] md:bottom-6`, `role="status" aria-live="polite"`
(`role="alert"` for errors).
Toast: `flex items-start gap-3 rounded-md bg-surface-2 border border-line-strong shadow-3 p-3
text-sm text-fg`. A 3 px left border encodes kind: `border-l-ok` / `border-l-live` / `border-l-line-
strong`, always accompanied by a glyph. Max 3 stacked; auto-dismiss 5 s (8 s with an action button);
hovering or focusing pauses the timer. Toasts are **never** the only report of an error that blocks
progress — that also renders inline.

### 6.15 Skeleton

`rounded-sm bg-surface-2 animate-nc-shimmer
bg-[linear-gradient(90deg,var(--surface-2)_25%,var(--surface-3)_37%,var(--surface-2)_63%)]
bg-[length:400%_100%] motion-reduce:animate-none`
Every skeleton must be built as a component that mirrors the real component's box model exactly
(`SkeletonTournamentCard` is 168 px tall, like the real card). Skeletons render only after a 250 ms
delay and carry `aria-hidden="true"`; the loading announcement comes from one `role="status"` region
saying *"Loading tournaments"*.

### 6.16 Empty state

`flex flex-col items-center text-center gap-3 py-12 px-6`
28 px inline SVG glyph in `text-fg-faint`, an `h3 text-lg font-bold text-fg` sentence,
a `p text-sm text-fg-muted max-w-[36ch]` explanation, and **at least one primary action**. Every
empty state in the product names a next step; a dead end is a bug. Full copy per view is enumerated
in `docs/IA.md` §7.2.

### 6.17 Nav

**Top bar:** `sticky top-0 z-30 h-header md:h-header-lg bg-surface border-b border-line`
inner `mx-auto max-w-app px-4 h-full flex items-center gap-3`.
**Bottom tab bar:** `md:hidden fixed inset-x-0 bottom-0 z-30 h-bottombar pb-safe-b bg-surface
border-t border-line grid grid-cols-5`
Each tab: `flex flex-col items-center justify-center gap-0.5 min-h-touch text-2xs text-fg-faint
nc-focus`; active: `text-brand` + `aria-current="page"` + the 24 px glyph switches from stroke to
filled (shape change, not just colour). Badge dot: `absolute top-1.5 right-[calc(50%-16px)] w-2 h-2
rounded-full bg-live ring-2 ring-surface` plus an `sr-only` count.
Body gets `pb-[calc(theme(spacing.bottombar)+16px)] md:pb-0` so content clears the bar.

### 6.18 Footer

`mt-16 border-t border-line bg-surface`, inner `mx-auto max-w-app px-4 py-10 grid gap-8
sm:grid-cols-3`. Column heads `text-2xs text-fg-faint`, links `block py-2 text-sm text-fg-muted
hover:text-fg` (the `py-2` is what makes them 44 px targets). Bottom strip: theme toggle, language
toggle, and `text-xs text-fg-faint` copyright. The **Help** link is always the last item in the last
column (WCAG 2.2 §3.2.6 Consistent Help).

### 6.19 Components `IA.md` requires that §6.1–§6.18 did not name

Reconciliation pass: every screen in `docs/IA.md` was walked and each of these appeared in one and
had no recipe here. They are shared primitives, not one-offs, and they belong to the **foundation**
workstream in `docs/BUILD-PLAN.md` — not to whichever feature happens to need one first.

| Component | Used by | Recipe |
| --- | --- | --- |
| **SegmentedControl** | Bracket `Winners / Losers / Final` (IA §6.1), bracket view mode `Rounds / Follow / Map` | `inline-flex p-0.5 rounded-md bg-surface-2 border border-line` ; each segment `h-9 px-3 rounded-[7px] text-sm font-semibold text-fg-muted nc-focus`, selected → `bg-surface-3 text-fg shadow-1` + `aria-pressed="true"`. `role="group"`, **not** a tablist — the segments do not each own a panel. Hidden entirely when there is one segment. |
| **FreshnessChip** | Mandatory on every live view (IA §7.1) | `inline-flex items-center gap-1 h-8 px-2.5 rounded-full bg-surface-2 border border-line text-xs text-fg-muted nc-hit nc-focus`. Content `Updated 4 min ago` (relative under 1 h, then `Updated 6:42 PM IST`). It is a **button**: tapping forces a revalidate. Offline variant swaps the glyph to `cloud-off` and the text to `Offline · as of 7:41 PM IST`. |
| **OfflineBar** | Global, under the header (IA §7.3) | `w-full h-9 flex items-center gap-2 px-4 bg-surface-2 border-b border-line text-sm text-fg-muted` with `role="status"`. `cloud-off` glyph + text + a `Retry` link-button. Shown on the `offline` event **or** two consecutive fetch failures — `navigator.onLine` lies constantly on Android. |
| **Stepper** | Live scoring (IA §4e) | `flex items-center gap-3`; buttons `w-16 h-16 rounded-lg bg-surface-2 border border-line-strong text-2xl nc-focus active:bg-surface-3`; value `min-w-[3ch] text-center text-score nums-tab`. `aria-label` on each button names the entrant (`Increase Team Vega's score`). No long-press repeat; a `Set score…` link opens a numeric keypad sheet for cricket runs and scrabble points. |
| **Countdown** | Check-in (IA Journey 3), registration close, room-code reveal | `text-3xl nums-tab` with a `role="timer" aria-live="off"` and a visually-hidden `role="status"` that announces only at 60 s, 10 s and 0. Renders `target − (Date.now()/1000 + skew)` where `skew` comes from `X-NC-Now` (API.md §0.10). **Never** renders from the device clock alone. |
| **CodeReveal** | Room ID / password (IA Journey 3), recovery codes | `font-mono text-code tracking-[0.14em] tabular-nums` in a `rounded-lg bg-surface-2 border border-line-strong p-4`, initially `blur-sm select-none` behind a full-size tap target labelled `Tap to reveal`. Once revealed: `Copy` button, and `aria-live="assertive"` on first reveal (the one place assertive is allowed alongside a conflict error). Venues are crowded and codes get shoulder-surfed. |
| **ShareBar** | Every shareable view (IA §10) | A `Button` group: `Share` (uses `navigator.share`, falls back to clipboard + toast) and `Copy for WhatsApp` (copies pre-formatted plain text with `*bold*` markup). Both are `secondary` size `md`. The WhatsApp text is composed by a pure `lib/share.ts` helper, never inline in a component. |
| **WizardProgress** | Registration wizard, create-tournament wizard | `flex items-center gap-2` + `Step 2 of 5` in `text-xs text-fg-faint`, and a `h-1 rounded-full bg-surface-2` track with a `bg-brand-fill` fill transitioning `duration-2`. `role="progressbar"` with `aria-valuenow/min/max` and `aria-label`. |
| **QrCode** | UPI payment step only | Inline `<svg>` drawn from a ~2 KB hand-rolled QR encoder, `dynamic(() => import(...), { ssr: false })` so it never enters the public bundle (§9 rule 3). Rendered at 200 × 200 with a `bg-white p-3 rounded-lg` quiet zone — a QR on a dark surface does not scan. |
| **DataView** | Every data-backed view | Not visual: the headless wrapper that implements the five-state machine in `IA.md` §7.1 (BOOT → STALE/LOADING → READY/ERROR/OFFLINE), owns the `localStorage` cache, the 250 ms skeleton delay, the freshness chip and the shared per-slug poller. Exactly one implementation; a view that hand-rolls its own loading state is a PR rejection. |

---

## 7. Iconography

- **Hand-rolled set, inline SVG, no library, no icon font, no sprite sheet.** Each icon is a React
  component exporting a `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` with 1–3
  paths. Average ≈ 190 bytes; tree-shaken per route.
- **Rejected: `lucide-react`** (and every icon package). Even tree-shaken it drags in a wrapper
  component and ~6 KB of overhead for icons that are 190 bytes each; and it does not contain a pawn,
  a carrom striker, a shuttlecock or a kabaddi glyph, so half the set would be hand-drawn anyway.
- **Rejected: an SVG sprite** (`<use href="/icons.svg#x">`). It is one extra request with a 400 ms
  RTT penalty on 4G, and it is render-blocking for above-the-fold icons.
- Icons are always `aria-hidden` and accompanied by text, **except** icon-only buttons, which carry
  an `aria-label`.
- Decorative-only usage is capped: no icon larger than 28 px outside empty states and the hero.

**The set (28 icons, ≈ 5.3 KB total inlined):**
`fork` (the mark) · `search` · `user` · `users` · `home` · `trophy` · `bracket` · `list` · `table` ·
`calendar` · `clock` · `map-pin` · `rupee` · `chevron-left/right/down` · `arrow-right` · `plus` ·
`minus` · `check` · `x` · `alert-triangle` · `info` · `copy` · `share` · `download` · `cloud-off` ·
`key` (passkey) · `dot` (live) · `gamepad` (esport) · `pawn` (board) · `ball` (outdoor). These three double as the per-game glyph:
there is no per-game icon asset in v1 (`docs/CONTENT.md` §2.9).

## 8. Imagery

`images: { unoptimized: true }` means there is no optimizer and no responsive `srcset` generation.
Therefore:

1. **The site ships no decorative raster images at all.** Backgrounds, hero art, category art,
   avatars, empty-state art and the logo are all inline SVG or CSS.
2. The only rasters in the repo are the **six static OG cards** (§10) and the **PWA icons** — none of
   which are fetched during a normal page view.
3. The only user-supplied raster is an optional **tournament poster** (v1.1). It renders at
   `max-width: 640px`, `aspect-ratio: 1200/630`, with explicit `width`/`height` attributes,
   `loading="lazy" decoding="async"`, inside a `rounded-xl overflow-hidden bg-surface-2` frame.
   The Worker enforces ≤ 300 KB / ≤ 1600 px at upload; there is no runtime resize to fall back on.
4. Charts (leaderboard trend, participation over time) are inline SVG drawn from JSON. No chart
   library.

---

## 9. Performance budget

This is a hard budget, not an aspiration. **CI fails the build if a route exceeds it.**

### 9.1 The budget is expressed against a MEASURED framework floor

The JS numbers below were originally written as absolutes (88 KB for `/`, 112 KB for
`/t/<slug>/bracket/`), which is the right idea set at a number nobody had measured. Next 15's App
Router "First Load JS shared by all" — React, React DOM, the App Router client runtime and the RSC
payload reader — is roughly **90–110 KB gz before a single line of application code**. If the real
floor sits at the top of that range, `/` fails its budget on the day the nav bar exists, CI blocks
every subsequent PR, and the team's first response is to raise the numbers arbitrarily — which
discards the one mechanism protecting the 4G experience.

So:

1. **Before any feature work**, land the empty-shell build (`app/layout.tsx` + the six route stubs,
   no components, no fetches), run `next build`, and record the reported "First Load JS shared by
   all" here as a stated constant:

   ```
   FRAMEWORK_FLOOR = <measured> KB gz     // next 15.5.20 + react 19.0.0, measured YYYY-MM-DD
   ```

   `BUILD-PLAN.md`'s foundation phase carries this as an explicit gate.
2. **Every route budget is `FRAMEWORK_FLOOR + a route allowance`**, and the allowance is what the
   team actually controls:

   | Route | JS allowance (gz) over the floor |
   | --- | --- |
   | `/` | **+25 KB** |
   | `/tournaments/` | **+28 KB** |
   | `/leaderboard/` | **+26 KB** |
   | `/t/<slug>/` (shell + inject) | **+40 KB** |
   | `/t/<slug>/bracket/` | **+45 KB** |
   | `/admin/**` | **+90 KB** (organizers only; exempt from the public ceiling) |

3. **`scripts/budget-check.mjs` reports both numbers on failure**, so a regression is attributable:

   ```
   FAIL /t/<slug>/bracket/  156 KB gz = floor 108 KB + app 48 KB   (allowance 45 KB, over by 3 KB)
   ```

   A failure caused by a framework bump reads as the floor moving and is a deliberate, discussed
   change to `FRAMEWORK_FLOOR`; a failure caused by an import reads as the app number moving and is
   the PR author's problem. Conflating them is how the budget gets quietly raised.
4. If the measured floor makes any allowance above impossible, the response is to **cut a feature or
   change the framework choice**, not to raise the allowance. Say so out loud when it happens.

### 9.2 Transfer budget

The totals below assume `FRAMEWORK_FLOOR ≈ 63 KB` (the figure this document was originally written
against). **Recompute the `Total` column from the measured floor** as step 1 of the foundation
phase; the HTML/CSS/font columns and the ceilings do not move.

| Route | HTML | CSS | JS (first-load, gz) | Fonts | Images | **Total** |
| --- | --- | --- | --- | --- | --- | --- |
| `/` | 9 KB | 11 KB | floor + 25 | 24 KB | 0 | **floor + 69 KB** |
| `/tournaments/` | 6 KB | 11 KB | floor + 28 | 24 KB | 0 | **floor + 69 KB** |
| `/t/<slug>/` (shell + inject) | 8 KB | 11 KB | floor + 40 | 24 KB | 0 | **floor + 83 KB** |
| `/t/<slug>/bracket/` | 8 KB | 11 KB | floor + 45 | 24 KB | 0 | **floor + 88 KB** |
| `/leaderboard/` | 6 KB | 11 KB | floor + 26 | 24 KB | 0 | **floor + 67 KB** |
| `/admin/**` | 6 KB | 11 KB | floor + 90 | 24 KB | 0 | organizers only; exempt from the public ceiling |

**Public ceiling: 180 KB transferred on first load. CSS ceiling: 14 KB gz for the whole site.**
The public ceiling is the number that actually matters and it does **not** move with the floor: if
`FRAMEWORK_FLOOR + 45 + 43` exceeds 180 KB on the bracket route, that is a real finding about the
framework choice and must be escalated, not absorbed.

Field targets on a simulated Moto G Power / Slow 4G (400 kbps, 400 ms RTT):
**LCP ≤ 2.5 s · TTI ≤ 3.5 s · CLS ≤ 0.02 · INP ≤ 200 ms.**

How the budget is held:

1. **No UI library, no icon library, no animation library, no bracket library, no date library.**
   Dates are formatted with `Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata' })` — built in,
   0 KB. Money with `Intl.NumberFormat('en-IN', { style:'currency', currency:'INR',
   maximumFractionDigits: 0 })` — which produces the Indian `₹1,00,000` grouping for free.
   The only runtime dependency beyond React is `clsx` (0.5 KB).
2. **Three shells, three bundles.** Admin code never reaches an anonymous visitor (`docs/IA.md` §2.3).
3. **Route-level `dynamic(() => import(...), { ssr: false })`** for: the QR generator (registration
   payment step only), the Map-mode bracket renderer (imported when the user switches to Map), and
   the CSV export in `/admin/t/<slug>/audit/`.
4. **CLS is bought with fixed dimensions**: every card, row, table cell and skeleton has an explicit
   height; the metric-matched font fallback (§3.2) kills the swap shift; the boot island (§4 of
   `docs/IA.md`) means the tournament header never appears late.
5. **CSS stays small because there is no `dark:` variant in the codebase** — theming is CSS variables,
   so Tailwind emits one copy of every utility.
6. Tailwind `content` globs cover `./app`, `./components`, `./content` only. Never `./**`.

---

## 10. OG / social preview

WhatsApp is the primary distribution channel. Getting this right is worth more than any other pixel
in the product.

**Meta tags** (injected per-tournament by the Worker; see `docs/IA.md` §4):

```html
<meta property="og:type"        content="website">
<meta property="og:site_name"   content="nellore.club">
<meta property="og:locale"      content="en_IN">
<meta property="og:title"       content="BGMI Diwali Cup">
<meta property="og:description" content="LIVE now · Match 3 of 6 · 32 teams · ₹10,000 prize pool">
<meta property="og:image"       content="https://nellore.club/og/cat-esport.png">
<meta property="og:image:width"  content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt"   content="nellore.club — esports tournaments in Nellore">
<meta property="og:url"         content="https://nellore.club/t/bgmi-diwali-cup/">
<meta name="twitter:card"       content="summary_large_image">
<meta name="theme-color" media="(prefers-color-scheme: dark)"  content="#0B0F14">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#FFFFFF">
```

**WhatsApp-specific constraints, and the design that satisfies them:**

| Constraint | Design response |
| --- | --- |
| WhatsApp fetches the image **once** and caches it hard, keyed by URL | OG image URLs are content-addressed (`/og/cat-esport.png`, or a hashed poster key). A poster edit produces a new URL. |
| WhatsApp will silently skip an image over ~600 KB, and is unreliable above ~300 KB on slow links | Each static OG card is a flat-colour PNG-8 with ≤ 24 colours: **≈ 28–40 KB each**. Uploaded posters are capped at 300 KB. |
| WhatsApp **does not render SVG** as `og:image` | The six cards are prebuilt PNGs committed to `public/og/`, generated from SVG sources by a `scripts/` step run manually — not at request time. |
| Some clients show a small **square** thumbnail instead of the 1.91:1 card | All essential content sits inside a **centred 630 × 630 safe square**; only the flat background bleeds outside it. |
| The description is truncated at roughly 110–130 characters on Android | Descriptions are composed to ≤ 110 chars and front-load the status (`LIVE now · …`). |

**The six static cards** (1200 × 630, all flat vector art, no photography):

1. `cat-esport.png` — `--bg` field, the Fork mark in amber at 160 px, `nellore.club` wordmark, and
   the word `ESPORTS` in `text-2xs`-style tracked uppercase amber. A faint 1 px bracket-tree line
   pattern at 8 % opacity fills the lower third.
2. `cat-board.png` — same layout, `BOARD GAMES`, pattern = a faint 8×8 chequer.
3. `cat-outdoor.png` — same layout, `SPORTS`, pattern = faint court/pitch line marks.
4. `default.png` — the Fork + wordmark + `Game tournaments in Nellore`.
5. `leaderboard.png` — the Fork + `LEADERBOARD` + three faint podium bars.
6. `player.png` — the Fork + `PLAYER` + a faint identicon grid.

The dynamic specifics (name, status, prize, slots, date) live in `og:title` and `og:description`,
which the Worker computes per request from D1 and which cost zero bytes and zero staleness.

**Rejected: rendering a per-tournament OG PNG.** Cloudflare Browser Rendering or a Satori/resvg WASM
pipeline in the Worker would give a beautiful bespoke card per tournament. Rejected for v1 because
(a) Browser Rendering is a paid add-on and the brief forbids paid dependencies to launch, (b) a
Satori + resvg WASM bundle is several megabytes and will not fit comfortably inside a Worker's
startup and CPU budget on a link-preview request that must answer in well under a second, and (c) the
information a sharer actually cares about — is it live, what does it cost, are there slots left — is
better served by a text description that is always current than by a PNG that WhatsApp caches
forever. The upgrade path is the organizer poster upload (§8.3), which gives a bespoke image with
zero runtime cost.

**Verification checklist before launch:** paste a tournament URL into WhatsApp (Android + iOS),
Telegram, Instagram DM, and X, and confirm title, description and image all render. WhatsApp caches
aggressively — test with a fresh URL (append a throwaway path segment) rather than fighting the
cache, and validate the tags with `curl -A 'WhatsApp/2' https://nellore.club/t/<slug>/ | head -40`.

---

## 11. Print

One stylesheet, `@media print`, used for posting draws on the venue notice board:
hide `nav`, the bottom bar, the footer, all buttons and the offline bar; force `[data-theme]` values
to the light palette; render the bracket in **Table view** (§6.10 / `docs/IA.md` §8.3) because a tree
does not paginate; expand every accordion; append the tournament URL as visible text under the
heading; `@page { size: A4; margin: 12mm }`.

---

## 12. Design QA checklist (blocking for every PR that touches UI)

1. Does every new foreground/background pair appear in §2.2 or §2.4 with a stated ratio? If not, it
   is not allowed until it is computed and added.
2. Is any status communicated by colour alone? (Must be glyph + text + colour.)
3. Is every interactive target ≥ 44 × 44, with ≥ 8 px separation?
4. Does the view have all five states from `docs/IA.md` §7.1 — including offline?
5. Does the skeleton match the loaded layout's box model exactly (CLS = 0)?
6. Is `nc-focus` on every focusable element, and is the ring visible against its own background?
7. Does it work at 320 px width and at 400 % zoom?
8. Does `prefers-reduced-motion: reduce` remove every non-opacity animation?
9. Are all numeric columns `.nums-tab`?
10. Did the route's transferred bytes stay under its §9 budget?
11. Is amber used exactly where §2.3 permits — action, winner, live round, prize — and nowhere else?
12. Any `dark:` variant, any hex literal, any `if (game === '…')`? All three are build failures.
