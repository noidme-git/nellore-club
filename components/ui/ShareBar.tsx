'use client';

import clsx from 'clsx';
import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
} from 'react';

import { CopyIcon, ShareIcon } from './icons';

/**
 * DESIGN.md §6.19, IA.md §10.
 *
 * WhatsApp is the distribution channel for this entire product: a tournament
 * reaches its players because a captain pastes a link into a group, not because
 * anyone browsed to it. So this bar is load-bearing, not decoration.
 *
 * Two controls, both `secondary` `md` (DESIGN.md §6.19):
 *  - **Share** → `navigator.share`, which on Android opens the system sheet with
 *    WhatsApp at the top of it. Where the API is missing (desktop Firefox, some
 *    in-app WebViews) the same button copies the link and the caller toasts.
 *  - **Copy for WhatsApp** → the pre-formatted plain text with `*bold*` markup.
 *    The text is composed by `lib/format/share.ts` and passed in; composing it
 *    here would put copy in a primitive and make it untestable (DESIGN.md §6.19
 *    is explicit: "never inline in a component").
 *
 * CAPABILITY DETECTION RUNS IN AN EFFECT, NOT IN RENDER. `output: 'export'`
 * prerenders this markup on a build machine with no `navigator`; branching on it
 * during render is a hydration mismatch. The first paint is therefore the
 * fallback ("Copy link"), which upgrades to "Share" a frame later — a label
 * swap, not a layout shift, because both controls keep their box.
 */

export interface SharePayload {
  title: string;
  /** Two short lines. WhatsApp shows very little before truncating (IA.md §10). */
  text: string;
  /** Absolute URL. */
  url: string;
}

export interface ShareBarProps extends HTMLAttributes<HTMLDivElement> {
  share: SharePayload;
  /**
   * Pre-formatted WhatsApp message from `lib/format/share.ts`, with `*bold*`
   * markup and the URL on its own line. Omit to hide that button.
   */
  whatsappText?: string;
  shareLabel?: string;
  copyLinkLabel?: string;
  whatsappLabel?: string;
  copiedLabel?: string;
  /** Fired after a successful share or copy, so the caller can raise the toast. */
  onShared?: (method: 'native' | 'clipboard') => void;
  onCopied?: (kind: 'link' | 'whatsapp') => void;
  /** A failure the user should be told about. An `AbortError` (user dismissed the sheet) is NOT reported. */
  onError?: (error: unknown) => void;
}

const BUTTON =
  'nc-focus inline-flex h-11 min-w-touch items-center justify-center gap-2 whitespace-nowrap rounded-md border border-line-strong bg-surface-2 px-4 text-[15px] font-bold leading-none text-fg transition-[background-color,transform] duration-1 ease-out active:translate-y-px hover:bg-surface-3';

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
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

/** The user closing the system share sheet is not an error worth a toast. */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export const ShareBar = forwardRef<HTMLDivElement, ShareBarProps>(function ShareBar(
  {
    share,
    whatsappText,
    shareLabel = 'Share',
    copyLinkLabel = 'Copy link',
    whatsappLabel = 'Copy for WhatsApp',
    copiedLabel = 'Copied',
    onShared,
    onCopied,
    onError,
    className,
    ...rest
  },
  ref,
) {
  const [canShare, setCanShare] = useState(false);
  const [copied, setCopied] = useState<'link' | 'whatsapp' | null>(null);
  const copiedTimer = useRef(0);

  useEffect(() => {
    // `canShare` narrows further than `'share' in navigator`: desktop Chrome
    // exposes `share` but refuses payloads it cannot handle.
    const supported =
      typeof navigator.share === 'function' &&
      (typeof navigator.canShare !== 'function' || navigator.canShare(share));
    setCanShare(supported);
  }, [share]);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const flashCopied = useCallback((kind: 'link' | 'whatsapp') => {
    setCopied(kind);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(null), 1500);
  }, []);

  const handleShare = useCallback(() => {
    if (canShare) {
      navigator
        .share(share)
        .then(() => onShared?.('native'))
        .catch((error: unknown) => {
          if (!isAbort(error)) onError?.(error);
        });
      return;
    }
    void copyText(share.url).then((ok) => {
      if (!ok) {
        onError?.(new Error('Clipboard unavailable'));
        return;
      }
      flashCopied('link');
      onCopied?.('link');
      onShared?.('clipboard');
    });
  }, [canShare, share, onShared, onCopied, onError, flashCopied]);

  const handleWhatsapp = useCallback(() => {
    if (!whatsappText) return;
    void copyText(whatsappText).then((ok) => {
      if (!ok) {
        onError?.(new Error('Clipboard unavailable'));
        return;
      }
      flashCopied('whatsapp');
      onCopied?.('whatsapp');
    });
  }, [whatsappText, onCopied, onError, flashCopied]);

  return (
    <div
      ref={ref}
      // A share control on paper is nothing; DESIGN.md §11 names it explicitly.
      data-print="hide"
      className={clsx('flex flex-wrap items-center gap-2', className)}
      {...rest}
    >
      <button type="button" onClick={handleShare} className={BUTTON}>
        {/* The glyph tracks what the button will actually do, so the fallback
            never promises a system share sheet that does not exist. */}
        {canShare ? (
          <ShareIcon width={18} height={18} className="h-[18px] w-[18px]" />
        ) : (
          <CopyIcon width={18} height={18} className="h-[18px] w-[18px]" />
        )}
        <span>{copied === 'link' ? copiedLabel : canShare ? shareLabel : copyLinkLabel}</span>
      </button>

      {whatsappText ? (
        <button type="button" onClick={handleWhatsapp} className={BUTTON}>
          <CopyIcon width={18} height={18} className="h-[18px] w-[18px]" />
          <span>{copied === 'whatsapp' ? copiedLabel : whatsappLabel}</span>
        </button>
      ) : null}

      {/* The copy confirmations are also toasted by the caller, but a toast is
          not guaranteed to be mounted on every surface this bar appears on, and
          a copy that reports nothing gets pressed three times. */}
      <span className="nc-sr-only" role="status" aria-atomic="true">
        {copied === 'link'
          ? 'Link copied to clipboard.'
          : copied === 'whatsapp'
            ? 'WhatsApp message copied to clipboard.'
            : ''}
      </span>
    </div>
  );
});
