import {
  type RefCallback,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const DEFAULT_PULL_THRESHOLD = 56;
const DEFAULT_MAX_PULL_DISTANCE = 72;
const DEFAULT_REFRESH_HOLD_DISTANCE = 36;
const PULL_START_SLOP = 6;

export type PullToRefreshState = "idle" | "pulling" | "refreshing";

export type UsePullToRefreshOptions = {
  enabled?: boolean;
  onRefresh(): Promise<void> | void;
  threshold?: number;
  maxPullDistance?: number;
  refreshHoldDistance?: number;
};

export type UsePullToRefreshResult<T extends HTMLElement> = {
  distance: number;
  refreshing: boolean;
  scrollRef: RefCallback<T>;
  state: PullToRefreshState;
};

/**
 * Touch-only pull-to-refresh for an existing scroll viewport.
 *
 * The hook owns gesture recognition and refresh lifecycle only. Consumers keep
 * rendering their native loading primitive and can apply the returned distance
 * to any indicator layout. It deliberately starts only at scrollTop=0 and
 * ignores editable controls so a composer never becomes a refresh gesture.
 */
export function usePullToRefresh<T extends HTMLElement>({
  enabled = true,
  onRefresh,
  threshold = DEFAULT_PULL_THRESHOLD,
  maxPullDistance = DEFAULT_MAX_PULL_DISTANCE,
  refreshHoldDistance = DEFAULT_REFRESH_HOLD_DISTANCE,
}: UsePullToRefreshOptions): UsePullToRefreshResult<T> {
  const [element, setElement] = useState<T | null>(null);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const onRefreshRef = useRef(onRefresh);
  const mountedRef = useRef(true);
  const gestureRef = useRef({
    active: false,
    distance: 0,
    startY: 0,
  });
  const refreshRunRef = useRef(0);
  onRefreshRef.current = onRefresh;

  const scrollRef = useCallback<RefCallback<T>>((node) => {
    setElement(node);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshRunRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !element) {
      gestureRef.current = { active: false, distance: 0, startY: 0 };
      setDistance(0);
      return;
    }

    const resetGesture = () => {
      gestureRef.current.active = false;
      gestureRef.current.distance = 0;
      setDistance(0);
    };

    const startsInEditableControl = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(
        target.closest(
          "input, textarea, select, [contenteditable='true'], [data-pull-to-refresh-ignore]",
        ),
      );

    const onTouchStart = (event: TouchEvent) => {
      if (refreshing) return;
      if (
        event.touches.length !== 1 ||
        element.scrollTop > 0 ||
        startsInEditableControl(event.target)
      ) {
        resetGesture();
        return;
      }
      gestureRef.current = {
        active: true,
        distance: 0,
        startY: event.touches[0]!.clientY,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture.active || refreshing || event.touches.length !== 1) return;
      if (element.scrollTop > 0) {
        resetGesture();
        return;
      }
      const delta = event.touches[0]!.clientY - gesture.startY;
      if (delta <= 0) {
        gesture.distance = 0;
        setDistance(0);
        return;
      }
      if (delta > PULL_START_SLOP && event.cancelable) event.preventDefault();
      const nextDistance = Math.min(maxPullDistance, delta * 0.42);
      gesture.distance = nextDistance;
      setDistance(nextDistance);
    };

    const finishGesture = () => {
      const shouldRefresh =
        gestureRef.current.active &&
        gestureRef.current.distance >= threshold &&
        !refreshing;
      gestureRef.current.active = false;
      gestureRef.current.distance = 0;
      if (!shouldRefresh) {
        setDistance(0);
        return;
      }

      const run = refreshRunRef.current + 1;
      refreshRunRef.current = run;
      setRefreshing(true);
      setDistance(refreshHoldDistance);
      void Promise.resolve()
        .then(() => onRefreshRef.current())
        .finally(() => {
          if (!mountedRef.current || refreshRunRef.current !== run) return;
          setRefreshing(false);
          setDistance(0);
        });
    };

    const onTouchCancel = () => resetGesture();

    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", finishGesture, { passive: true });
    element.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", finishGesture);
      element.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [
    element,
    enabled,
    maxPullDistance,
    refreshHoldDistance,
    refreshing,
    threshold,
  ]);

  return {
    distance,
    refreshing,
    scrollRef,
    state: refreshing ? "refreshing" : distance > 0 ? "pulling" : "idle",
  };
}
