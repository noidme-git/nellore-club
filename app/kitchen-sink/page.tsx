'use client';

/**
 * THROWAWAY. Delete before launch — `BUILD-PLAN.md` Phase 0 acceptance criterion 5
 * sanctions exactly this file and says so.
 *
 * Two things it is for:
 *
 *  1. The DESIGN.md §12 review pass. Every `components/ui/*` at every variant on
 *     one screen, so a human can walk the §12 checklist (contrast, 44 px targets,
 *     focus rings, 320 px, 400 % zoom, both themes, print) once instead of
 *     hunting variants across ten feature branches.
 *  2. A compile-time integration test of the two parallel UI workstreams. Every
 *     component here is imported through `components/ui/index.ts`, so a prop that
 *     one stream renamed and another still passes is a `tsc` error in this file
 *     rather than a runtime crash in W7's bracket view three days later. That is
 *     the half of the criterion CI can actually enforce.
 *
 * It is `app/kitchen-sink/`, NOT the `app/_kitchen-sink/` the build plan names:
 * App Router treats a leading underscore as a *private folder* and drops it from
 * the route tree entirely, so `_kitchen-sink/page.tsx` would type-check and never
 * render — the criterion could not be met. Cost of the rename: this is a real,
 * crawlable URL in `out/`. `public/robots.txt` does not disallow it (that file is
 * spec'd verbatim and is not mine to widen), so deleting the directory is a
 * launch-blocking task, not housekeeping.
 *
 * `'use client'` is load-bearing: most of these primitives take event handlers,
 * which a server component cannot pass across the boundary. Under
 * `output: 'export'` the page still prerenders to static HTML at build time.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import {
  Avatar,
  Button,
  Card,
  CodeReveal,
  Countdown,
  EmptyState,
  FreshnessChip,
  GameBadge,
  HoldToConfirm,
  Icon,
  ICON_NAMES,
  Input,
  Modal,
  OfflineBar,
  SegmentedControl,
  Select,
  ShareBar,
  Sheet,
  Skeleton,
  StatusPill,
  Stepper,
  Tabs,
  Textarea,
  Toast,
  ToastHost,
  WizardProgress,
  type ButtonSize,
  type ButtonVariant,
  type StatusPillKind,
  type ToastItem,
} from '@/components/ui';
import type { GameCategory } from '@/lib/types';

const BUTTON_VARIANTS: readonly ButtonVariant[] = [
  'primary',
  'secondary',
  'ghost',
  'link',
  'danger',
  'danger-outline',
];

const BUTTON_SIZES: readonly ButtonSize[] = ['sm', 'md', 'lg'];

const PILL_KINDS: readonly StatusPillKind[] = [
  'registration_open',
  'registration_closing',
  'scheduled',
  'live',
  'completed',
  'cancelled',
  'payment_pending',
  'queued',
  'eliminated',
];

const CATEGORIES: readonly GameCategory[] = ['esport', 'board', 'outdoor'];

/**
 * A frozen clock, not `Date.now()`. The prerendered HTML and the first client
 * render must agree or React logs a hydration mismatch on a page whose whole
 * purpose is to look at rendering. Countdowns tick forward from here once
 * mounted, which is the behaviour under review anyway.
 */
const NOW = 1_762_950_000;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-6" aria-label={title}>
      <h2 className="mb-4 text-lg font-bold text-fg">{title}</h2>
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </section>
  );
}

export default function KitchenSinkPage() {
  const [tab, setTab] = useState('bracket');
  const [segment, setSegment] = useState('rounds');
  const [score, setScore] = useState(3);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [toasts, setToasts] = useState<readonly ToastItem[]>([
    { id: 'a', kind: 'success', message: 'Score saved.' },
    { id: 'b', kind: 'error', message: 'Could not reach the server.', durationMs: 0 },
    {
      id: 'c',
      kind: 'info',
      message: 'Round 2 pairings are up.',
      action: { label: 'View', onClick: () => undefined },
    },
  ]);

  const sheetFocusRef = useRef<HTMLButtonElement | null>(null);
  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const noop = useCallback(() => undefined, []);

  const tabItems = useMemo(
    () => [
      { id: 'overview', label: 'Overview', icon: 'list' as const },
      { id: 'bracket', label: 'Bracket', icon: 'bracket' as const },
      { id: 'standings', label: 'Standings', icon: 'table' as const, badge: '12' },
      { id: 'rules', label: 'Rules', disabled: true },
    ],
    [],
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-extrabold text-fg">components/ui kitchen sink</h1>
      <p className="mt-2 text-sm text-fg-muted">
        Throwaway review surface for DESIGN.md §12. Delete this route before launch.
      </p>

      <Section title="Buttons">
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
        {BUTTON_SIZES.map((size) => (
          <Button key={size} size={size}>
            size {size}
          </Button>
        ))}
        <Button loading busyLabel="Saving the score">
          Save score
        </Button>
        <Button success successLabel="Saved">
          Save
        </Button>
        <Button disabled>Disabled</Button>
        <Button aria-disabled>Explained-disabled</Button>
        <Button iconOnly aria-label="Copy the room code">
          <Icon name="copy" />
        </Button>
        <Button fullWidth>Full width</Button>
      </Section>

      <Section title="Icons (all 34)">
        {ICON_NAMES.map((name) => (
          <span key={name} className="flex w-20 flex-col items-center gap-1 text-2xs text-fg-faint">
            <Icon name={name} size={24} />
            {name}
          </span>
        ))}
      </Section>

      <Section title="Fields">
        <Input containerClassName="w-full" label="Team name" hint="As it appears on the bracket." />
        <Input
          containerClassName="w-full"
          label="In-game ID"
          required
          error="This ID is already registered for this tournament."
        />
        <Input
          containerClassName="w-full"
          label="Entry fee"
          fieldVariant="numeric"
          defaultValue="500"
        />
        <Input containerClassName="w-full" label="Room code" fieldVariant="code" defaultValue="AB7K2M" />
        <Input containerClassName="w-full" label="Search" labelHidden placeholder="Search" />
        <Input containerClassName="w-full" label="Locked" defaultValue="fixed" readOnly />
        <Textarea containerClassName="w-full" label="Organizer notes" hint="Not shown to players." />
        <Textarea containerClassName="w-full" label="Reason" error="Say why the match was reopened." />
        <Select
          containerClassName="w-full"
          label="Format"
          options={[
            { value: 'single_elim', label: 'Single elimination' },
            { value: 'double_elim', label: 'Double elimination' },
            { value: 'swiss', label: 'Swiss', disabled: true },
          ]}
        />
        <Select
          containerClassName="w-full"
          label="Game"
          error="Pick a game."
          options={[
            { label: 'Esports', options: [{ value: 'bgmi', label: 'BGMI' }] },
            { label: 'Board', options: [{ value: 'chess', label: 'Chess' }] },
          ]}
        />
      </Section>

      <Section title="Navigation">
        <div className="w-full">
          <Tabs items={tabItems} value={tab} onValueChange={setTab} label="Tournament sections" />
          <div className="mt-3 text-sm text-fg-muted">Selected: {tab}</div>
        </div>
        <div className="w-full">
          <Tabs items={tabItems} value={tab} onValueChange={setTab} label="Nav mode" mode="nav" />
        </div>
        <SegmentedControl
          items={[
            { value: 'rounds', label: 'Rounds', icon: 'bracket' },
            { value: 'follow', label: 'Follow', icon: 'user' },
            { value: 'table', label: 'Table', icon: 'table' },
          ]}
          value={segment}
          onValueChange={setSegment}
          label="Bracket view"
        />
      </Section>

      <Section title="Status, badges, avatars">
        {PILL_KINDS.map((kind) => (
          <StatusPill key={kind} kind={kind} />
        ))}
        {CATEGORIES.map((category) => (
          <GameBadge key={category} category={category} name={category} accent="#1D4ED8" />
        ))}
        {([24, 32, 36, 48, 72] as const).map((size) => (
          <Avatar key={size} name="Sai Kiran Reddy" size={size} seed={`seed-${size}`} />
        ))}
      </Section>

      <Section title="Cards and skeletons">
        <Card className="w-full">Plain card</Card>
        <Card className="w-full" interactive>
          Interactive card
        </Card>
        <Card className="w-full" padded={false}>
          Unpadded card
        </Card>
        <Skeleton className="w-full" lines={3} />
      </Section>

      <Section title="Time">
        <Countdown targetAt={NOW + 87_060} nowSeconds={NOW} className="text-3xl" />
        <Countdown targetAt={NOW + 761} nowSeconds={NOW} />
        <Countdown targetAt={NOW + 22_320} nowSeconds={NOW} variant="compact" />
        <Countdown targetAt={NOW - 5} nowSeconds={NOW} completedContent="Open now" />
        <FreshnessChip updatedAt={NOW - 240} now={NOW} onRefresh={noop} />
        <FreshnessChip updatedAt={NOW - 7_200} now={NOW} onRefresh={noop} />
        <FreshnessChip updatedAt={NOW - 7_200} now={NOW} offline onRefresh={noop} />
        <FreshnessChip updatedAt={NOW - 10} now={NOW} refreshing onRefresh={noop} />
      </Section>

      <Section title="Progress and empty">
        <WizardProgress current={2} total={4} label="Registration" stepName="Your team" />
        <Stepper value={score} onChange={setScore} entrantName="Nellore Strikers" unitName="kills" />
        <EmptyState
          className="w-full"
          title="No tournaments yet"
          description="Nothing is scheduled. New events are posted here first."
          action={<Button>Browse games</Button>}
          secondaryAction={<Button variant="link">Contact the club</Button>}
          icon={<Icon name="trophy" size={28} />}
        />
      </Section>

      <Section title="Offline, toasts">
        <OfflineBar className="w-full" offline asOfLabel="7:41 PM IST" onRetry={noop} />
        <OfflineBar className="w-full" offline retrying onRetry={noop} />
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </Section>

      <Section title="Codes and sharing">
        <CodeReveal className="w-full" label="Room code" value="AB7K2M" meta="Expires at 7:30 PM IST" />
        <CodeReveal
          className="w-full"
          label="Recovery codes"
          value={['4KX2-9QJ7', '8TMV-2NDR', 'PZ63-LW1H']}
          defaultRevealed
          downloadFileName="nellore-club-recovery-codes.txt"
          hint="Store these somewhere you can reach without this phone."
        />
        <ShareBar
          className="w-full"
          share={{
            title: 'Nellore Open — BGMI',
            text: 'Nellore Open — BGMI, Sat 12 Nov, 6:00 PM IST',
            url: 'https://nellore.club/t/nellore-open-bgmi/',
          }}
          whatsappText={'*Nellore Open — BGMI*\nSat 12 Nov, 6:00 PM IST'}
        />
      </Section>

      <Section title="Overlays and confirmation">
        <Button onClick={() => setSheetOpen(true)}>Open sheet</Button>
        <Button variant="danger" onClick={() => setModalOpen(true)}>
          Open destructive modal
        </Button>
        <HoldToConfirm label="Lock the result" onConfirm={noop} />
        <HoldToConfirm label="Delete the bracket" variant="danger" onConfirm={noop} fullWidth />
        <HoldToConfirm label="Simple confirm path" onConfirm={noop} simpleConfirmations />

        <Sheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title="Match 14 — Round 2"
          description="Submit the score for both entrants."
          initialFocusRef={sheetFocusRef}
          footer={<Button ref={sheetFocusRef}>Submit</Button>}
        >
          <p className="text-sm text-fg-muted">Sheet body.</p>
        </Sheet>

        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          tone="destructive"
          title="Delete this bracket?"
          description="Every match, score and standing generated from it goes with it."
          actions={
            <>
              <Button variant="secondary" onClick={() => setModalOpen(false)}>
                Keep it
              </Button>
              <Button variant="danger" onClick={() => setModalOpen(false)}>
                Delete
              </Button>
            </>
          }
        />
      </Section>

      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
