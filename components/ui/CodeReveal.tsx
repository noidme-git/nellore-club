'use client';

import clsx from 'clsx';
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

import { CheckIcon, CopyIcon, DownloadIcon } from './icons';

/**
 * DESIGN.md §6.19, IA.md Journey 3.
 *
 * Two jobs, one component: the BGMI room ID/password on a check-in screen, and
 * the ten recovery codes handed out once at signup (AUTH.md). Both are short
 * high-value strings that the user must get out of the phone and into somewhere
 * else, in a crowded hall.
 *
 * WHY THE BLUR. Venues are crowded and codes get shoulder-surfed; a room code on
 * screen while the captain walks to the desk is a code the next team also has.
 * So it renders blurred behind a full-size tap target, and reveals on demand.
 *
 * WCAG 2.2 §3.3.8 (accessible authentication) is why the revealed code is
 * `select-all` and why nothing here intercepts copy, paste, selection or the
 * context menu. A recovery code the user cannot select, copy, or paste into a
 * password manager forces a memory test, which is exactly what 3.3.8 forbids.
 * There are three independent routes out — select, Copy, Download — because in a
 * WebView any one of them can be missing (`navigator.clipboard` is undefined on
 * a non-secure origin; `download` is ignored by some in-app browsers).
 *
 * First reveal announces `assertive`. DESIGN.md §6.19 and IA.md §8.3 permit
 * assertive in exactly two places, and this is one: the user asked for this
 * string, right now, and it is the only thing on screen that matters.
 */

export interface CodeRevealProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onCopy'> {
  /** e.g. `ROOM ID`, `PASSWORD`, `Recovery codes`. */
  label: string;
  /** A single code, or the recovery-code set (rendered as an ordered list). */
  value: string | readonly string[];
  /** Controlled reveal. Omit for the default uncontrolled behaviour. */
  revealed?: boolean;
  defaultRevealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
  revealPrompt?: string;
  copyLabel?: string;
  copiedLabel?: string;
  /**
   * Fired after a copy attempt. The toast is the caller's — this primitive owns
   * no toast store (ARCHITECTURE.md §4 rule 3).
   */
  onCopy?: (text: string, succeeded: boolean) => void;
  /** Enables the Download affordance. The value is the filename, e.g. `nellore-club-recovery-codes.txt`. */
  downloadFileName?: string;
  downloadLabel?: string;
  onDownload?: () => void;
  /** e.g. a `Updated 7:22 PM IST` line when the organiser republished a room code. */
  meta?: ReactNode;
  hint?: ReactNode;
}

const ACTION_BUTTON =
  'nc-focus inline-flex h-11 min-w-touch items-center justify-center gap-2 rounded-md border border-line-strong bg-surface-2 px-4 text-[15px] font-bold leading-none text-fg transition-[background-color,transform] duration-1 ease-out active:translate-y-px hover:bg-surface-3';

const CODE_TEXT = 'font-mono text-code uppercase tracking-[0.14em] nums-tab';

/**
 * `navigator.clipboard` is undefined on an insecure origin and inside some
 * Android in-app WebViews, where the deprecated `execCommand` still works. The
 * fallback is ~15 lines and is the difference between a captain copying a room
 * code and a captain retyping it wrong.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.top = '-1000px';
    scratch.style.opacity = '0';
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(scratch);
    return ok;
  } catch {
    return false;
  }
}

export const CodeReveal = forwardRef<HTMLDivElement, CodeRevealProps>(function CodeReveal(
  {
    label,
    value,
    revealed,
    defaultRevealed = false,
    onRevealedChange,
    revealPrompt = 'Tap to reveal',
    copyLabel = 'Copy',
    copiedLabel = 'Copied',
    onCopy,
    downloadFileName,
    downloadLabel = 'Download',
    onDownload,
    meta,
    hint,
    className,
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const labelId = `${reactId}-label`;

  const [uncontrolled, setUncontrolled] = useState(defaultRevealed);
  const isRevealed = revealed ?? uncontrolled;

  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const codes = typeof value === 'string' ? [value] : value;
  const plainText = codes.join('\n');

  const setRevealed = useCallback(
    (next: boolean) => {
      if (revealed === undefined) setUncontrolled(next);
      onRevealedChange?.(next);
    },
    [revealed, onRevealedChange],
  );

  const handleCopy = useCallback(() => {
    void copyText(plainText).then((ok) => {
      onCopy?.(plainText, ok);
      if (!ok) return;
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      // DESIGN.md §6.1: a success label reverts after 1.5s.
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, [plainText, onCopy]);

  const handleDownload = useCallback(() => {
    if (!downloadFileName) return;
    // A Blob URL, not a data: URL — a data: URL is blocked by the CSP
    // (SECURITY.md §8) and is silently ignored as a navigation target in Chrome.
    const url = URL.createObjectURL(new Blob([plainText], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadFileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // Revoking synchronously races the download starting in some WebViews.
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    onDownload?.();
  }, [downloadFileName, plainText, onDownload]);

  const isList = codes.length > 1;

  /**
   * The blurred placeholder and the revealed code share this markup so the box
   * is exactly the same size in both states — revealing must not reflow the page
   * under the finger that is about to press Copy.
   */
  const renderCodes = (blurred: boolean): ReactNode => {
    const bodyClass = clsx(CODE_TEXT, 'text-fg', blurred && 'select-none blur-sm');
    if (!isList) {
      return (
        <span
          aria-labelledby={blurred ? undefined : labelId}
          className={clsx(bodyClass, 'block break-all', !blurred && 'select-all')}
        >
          {codes[0]}
        </span>
      );
    }
    return (
      <ol
        aria-labelledby={blurred ? undefined : labelId}
        className={clsx(bodyClass, 'grid grid-cols-1 gap-1.5 sm:grid-cols-2')}
      >
        {codes.map((code, index) => (
          <li key={code} className="flex items-baseline gap-2">
            <span className="w-5 shrink-0 text-2xs tracking-normal text-fg-faint" aria-hidden="true">
              {index + 1}
            </span>
            {/* `select-all` makes one tap select the whole code — the difference
                between copying `A9K2` and copying `A9K`. */}
            <span className={clsx('break-all', !blurred && 'select-all')}>{code}</span>
          </li>
        ))}
      </ol>
    );
  };

  return (
    <div ref={ref} className={clsx('flex flex-col gap-2', className)} {...rest}>
      <div className="flex items-baseline justify-between gap-3">
        <span id={labelId} className="text-2xs text-fg-faint">
          {label}
        </span>
        {meta ? <span className="text-xs text-fg-faint">{meta}</span> : null}
      </div>

      <div className="relative rounded-lg border border-line-strong bg-surface-2 p-4">
        {/* The live region wraps both states so the code is announced exactly
            once, at the moment it first appears inside it. */}
        <div aria-live="assertive" aria-atomic="true">
          {isRevealed ? renderCodes(false) : null}
        </div>

        {!isRevealed ? (
          <>
            {/* aria-hidden: the reveal button below is the accessible
                affordance, and a screen-reader user should not have the code
                read out before they asked for it either. */}
            <div aria-hidden="true">{renderCodes(true)}</div>
            <button
              type="button"
              onClick={() => setRevealed(true)}
              aria-describedby={labelId}
              aria-expanded={false}
              className="nc-focus absolute inset-0 flex items-center justify-center rounded-lg text-sm font-bold text-fg"
            >
              {/* No glyph: DESIGN.md §7 fixes the icon set at 28 and there is
                  no eye in it. The prompt is the affordance. */}
              <span className="inline-flex min-h-touch items-center rounded-md bg-surface-3 px-4 shadow-1">
                {revealPrompt}
              </span>
            </button>
          </>
        ) : null}
      </div>

      {hint ? <p className="text-xs text-fg-faint">{hint}</p> : null}

      {isRevealed ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={handleCopy} className={ACTION_BUTTON}>
            {copied ? (
              <CheckIcon width={16} height={16} className="h-4 w-4" />
            ) : (
              <CopyIcon width={16} height={16} className="h-4 w-4" />
            )}
            <span>{copied ? copiedLabel : copyLabel}</span>
            <span className="nc-sr-only">{` ${label}`}</span>
          </button>

          {downloadFileName ? (
            <button type="button" onClick={handleDownload} className={ACTION_BUTTON}>
              <DownloadIcon width={16} height={16} className="h-4 w-4" />
              <span>{downloadLabel}</span>
              <span className="nc-sr-only">{` ${label}`}</span>
            </button>
          ) : null}

          {revealed === undefined ? (
            <button
              type="button"
              onClick={() => setRevealed(false)}
              className="nc-focus inline-flex h-11 min-w-touch items-center rounded-md px-3 text-[15px] font-bold leading-none text-fg-muted transition-colors duration-1 ease-out hover:bg-surface-2 hover:text-fg"
            >
              Hide
              <span className="nc-sr-only">{` ${label}`}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
