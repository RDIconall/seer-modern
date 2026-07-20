"use client";

import { Loader2, RefreshCw } from "lucide-react";
import {
  useRef,
  useState,
  type ReactNode,
  type TouchEvent,
  type UIEvent,
} from "react";

const THRESHOLD = 70;
const MAX_PULL = 110;

/**
 * Gmail-app-style pull-to-refresh: drag the list down from the top and
 * release to reload. Standalone PWAs don't get the browser's native
 * gesture, so Seer ships its own.
 */
export function PullToRefresh({
  onRefresh,
  className,
  children,
}: {
  onRefresh: () => Promise<unknown> | unknown;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const atTop = useRef(true);

  const onScroll = (e: UIEvent<HTMLElement>) => {
    atTop.current = (e.target as HTMLElement).scrollTop <= 0;
  };

  const onTouchStart = (e: TouchEvent) => {
    if (!atTop.current || refreshing) return;
    startY.current = e.touches[0]?.clientY ?? null;
  };

  const onTouchMove = (e: TouchEvent) => {
    if (startY.current == null || refreshing) return;
    const dy = (e.touches[0]?.clientY ?? startY.current) - startY.current;
    if (dy <= 0 || !atTop.current) {
      setPull(0);
      return;
    }
    // Rubber-band the pull
    setPull(Math.min(MAX_PULL, dy * 0.5));
  };

  const onTouchEnd = async () => {
    startY.current = null;
    if (refreshing) return;
    if (pull >= THRESHOLD) {
      setRefreshing(true);
      setPull(THRESHOLD * 0.7);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
        setPull(0);
      }
    } else {
      setPull(0);
    }
  };

  return (
    <main
      ref={ref as React.RefObject<HTMLElement>}
      className={className}
      onScroll={onScroll}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={{ overscrollBehaviorY: "contain" }}
    >
      {pull > 0 || refreshing ? (
        <div
          className="flex shrink-0 items-center justify-center overflow-hidden transition-[height]"
          style={{ height: pull }}
        >
          {refreshing ? (
            <Loader2 className="h-5 w-5 animate-spin text-[var(--primary)]" />
          ) : (
            <RefreshCw
              className="h-5 w-5 text-[var(--muted)] transition-transform"
              style={{
                transform: `rotate(${(pull / THRESHOLD) * 270}deg)`,
                opacity: Math.min(1, pull / THRESHOLD),
              }}
            />
          )}
        </div>
      ) : null}
      {children}
    </main>
  );
}
