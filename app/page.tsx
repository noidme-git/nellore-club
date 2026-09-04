/**
 * INTERIM home page — replaced by W6.
 *
 * BUILD-PLAN.md assigns app/page.tsx to W6, which builds the real home: the live
 * strip, upcoming tournaments from the API, the game grid and club stats. None of
 * that can exist before the API does.
 *
 * This is a launch page, not a placeholder. It is the club's actual story and the
 * actual game lineup, read from content/club.json and content/games.json at build
 * time, so it says something true rather than "coming soon" over a stock photo.
 *
 * Two things it does on purpose:
 *
 *  1. The category sections are generated from games.json's own `categories`
 *     array, not hardcoded. Adding a fourth category to the data adds a section
 *     here with no edit. That is the same claim the whole product rests on, so
 *     the launch page should not be the one place that quietly breaks it.
 *  2. It counts and lists only `status: 'active'` games. One of the twenty is
 *     disabled, and advertising a game the club is not currently running is the
 *     kind of small dishonesty that costs a WhatsApp reply on match day.
 *
 * It ships no client JavaScript of its own: every element is static, which is the
 * point on a mid-range Android phone on 4G.
 *
 * Contact channels are all null in club.json today, and its render_rule is
 * explicit — a null channel must not render at all, "no dead tel:, mailto: or
 * https:// link, and no greyed-out icon". So there is no contact block rather
 * than a fake one. See TODO_VERIFY in content/club.json.
 */

import clubData from '@/content/club.json';
import gamesData from '@/content/games.json';

interface GameRow {
  slug: string;
  name: string;
  category: string;
  status: string;
  tagline?: string;
}

interface CategoryRow {
  slug: string;
  name: string;
  short_name?: string;
  description?: string;
}

const club = clubData as unknown as {
  identity: { wordmark: string; tagline_long: string; timezone_label: string };
  story: { headline: string; paragraphs: string[] };
  location: { city: string; state: string };
};

const catalog = gamesData as unknown as { games: GameRow[]; categories: CategoryRow[] };

export const metadata = {
  title: 'Nellore Club — tournaments for Nellore',
  description:
    'One link for the draw, the fixtures, the live scores and the final table. Esports, board games and outdoor sport in Nellore.',
};

const PROMISES = [
  'The draw and the full bracket, on a phone',
  'Live scores as the organiser enters them',
  'Standings and the final table',
  'Registration for a squad or a single player',
  'Check-in and room codes on match day',
  'A leaderboard that carries across events',
];

export default function HomePage() {
  const { identity, story, location } = club;
  const active = catalog.games.filter((g) => g.status === 'active');
  const place = `${location.city}, ${location.state}`;

  return (
    <div className="mx-auto max-w-app px-4 pb-20">
      <section className="pt-14 pb-12 sm:pt-20 sm:pb-16">
        <p className="text-2xs uppercase text-brand">{place}</p>
        <h1 className="mt-3 max-w-prose text-display font-extrabold text-fg">{story.headline}</h1>
        <p className="mt-5 max-w-prose text-lg text-fg-muted">{identity.tagline_long}</p>

        <div className="mt-8 inline-flex items-start gap-2.5 rounded-lg border border-line bg-surface-2 px-4 py-3">
          <span aria-hidden="true" className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-brand" />
          <p className="text-sm text-fg-muted">
            The tournament platform is being built. This page is live; the brackets are not yet.
          </p>
        </div>
      </section>

      <section aria-labelledby="what" className="border-t border-line py-12">
        <h2 id="what" className="text-2xl font-bold text-fg">
          What we&rsquo;re building
        </h2>
        <div className="mt-6 max-w-prose space-y-4 text-base text-fg-muted">
          {story.paragraphs.slice(0, 2).map((p) => (
            <p key={p.slice(0, 48)}>{p}</p>
          ))}
        </div>
      </section>

      <section aria-labelledby="games" className="border-t border-line py-12">
        <h2 id="games" className="text-2xl font-bold text-fg">
          {active.length} games, {catalog.categories.length} worlds
        </h2>
        <p className="mt-3 max-w-prose text-base text-fg-muted">
          One engine runs all of them. A new game is a line of data, not a release &mdash; which is
          why a carrom doubles knockout and a BGMI points series work the same way here.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {catalog.categories.map((cat) => {
            const list = active.filter((g) => g.category === cat.slug);
            if (list.length === 0) return null;
            return (
              <div key={cat.slug} className="rounded-lg border border-line bg-surface p-5">
                <h3 className="text-lg font-semibold text-fg">{cat.short_name ?? cat.name}</h3>
                <p className="mt-1 text-xs text-fg-faint">
                  {list.length} {list.length === 1 ? 'game' : 'games'}
                </p>
                <ul className="mt-4 space-y-1.5">
                  {list.map((g) => (
                    <li key={g.slug} className="text-sm text-fg-muted">
                      {g.name}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="soon" className="border-t border-line py-12">
        <h2 id="soon" className="text-2xl font-bold text-fg">
          What the link will do
        </h2>
        <ul className="mt-6 grid max-w-prose gap-3 text-base text-fg-muted sm:grid-cols-2">
          {PROMISES.map((item) => (
            <li key={item} className="flex gap-2.5">
              <span aria-hidden="true" className="text-brand">
                &bull;
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="border-t border-line pt-8 text-sm text-fg-faint">
        <p>
          {identity.wordmark} &middot; {place} &middot; {identity.timezone_label}
        </p>
        <p className="mt-2">Organisers speak Telugu and English at every event.</p>
      </footer>
    </div>
  );
}
