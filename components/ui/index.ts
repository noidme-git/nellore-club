/**
 * The `components/ui` barrel.
 *
 * It exists because two workstreams wrote this folder in parallel and neither
 * could own the index without colliding with the other. It is a convenience,
 * not the preferred import path: `import { Button } from '@/components/ui'`
 * pulls this module into the route's graph, and while webpack does tree-shake
 * the unreached re-exports, that only holds as long as every file here stays
 * side-effect-free. Anything on a byte-budgeted route (DESIGN.md §9.2) should
 * import the component file directly.
 *
 * Two things are deliberately NOT re-exported, and both are byte decisions:
 *
 *  - The Tailwind recipe constants (`FIELD_BASE`, `CARD_BASE`, `SELECT_BOX`,
 *    `TEXTAREA_CLASS`, …). They are shared internals of the field primitives,
 *    not a public vocabulary; a feature component that needs one is almost
 *    always rebuilding a primitive it should be composing. Import from the
 *    owning file if you genuinely need it.
 *  - The 34 individual glyph components. `export *` from `./icons` would put
 *    the whole set behind one specifier and make an accidental
 *    `import { CheckIcon } from '@/components/ui'` look identical in a diff to
 *    a direct import while being far easier to de-optimise. Use
 *    `import { CheckIcon } from '@/components/ui/icons'`, or `<Icon name>`.
 *
 * NOTE for anyone adding a component here: the folder carries two conventions.
 * The Set A primitives use React 19 ref-as-prop with `ComponentPropsWithRef`;
 * the Set B overlays use `forwardRef` with `HTMLAttributes`. Both accept a
 * `ref` identically from a caller's side, so nothing is broken and neither was
 * rewritten to match the other on integration — a mechanical sweep of fourteen
 * working, accessibility-critical files buys a consistent diff and risks a
 * regression in a focus trap. New files should use the ref-as-prop form.
 */

export { Icon, type IconProps, type IconSize } from './Icon';
export { ICONS, ICON_NAMES, type IconName, type IconComponent, type IconSvgProps } from './icons';

export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { Input, type InputProps, type InputFieldVariant } from './Input';
export { Textarea, type TextareaProps } from './Textarea';
export {
  Select,
  type SelectProps,
  type SelectOption,
  type SelectOptionGroup,
  type SelectItem,
} from './Select';
export { Tabs, tabTriggerId, tabPanelId, type TabsProps, type TabItem } from './Tabs';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentItem,
} from './SegmentedControl';
export { Card, type CardProps } from './Card';
export { StatusPill, type StatusPillProps, type StatusPillKind } from './StatusPill';
export { GameBadge, accentIsLegible, type GameBadgeProps } from './GameBadge';
export { Avatar, type AvatarProps, type AvatarSize } from './Avatar';

export { Sheet, type SheetProps, type SheetSize } from './Sheet';
export { Modal, type ModalProps, type ModalTone } from './Modal';
export {
  Toast,
  type ToastProps,
  type ToastItem,
  type ToastAction,
  type ToastKind,
} from './Toast';
export { ToastHost, type ToastHostProps } from './ToastHost';
export { Skeleton, type SkeletonProps } from './Skeleton';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { Stepper, type StepperProps } from './Stepper';
export { Countdown, type CountdownProps, type CountdownVariant } from './Countdown';
export { CodeReveal, type CodeRevealProps } from './CodeReveal';
export { ShareBar, type ShareBarProps, type SharePayload } from './ShareBar';
export { WizardProgress, type WizardProgressProps } from './WizardProgress';
export { OfflineBar, type OfflineBarProps } from './OfflineBar';
export { FreshnessChip, type FreshnessChipProps } from './FreshnessChip';
export {
  HoldToConfirm,
  type HoldToConfirmProps,
  type HoldToConfirmVariant,
} from './HoldToConfirm';
