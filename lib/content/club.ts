/**
 * Typed loader for `content/club.json` (CONTENT.md §9).
 *
 * The file is imported at **build time** (`resolveJsonModule`), not fetched, so
 * the About/Contact/Rules pages prerender with no request and no loading state.
 * `PATCH /api/v1/admin/club` edits the D1 copy and `GET /api/v1/club` serves it;
 * this module is the compiled-in baseline and the shape both agree on.
 *
 * **The one behavioural rule this module exists to enforce is null-hiding.**
 * `content/club.json` deliberately ships `null` for every fact the owner has
 * not confirmed — the phone number, the address, the Instagram handle, the
 * "tournaments run" counter. A `null` rendered as `0`, as an empty box, or as a
 * dead `tel:` link is worse than the absence: it is a wrong fact on a page a
 * club's reputation rests on, and `contact.render_rule` in the file says so in
 * as many words. So nothing here returns a nullable field raw. Callers get
 * pre-filtered arrays, and a stat with no value simply does not appear.
 */

import raw from '../../content/club.json';

/* =====================================================================
 * Shape
 *
 * Hand-written rather than inferred from the JSON, because TypeScript infers
 * `null` for `"legal_name": null` — which makes assigning a real value later a
 * type error, and makes every null-check look redundant to the reader.
 * ===================================================================== */

export interface ClubIdentity {
  name: string;
  short_name: string;
  wordmark: string;
  legal_name: string | null;
  domain: string;
  url: string;
  tagline: string;
  tagline_long: string;
  founded_year: number;
  timezone: string;
  timezone_label: string;
  currency: string;
  currency_symbol: string;
  locale: string;
  languages: string[];
  language_note: string;
}

/** `value: null` means "not known yet" and the tile is not rendered. */
export interface ClubStat {
  key: string;
  label: string;
  value: number | null;
  prefix?: string;
  suffix?: string;
}

/** A stat that survived the null filter: `value` is a number, not a maybe. */
export interface ResolvedClubStat extends ClubStat {
  value: number;
  /** `prefix + grouped value + suffix`, ready to render. */
  display: string;
}

export interface ClubStory {
  headline: string;
  paragraphs: string[];
  what_we_do: string[];
  why_trust_us: string[];
  stats: ClubStat[];
  stats_note: string;
}

export interface ClubContact {
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  whatsapp_group_invite: string | null;
  whatsapp_channel: string | null;
  instagram: string | null;
  youtube: string | null;
  telegram: string | null;
  response_time_note: string;
  render_rule: string;
}

export type ClubContactChannelKey =
  | 'email'
  | 'phone'
  | 'whatsapp'
  | 'whatsapp_group_invite'
  | 'whatsapp_channel'
  | 'instagram'
  | 'youtube'
  | 'telegram';

export interface ClubGeo {
  lat: number;
  lng: number;
  accuracy: string;
  note: string;
}

export interface ClubLocation {
  city: string;
  city_alt_names: string[];
  district: string;
  state: string;
  country: string;
  country_code: string;
  area: string | null;
  address_lines: string[] | null;
  pincode: string | null;
  map_url: string | null;
  geo: ClubGeo;
  service_area: string[];
  venue_policy: string;
  venues: unknown[];
}

export interface ClubFaqEntry {
  q: string;
  a: string;
  tags: string[];
}

export interface ClubPrinciple {
  title: string;
  body: string;
}

export interface ClubPenalty {
  step: number;
  label: string;
  meaning: string;
}

export interface ClubCodeOfConduct {
  title: string;
  summary: string;
  principles: ClubPrinciple[];
  specific_rules: string[];
  penalties: ClubPenalty[];
  escalation_note: string;
  appeals: string;
  reporting: string;
}

export interface ClubSeo {
  site_name: string;
  default_title: string;
  title_template: string;
  default_description: string;
  keywords: string[];
  og_image: string;
  og_image_alt: string;
  twitter_card: string;
  whatsapp_preview_note: string;
  organization_schema_type: string;
}

export interface ClubTodoVerify {
  path: string;
  why: string;
  suggested: string;
  /** `true` blocks a launch. `scripts/` greps for these before a deploy. */
  blocking: boolean;
}

/**
 * `policies` is a deep tree of prose whose only consumer is a rules page that
 * renders it as sections. Typing every leaf would be forty interfaces that say
 * `string`, and every one of them would have to change when the owner rewords a
 * refund rule. It is typed as a readonly record of records of strings and read
 * through `policySection`.
 */
export type ClubPolicies = typeof raw.policies;

export interface ClubContent {
  identity: ClubIdentity;
  story: ClubStory;
  contact: ClubContact;
  location: ClubLocation;
  faq: ClubFaqEntry[];
  code_of_conduct: ClubCodeOfConduct;
  policies: ClubPolicies;
  seo: ClubSeo;
  todo_verify: ClubTodoVerify[];
}

/**
 * The single parsed instance. `as unknown as` is the one cast in this file and
 * it is load-bearing: the inferred literal type of the JSON has `null` (not
 * `string | null`) for every unconfirmed field, so a direct assertion would be
 * rejected as insufficiently overlapping. `scripts/` validates the file against
 * this shape at build time; a mismatch is a build failure, not a runtime one.
 */
export const club = raw as unknown as ClubContent;

/* =====================================================================
 * Accessors — every one of these is the null-hiding rule
 * ===================================================================== */

const STAT_GROUP = new Intl.NumberFormat('en-IN', {
  style: 'decimal',
  useGrouping: true,
  maximumFractionDigits: 0,
});

/**
 * Only the stats that have a value. `stats_note` in the file: *"A stat with a
 * null value is not rendered. Do not put estimates here."* A "0 tournaments
 * run" tile on the About page of a club that has run four is a lie the design
 * would rather not tell, and an empty box is a layout hole.
 */
export function visibleStats(): ResolvedClubStat[] {
  const out: ResolvedClubStat[] = [];
  for (const stat of club.story.stats) {
    if (stat.value === null || !Number.isFinite(stat.value)) continue;
    out.push({
      ...stat,
      value: stat.value,
      display: `${stat.prefix ?? ''}${STAT_GROUP.format(stat.value)}${stat.suffix ?? ''}`,
    });
  }
  return out;
}

export interface ClubContactChannel {
  key: ClubContactChannelKey;
  value: string;
  /** `tel:`, `mailto:`, `https://wa.me/…` or the raw URL. Never rendered when the value is null. */
  href: string;
  label: string;
}

const CONTACT_LABELS: Record<ClubContactChannelKey, string> = {
  email: 'Email',
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  whatsapp_group_invite: 'WhatsApp group',
  whatsapp_channel: 'WhatsApp channel',
  instagram: 'Instagram',
  youtube: 'YouTube',
  telegram: 'Telegram',
};

const CONTACT_ORDER: ClubContactChannelKey[] = [
  'whatsapp',
  'phone',
  'email',
  'whatsapp_group_invite',
  'whatsapp_channel',
  'instagram',
  'youtube',
  'telegram',
];

/** Strip the `+`, spaces and dashes an author might type: `wa.me` wants digits only. */
function waDigits(value: string): string {
  return value.replace(/[^\d]/g, '');
}

function contactHref(key: ClubContactChannelKey, value: string): string {
  switch (key) {
    case 'email':
      return `mailto:${value}`;
    case 'phone':
      return `tel:${value.replace(/\s/g, '')}`;
    case 'whatsapp':
      return `https://wa.me/${waDigits(value)}`;
    default:
      return value;
  }
}

/**
 * Contact channels the club actually has, in display order. A `null` channel is
 * absent from the array — never a greyed-out icon and never a dead
 * `tel:`/`mailto:` link, per `contact.render_rule`.
 */
export function visibleContactChannels(): ClubContactChannel[] {
  const out: ClubContactChannel[] = [];
  for (const key of CONTACT_ORDER) {
    const value = club.contact[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    out.push({ key, value, href: contactHref(key, value), label: CONTACT_LABELS[key] });
  }
  return out;
}

export function hasContactChannel(key: ClubContactChannelKey): boolean {
  const value = club.contact[key];
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The postal address as lines, or `null` when there is no confirmed address.
 * `null` means the Contact page renders the service-area copy and the venue
 * policy instead — the club does not own a ground (`location.venue_policy`), so
 * an address block would be fiction.
 */
export function postalAddressLines(): string[] | null {
  const { address_lines, area, city, state, pincode } = club.location;
  if (address_lines === null || address_lines.length === 0) return null;

  const lines = [...address_lines];
  if (area !== null) lines.push(area);
  lines.push(pincode === null ? `${city}, ${state}` : `${city}, ${state} ${pincode}`);
  return lines;
}

/** FAQ entries carrying a tag, e.g. `'registration'` on the register screen. */
export function faqByTag(tag: string): ClubFaqEntry[] {
  return club.faq.filter((entry) => entry.tags.includes(tag));
}

/** The launch blockers. `scripts/` fails a production deploy while any remain. */
export function blockingTodos(): ClubTodoVerify[] {
  return club.todo_verify.filter((todo) => todo.blocking);
}

/* =====================================================================
 * Identity shortcuts — one source of truth for the origin
 * ===================================================================== */

/** `nellore.club`. Used bare in WhatsApp share text (IA.md §10). */
export const CLUB_HOST = club.identity.domain;

/** `https://nellore.club`, no trailing slash. */
export const CLUB_ORIGIN = club.identity.url.replace(/\/+$/, '');

export const CLUB_NAME = club.identity.name;

/** `%s | Nellore Club`, or the default when there is no page title. */
export function pageTitle(title: string | null): string {
  if (title === null || title.trim() === '') return club.seo.default_title;
  return club.seo.title_template.replace('%s', title);
}

/**
 * Absolute URL for an app path. Every canonical/OG URL goes through here so a
 * missing or doubled slash cannot ship — WhatsApp caches a bad `og:url` for
 * days and it is not reproducible on `curl`.
 */
export function absoluteUrl(path: string): string {
  return `${CLUB_ORIGIN}/${path.replace(/^\/+/, '')}`;
}

/** `nellore.club/t/bgmi-diwali-cup/` — the form that goes in a WhatsApp message. */
export function displayUrl(path: string): string {
  return `${CLUB_HOST}/${path.replace(/^\/+/, '')}`;
}
