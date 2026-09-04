import clsx from 'clsx';
import { forwardRef, type HTMLAttributes } from 'react';

/**
 * DESIGN.md §6.15 / §4.4 item 8.
 *
 * The shimmer is a single `background-position` animation over a linear
 * gradient, not a pseudo-element sweeping across the box: one composited layer,
 * no paint per frame, which is what keeps a 6-card skeleton list from dropping
 * frames on a mid-range Android. `motion-reduce:animate-none` leaves a flat
 * `--surface-2` block, which still reads as "content is coming" without moving.
 *
 * Every skeleton is `aria-hidden`. The loading state is announced exactly once,
 * by the single `role="status"` region that `components/data/DataView` owns
 * ("Loading tournaments") — six shimmering boxes in the accessibility tree is
 * six meaningless announcements.
 *
 * The 250ms mount delay (IA.md §7.1) is NOT here. It belongs to DataView, which
 * is the thing that knows whether the cache was warm; a delay baked into the
 * primitive would fire again for every skeleton in a list.
 *
 * A skeleton must mirror the real component's box model exactly so filling it
 * causes zero layout shift — pass the same fixed heights the real component
 * uses (`SkeletonTournamentCard` is 168px tall, like the real card).
 */

export interface SkeletonProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /**
   * Render N stacked bars instead of one box, for a paragraph placeholder. The
   * last bar is short, because a real last line is.
   */
  lines?: number;
  /** Gap between bars when `lines > 1`. */
  lineClassName?: string;
}

const SHIMMER =
  'bg-surface-2 bg-[linear-gradient(90deg,var(--surface-2)_25%,var(--surface-3)_37%,var(--surface-2)_63%)] bg-[length:400%_100%] animate-nc-shimmer motion-reduce:animate-none';

export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(function Skeleton(
  { lines, className, lineClassName, ...rest },
  ref,
) {
  if (lines !== undefined && lines > 1) {
    return (
      <div ref={ref} aria-hidden="true" className={clsx('flex flex-col gap-2', className)} {...rest}>
        {Array.from({ length: lines }, (_unused, index) => (
          <div
            key={index}
            className={clsx(
              'h-4 rounded-sm',
              SHIMMER,
              index === lines - 1 ? 'w-3/5' : 'w-full',
              lineClassName,
            )}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={clsx('rounded-sm', SHIMMER, className)}
      {...rest}
    />
  );
});
