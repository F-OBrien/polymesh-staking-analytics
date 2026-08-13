'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A small ⓘ that reveals an explanation on hover, focus or tap — so the prose a
 * staking site's audience needs is one gesture away rather than four lines
 * pushing the data below the fold.
 *
 * Hand-rolled rather than Radix Tooltip: this is on every page's critical path,
 * where the budget headroom is single-digit kilobytes, and it needs a box under
 * a button rather than collision-aware positioning.
 *
 * The accessibility rules it satisfies, none of which `title=` does:
 *
 *  - reachable by keyboard, and dismissible with Escape without moving focus
 *  - hoverable, so the panel stays open while the pointer is inside it and the
 *    text can be selected
 *  - announced via `aria-describedby` rather than a bare tooltip role
 *  - usable on touch, where there is no hover — hence the click toggle
 */
export function InfoTip({
  label = 'More information',
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  /**
   * Open state and the measured anchor position, as one value.
   *
   * Fixed positioning, because an absolutely-positioned panel is clipped by the
   * nearest scroll container — most of these live in a table inside
   * `overflow-x-auto`. Measured in the event handler rather than an effect,
   * which would cost a second render on every open.
   *
   * Also portalled to `document.body`, which fixed position alone does not
   * achieve: these sit inside sticky `<th>`s, and `position: sticky` with a
   * `z-index` creates a stacking context the panel's own `z-index` cannot
   * escape, so later header cells paint over it.
   */
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const open = at != null;
  const id = useId();
  const wrapper = useRef<HTMLSpanElement>(null);

  const show = () => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(340, window.innerWidth - 24);
    setAt({
      top: rect.bottom + 6,
      // Clamp inside the viewport so a tooltip near the right edge shifts back
      // rather than disappearing off-screen.
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
    });
  };
  const hide = () => setAt(null);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        hide();
        // Escape must not strand focus somewhere invisible.
        wrapper.current?.querySelector('button')?.focus();
      }
    };
    // A tap elsewhere closes it: touch has no hover, so otherwise the panel
    // stays open until the button is tapped again.
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) hide();
    };

    // Scrolling moves the anchor out from under a fixed panel, so close rather
    // than leave it stranded mid-page.
    const onScroll = () => hide();

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return (
    <span
      ref={wrapper}
      className="relative inline-flex align-middle"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => (open ? hide() : show())}
        onFocus={show}
        onBlur={(e) => {
          // Keep it open while focus moves *into* the panel, e.g. to a link.
          if (!wrapper.current?.contains(e.relatedTarget as Node)) hide();
        }}
        className="inline-flex size-4 cursor-help items-center justify-center rounded-full border text-[10px] leading-none font-semibold transition-colors"
        style={{
          borderColor: 'var(--border)',
          color: 'var(--text-muted)',
          background: 'transparent',
        }}
      >
        <span aria-hidden="true">i</span>
      </button>

      {at
        ? createPortal(
            <span
              id={id}
              role="tooltip"
              className="fixed z-50 block rounded-[10px] border p-3 text-[13px] leading-[18px] font-normal shadow-md"
              style={{
                top: at.top,
                left: at.left,
                width: 'min(340px, calc(100vw - 24px))',
                borderColor: 'var(--border)',
                background: 'var(--surface-2)',
                color: 'var(--text-secondary)',
                // Both would otherwise be inherited from the anchor: table
                // headers set `nowrap`, which runs the prose off the side of
                // the panel, and headings set their own tracking and weight.
                whiteSpace: 'normal',
                textAlign: 'left',
                fontWeight: 400,
                letterSpacing: 'normal',
              }}
              // The panel is outside the wrapper's DOM subtree, so it needs its
              // own hover handling or moving the pointer into it closes it.
              onMouseEnter={show}
              onMouseLeave={hide}
            >
              {children}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

/**
 * A page or section heading with its explanation folded into an {@link InfoTip}.
 * `lead` is the one line that must survive without interaction.
 */
export function HeadingWithTip({
  as: Tag = 'h2',
  id,
  title,
  lead,
  className = '',
  children,
}: {
  as?: 'h1' | 'h2' | 'h3';
  id?: string;
  title: string;
  lead?: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  const size =
    Tag === 'h1'
      ? 'text-3xl leading-9'
      : Tag === 'h2'
        ? 'text-[22px] leading-7'
        : 'text-[17px] leading-6';

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <Tag id={id} className={`${size} font-semibold tracking-tight`}>
          {title}
        </Tag>
        <InfoTip label={`About ${title}`}>{children}</InfoTip>
      </div>
      {lead ? (
        <p className="mt-2 mb-0 max-w-[65ch]" style={{ color: 'var(--text-secondary)' }}>
          {lead}
        </p>
      ) : null}
    </div>
  );
}
