import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { bindDashboardEventReconnectSignals, createDashboardEventConnection, createDashboardNavigation, dashboardClient, dashboardViewsForEvent, serverStatusMetrics } from "../../src/web/client";
import { EVENT_CATALOGUE } from "../../src/events/catalogue";
import { quotaCountdown, updateQuotaWindow } from "../../src/usage/quota-time";

describe("dashboard browser client", () => {
  test("renders live storage pressure, unavailable locations, and shared filesystems clearly", () => {
    const formatBytes = (value: number) => `${value} B`;
    const formatElapsed = (value: number) => `${value}s`;

    const pressured = serverStatusMetrics({
      memory: { usedBytes: 8, totalBytes: 16, processBytes: 2 },
      disk: { available: true, usedBytes: 20, totalBytes: 100, availableBytes: 80 },
      storage: {
        artifacts: { available: true, usedBytes: 86, totalBytes: 100, availableBytes: 14 },
        temporaryDirectory: { available: true, usedBytes: 85, totalBytes: 100, availableBytes: 15 },
        workspaceScratch: { available: false },
      },
      uptimeSeconds: 60,
    }, formatBytes, formatElapsed);
    expect(pressured).toContain("Warning: artifacts 86% used (86 B / 100 B)");
    expect(pressured).toContain("temporary directory 85% used (85 B / 100 B)");
    expect(pressured).not.toContain("Warning: temporary directory");

    const justOverThreshold = serverStatusMetrics({
      memory: { usedBytes: 8, totalBytes: 16, processBytes: 2 },
      disk: { available: true, usedBytes: 20, totalBytes: 100, availableBytes: 80 },
      storage: {
        artifacts: { available: true, usedBytes: 8_504, totalBytes: 10_000, availableBytes: 1_496 },
        temporaryDirectory: { available: true, usedBytes: 8_500, totalBytes: 10_000, availableBytes: 1_500 },
        workspaceScratch: { available: false },
      },
      uptimeSeconds: 60,
    }, formatBytes, formatElapsed);
    expect(justOverThreshold).toContain("Warning: artifacts 85% used");
    expect(justOverThreshold).not.toContain("Warning: agent scratch");

    const sharedAndUnavailable = serverStatusMetrics({
      memory: { usedBytes: 8, totalBytes: 16, processBytes: 2 },
      disk: { available: true, usedBytes: 20, totalBytes: 100, availableBytes: 80 },
      storage: {
        artifacts: { available: true, usedBytes: 90, totalBytes: 100, availableBytes: 10 },
        temporaryDirectory: { available: true, usedBytes: 90, totalBytes: 100, availableBytes: 10, sharesFilesystemWithArtifacts: true },
        workspaceScratch: { available: false },
      },
      uptimeSeconds: 60,
    }, formatBytes, formatElapsed);
    expect(sharedAndUnavailable).toContain("Warning: artifacts and temporary directory 90% used (90 B / 100 B)");
    expect(sharedAndUnavailable.match(/90 B \/ 100 B/g)).toHaveLength(1);

    const unavailable = serverStatusMetrics({
      memory: { usedBytes: 8, totalBytes: 16, processBytes: 2 },
      disk: { available: false },
      storage: { artifacts: { available: false }, temporaryDirectory: { available: false }, workspaceScratch: { available: false } },
      uptimeSeconds: 60,
    }, formatBytes, formatElapsed);
    expect(unavailable).toContain("Disk unavailable");
    expect(unavailable).toContain("artifacts unavailable");
    expect(unavailable).toContain("temporary directory unavailable");
    expect(unavailable).toContain("agent scratch unavailable");
  });

  test("reopens a silently closed stream for every return signal without duplicating a healthy stream", () => {
    let now = 0;
    let pageActive = true;
    let online = true;
    const states: boolean[] = [];
    const timers: Array<{ delay: number; callback: () => void; cancelled: boolean }> = [];
    const sources: Array<{
      readyState: number;
      closed: boolean;
      onopen: (() => void) | null;
      onerror: (() => void) | null;
      listeners: Map<string, (event: { data: string }) => void>;
      close: () => void;
      addEventListener: (type: string, listener: (event: { data: string }) => void) => void;
    }> = [];
    const connection = createDashboardEventConnection({
      createEventSource: () => {
        const source = {
          readyState: 0,
          closed: false,
          onopen: null as (() => void) | null,
          onerror: null as (() => void) | null,
          listeners: new Map<string, (event: { data: string }) => void>(),
          close: () => { source.closed = true; source.readyState = 2; },
          addEventListener: (type: string, listener: (event: { data: string }) => void) => source.listeners.set(type, listener),
        };
        sources.push(source);
        return source;
      },
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { timer.cancelled = true; },
      setInterval: () => 0,
      clearInterval: () => {},
      now: () => now,
      pageActive: () => pageActive,
      online: () => online,
      staleAfter: 30_000,
      retryDelays: [1_000, 2_000, 5_000, 10_000],
      onConnectionChange: (connected) => states.push(connected),
      onReconnect: () => {},
      onEvent: () => {},
    });
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    bindDashboardEventReconnectSignals(connection, { documentTarget, windowTarget });
    const open = () => {
      const source = sources.at(-1)!;
      source.readyState = 1;
      source.onopen!();
    };
    const silentClose = () => { sources.at(-1)!.readyState = 2; };
    const returnFrom = (signal: "visibilitychange" | "focus" | "online" | "pageshow") => {
      silentClose();
      if (signal === "visibilitychange") documentTarget.dispatchEvent(new Event(signal));
      else if (signal === "pageshow") {
        const event = new Event(signal);
        Object.defineProperty(event, "persisted", { value: true });
        windowTarget.dispatchEvent(event);
      } else windowTarget.dispatchEvent(new Event(signal));
      open();
    };

    expect(sources).toHaveLength(1);
    open();
    pageActive = false;
    silentClose();
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(sources).toHaveLength(1);
    pageActive = true;
    returnFrom("visibilitychange");
    expect(sources).toHaveLength(2);
    returnFrom("focus");
    expect(sources).toHaveLength(3);
    online = false;
    connection.check();
    online = true;
    returnFrom("online");
    expect(sources).toHaveLength(4);
    returnFrom("pageshow");
    expect(sources).toHaveLength(5);
    windowTarget.dispatchEvent(new Event("focus"));
    expect(sources).toHaveLength(5);
    expect(states.at(-1)).toBe(true);
    connection.close();
    expect(timers).toEqual([]);
  });

  test("pauses hidden retries and resumes a hidden error immediately when visible", () => {
    let pageActive = true;
    const timers: Array<{ delay: number; callback: () => void; cancelled: boolean }> = [];
    const states: boolean[] = [];
    const sources: Array<{ readyState: number; onopen: (() => void) | null; onerror: (() => void) | null; close: () => void; addEventListener: () => void }> = [];
    const connection = createDashboardEventConnection({
      createEventSource: () => {
        const source = { readyState: 0, onopen: null as (() => void) | null, onerror: null as (() => void) | null, close: () => { source.readyState = 2; }, addEventListener: () => {} };
        sources.push(source);
        return source;
      },
      pageActive: () => pageActive,
      online: () => true,
      retryDelays: [1_000, 2_000, 5_000],
      setTimeout: (callback, delay) => {
        const timer = { delay, callback, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { timer.cancelled = true; },
      setInterval: () => 0,
      clearInterval: () => {},
      onConnectionChange: (connected) => states.push(connected),
      onReconnect: () => {},
      onEvent: () => {},
    });
    sources[0]!.onopen!();
    pageActive = false;
    sources[0]!.onerror!();
    expect(timers).toEqual([]);
    pageActive = true;
    connection.check();
    expect(sources).toHaveLength(2);
    sources[1]!.onopen!();
    expect(states.at(-1)).toBe(true);
  });

  test("uses bounded increasing retries until the stream opens and pauses them while unavailable", () => {
    let pageActive = true;
    let online = true;
    const timers: Array<{ delay: number; callback: () => void; cancelled: boolean }> = [];
    const sources: Array<{ readyState: number; onopen: (() => void) | null; onerror: (() => void) | null; close: () => void; addEventListener: () => void }> = [];
    const connection = createDashboardEventConnection({
      createEventSource: () => {
        const source = { readyState: 0, onopen: null as (() => void) | null, onerror: null as (() => void) | null, close: () => { source.readyState = 2; }, addEventListener: () => {} };
        sources.push(source);
        return source;
      },
      pageActive: () => pageActive,
      online: () => online,
      retryDelays: [1_000, 2_000, 5_000],
      setTimeout: (callback, delay) => {
        const timer = { delay, callback, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { timer.cancelled = true; },
      setInterval: () => 0,
      clearInterval: () => {},
      onConnectionChange: () => {},
      onReconnect: () => {},
      onEvent: () => {},
    });
    const runTimer = () => {
      const timer = timers.shift()!;
      if (!timer.cancelled) timer.callback();
    };
    sources[0]!.onerror!();
    expect(timers.filter((timer) => !timer.cancelled).map((timer) => timer.delay)).toEqual([1_000]);
    runTimer();
    sources[1]!.onerror!();
    expect(timers.map((timer) => timer.delay)).toEqual([2_000]);
    pageActive = false;
    connection.check();
    expect(timers[0]!.cancelled).toBe(true);
    online = false;
    pageActive = true;
    connection.check();
    expect(sources).toHaveLength(2);
    online = true;
    connection.check();
    expect(sources).toHaveLength(3);
    sources[2]!.onopen!();
    sources[2]!.onerror!();
    expect(timers.filter((timer) => !timer.cancelled).map((timer) => timer.delay)).toEqual([1_000]);
  });

  test("refreshes after a replacement opens without replay and handles later live events", () => {
    const sources: Array<{
      readyState: number;
      onopen: (() => void) | null;
      onerror: (() => void) | null;
      close: () => void;
      listeners: Map<string, (event: { data: string }) => void>;
      addEventListener: (type: string, listener: (event: { data: string }) => void) => void;
    }> = [];
    const refreshes: string[] = [];
    const events: string[] = [];
    const connection = createDashboardEventConnection({
      createEventSource: () => {
        const source = {
          readyState: 0,
          onopen: null as (() => void) | null,
          onerror: null as (() => void) | null,
          close: () => { source.readyState = 2; },
          listeners: new Map<string, (event: { data: string }) => void>(),
          addEventListener: (type: string, listener: (event: { data: string }) => void) => source.listeners.set(type, listener),
        };
        sources.push(source);
        return source;
      },
      retryDelay: 1,
      pageActive: () => true,
      online: () => true,
      setTimeout: (callback) => ({ callback }),
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      onConnectionChange: () => {},
      onReconnect: () => refreshes.push("refresh"),
      onEvent: (type) => events.push(type),
    });

    sources[0]!.onopen!();
    sources[0]!.onerror!();
    connection.check();
    sources[1]!.onopen!();
    expect(refreshes).toEqual(["refresh"]);
    expect(events).toEqual([]);
    sources[1]!.listeners.get("conveyor")!({ data: "{}" });
    expect(events).toEqual(["conveyor"]);
  });

  test("keeps an idle stream open for observable keep-alives and replaces missing activity", () => {
    let now = 0;
    let watchdog = () => {};
    const sources: Array<{
      readyState: number;
      onopen: (() => void) | null;
      onerror: (() => void) | null;
      close: () => void;
      listeners: Map<string, (event: { data: string }) => void>;
      addEventListener: (type: string, listener: (event: { data: string }) => void) => void;
    }> = [];
    createDashboardEventConnection({
      createEventSource: () => {
        const source = {
          readyState: 1,
          onopen: null as (() => void) | null,
          onerror: null as (() => void) | null,
          close: () => { source.readyState = 2; },
          listeners: new Map<string, (event: { data: string }) => void>(),
          addEventListener: (type: string, listener: (event: { data: string }) => void) => source.listeners.set(type, listener),
        };
        sources.push(source);
        return source;
      },
      now: () => now,
      pageActive: () => true,
      online: () => true,
      staleAfter: 30_000,
      setInterval: (callback) => {
        watchdog = callback;
        return 0;
      },
      clearInterval: () => {},
      onConnectionChange: () => {},
      onReconnect: () => {},
      onEvent: () => {},
    });

    sources[0]!.onopen!();
    now = 29_000;
    sources[0]!.listeners.get("keep-alive")!({ data: "{}" });
    now = 58_000;
    watchdog();
    expect(sources).toHaveLength(1);
    now = 88_000;
    watchdog();
    expect(sources).toHaveLength(2);
  });

  test("stops retries for an expired session but retains them for transient errors", async () => {
    const makeConnection = (expired: boolean) => {
      const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
      const sources: Array<{ readyState: number; onopen: (() => void) | null; onerror: (() => void) | null; close: () => void; addEventListener: () => void }> = [];
      const sessionStates: string[] = [];
      createDashboardEventConnection({
        createEventSource: () => {
          const source = { readyState: 0, onopen: null as (() => void) | null, onerror: null as (() => void) | null, close: () => { source.readyState = 2; }, addEventListener: () => {} };
          sources.push(source);
          return source;
        },
        isSessionExpired: async () => expired,
        onSessionExpired: () => sessionStates.push("ended"),
        pageActive: () => true,
        online: () => true,
        setTimeout: (callback) => {
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return timer;
        },
        clearTimeout: (timer) => { timer.cancelled = true; },
        setInterval: () => 0,
        clearInterval: () => {},
        onConnectionChange: () => {},
        onReconnect: () => {},
        onEvent: () => {},
      });
      return { sources, timers, sessionStates };
    };

    const expired = makeConnection(true);
    expired.sources[0]!.onerror!();
    await Promise.resolve();
    expect(expired.sessionStates).toEqual(["ended"]);
    expect(expired.timers[0]!.cancelled).toBe(true);

    const transient = makeConnection(false);
    transient.sources[0]!.onerror!();
    await Promise.resolve();
    expect(transient.sessionStates).toEqual([]);
    expect(transient.timers[0]!.cancelled).toBe(false);
  });

  test("keeps dashboard navigation feedback with the latest delayed response", async () => {
    const events: string[] = [];
    const requests: Array<{ target: string; resolve: (loaded: boolean) => void }> = [];
    const navigate = createDashboardNavigation<string>({
      load: (target) => new Promise<boolean>((resolve) => requests.push({ target, resolve })),
      start: () => events.push("start"),
      finish: () => events.push("finish"),
      fallback: (target) => events.push(`fallback:${target}`),
    });

    const first = navigate("/first");
    expect(events).toEqual(["start"]);
    const second = navigate("/second");
    expect(events).toEqual(["start", "start"]);

    requests[1]!.resolve(true);
    await second;
    expect(events).toEqual(["start", "start", "finish"]);

    requests[0]!.resolve(true);
    await first;
    expect(events).toEqual(["start", "start", "finish"]);

    const failed = navigate("/failed");
    requests[2]!.resolve(false);
    await failed;
    expect(events).toEqual(["start", "start", "finish", "start", "finish", "fallback:/failed"]);
  });

  test("is valid standalone JavaScript", () => {
    expect(() => new Function(dashboardClient)).not.toThrow();
    expect(dashboardClient).toContain("activityUrl");
    expect(dashboardClient).toContain("appendLinkedText(parent, value.slice");
    expect(dashboardClient).toContain("appendMarkdown(body, String(message.message");
    expect(dashboardClient).toContain("String(message.actorName ||");
    expect(dashboardClient).toContain("actorAvatar(actorName, message.actorType, message.actorAvatar)");
    expect(dashboardClient).not.toContain("actor.textContent = 'You'");
    expect(dashboardClient).toContain("'/backlog/move'");
    expect(dashboardClient).toContain("addEventListener('dragend'");
    expect(dashboardClient).toContain("data-detail-tab");
    expect(dashboardClient).toContain("createDashboardEventConnection");
    expect(dashboardClient).toContain('bindDashboardEventReconnectSignals(dashboardEvents)');
    expect(dashboardClient).toContain('event.persisted');
    expect(dashboardClient).toContain('Session ended');
    expect(dashboardClient).toContain('data-session-sign-in');
    expect(dashboardClient).toContain("const refreshDashboardWhenSafe = () => {");
    expect(dashboardClient).toContain("onReconnect: refreshDashboardWhenSafe");
    expect(dashboardClient).toContain("scheduleJourneyRefresh();\n      scheduleSummaryRefresh();\n      pendingRefresh = true;");
    expect(dashboardClient).toContain("scheduleActivityRefresh");
    expect(dashboardClient).toContain("loadIssueJourney");
    expect(dashboardClient).toContain("journey.now");
    expect(dashboardClient).toContain("journey.skippedReviews");
    expect(dashboardClient).toContain("Native review ignored by trust safeguards");
    expect(dashboardClient).toContain("Open review \\u2197");
    expect(dashboardClient).toContain("journey-entry--now");
    // The journey reads oldest first, so the current position is appended after the history.
    expect(dashboardClient.indexOf("if (nowItem) root.append(nowItem);")).toBeGreaterThan(dashboardClient.indexOf("for (const transition of transitions)"));
    expect(dashboardClient).toContain("now.state === 'done' || now.state === 'completed'");
    expect(dashboardClient).toContain("scheduleJourneyRefresh");
    // An open issue dialog still gets its live summary parts (todos above all) without a page refresh.
    expect(dashboardClient).toContain("scheduleSummaryRefresh();");
    expect(dashboardClient).toContain("const SUMMARY_LIVE_PARTS = ['.details-status', '.indicators', '[data-manual-gates]', '.todos', '.details-facts', '[data-criterion-evidence]'];");
    expect(dashboardClient).toContain("dialog.getAttribute('data-details-url')");
    expect(dashboardClient).toContain("const openIssueDialog = async");
    expect(dashboardClient).toContain("const detailsAbortController = new AbortController();");
    expect(dashboardClient).toContain("detailsRequestAbort?.abort();");
    expect(dashboardClient).toContain("signal: detailsAbortController.signal");
    expect(dashboardClient).toContain("dialog.dataset.lazyDetails = 'true'");
    expect(dashboardClient).toContain("lazyDetails");
    expect(dashboardClient).toContain("event.target.remove");
    expect(dashboardClient).toContain("data-details-retry");
    expect(dashboardClient).toContain("dialog._conveyorOpener = opener");
    expect(dashboardClient).toContain("opener.focus({ preventScroll: true })");
    expect(dashboardClient).not.toContain("/api/dashboard-revision");
    expect(dashboardClient).toContain("issuePath(dialog, name)");
    expect(dashboardClient).toContain("data-more-runs");
    expect(dashboardClient).toContain("data-more-events");
    expect(dashboardClient).toContain("field.value = ''");
    expect(dashboardClient).toContain("field.value = submittedMessage");
    expect(dashboardClient).toContain("name === 'journey'");
    expect(dashboardClient).toContain("new DOMParser()");
    expect(dashboardClient).toContain("currentDashboard.replaceWith(nextDashboard)");
    expect(dashboardClient).toContain("const captureDashboardPosition = () => {");
    expect(dashboardClient).toContain("const restoreDashboardPosition = (position) => {");
    expect(dashboardClient).toContain("captureDashboardPosition() : null");
    expect(dashboardClient).toContain("history.pushState({ conveyorPage: true }");
    expect(dashboardClient).toContain("load: (target, historyMode) => replaceDashboard(target, { historyMode, preservePosition: false })");
    expect(dashboardClient).toContain("else if (target.hash)");
    expect(dashboardClient).toContain("document.title = nextDocument.title");
    expect(dashboardClient).toContain("void navigateDashboard(destination)");
    expect(dashboardClient).toContain("new URL(location.href), 'none'");
    expect(dashboardClient).toContain("conveyor:dashboard-rendered");
    expect(dashboardClient).toContain("const syncStickyNavigationHeight = () => {");
    expect(dashboardClient).toContain("new ResizeObserver(update)");
    expect(dashboardClient).toContain("dashboard.style.setProperty('--dashboard-sticky-height'");
    expect(dashboardClient).toContain("document.addEventListener('conveyor:dashboard-rendered', syncStickyNavigationHeight)");
    expect(dashboardClient).toContain("const revealActiveTab = () => {");
    expect(dashboardClient).toContain("tabs.scrollLeft += tab.right - container.right");
    expect(dashboardClient).toContain("destination.origin !== location.origin");
    expect(dashboardClient).toContain("const createDashboardNavigation =");
    expect(dashboardClient).toContain("body.classList.add('page-loading', 'dashboard-navigating')");
    expect(dashboardClient).toContain("body.classList.remove('page-loading', 'dashboard-navigating')");
    expect(dashboardClient).toContain("time[data-relative-time][datetime]");
    expect(dashboardClient).not.toContain("location.reload()")
    expect(dashboardClient).toContain("dialog.showModal();");
    expect(dashboardClient).not.toContain("dialog.show();");
    expect(dashboardClient).toContain("classList.toggle('is-selected', selected)");
    expect(dashboardClient).toContain("parseDashboardPath");
    expect(dashboardClient).toContain("'/issues/'");
    expect(dashboardClient).toContain("'/team/'");
    expect(dashboardClient).toContain("event.key === 'Escape'");
    expect(dashboardClient).toContain(": 'Operator'");
    expect(dashboardClient).toContain("localStorage.setItem('conveyor-theme'");
    expect(dashboardClient).toContain("delete document.documentElement.dataset.theme");
    expect(dashboardClient).toContain("data-theme-choice");
    expect(dashboardClient).toContain("closeHeaderPopovers");
    expect(dashboardClient).toContain("document.addEventListener('toggle'");
    expect(dashboardClient).toContain("closest('.dashboard-header details')");
    expect(dashboardClient).toContain("openDetails.querySelector('summary')");
    expect(dashboardClient).toContain("summary.focus()");
    expect(dashboardClient).toContain("window.setInterval(updateQuotaCountdowns, 60_000)");
    expect(dashboardClient).toContain("countdownOf(resetAtMs, nowMs)");
    expect(dashboardClient).toContain("updateQuotaWindow(quotaWindow, quotaCountdown)");
    expect(dashboardClient).toContain("new Intl.DateTimeFormat(undefined");
    expect(dashboardClient).toContain("quota-window--stale");
    expect(dashboardClient).toContain("[data-retry-card]");
    expect(dashboardClient).toContain("[data-retry-form]");
    expect(dashboardClient).toContain("[data-profile-avatar-form], [data-account-create-form]");
    expect(dashboardClient).toContain("[data-account-action-form]");
    expect(dashboardClient).toContain("[data-account-delete-cancel]");
    expect(dashboardClient).toContain(".account-avatar, [data-profile-avatar]");
    expect(dashboardClient).toContain("status.textContent = 'Saved.'");
    expect(dashboardClient).toContain("new FormData(form)");
    expect(dashboardClient).toContain("Retry accepted. A fresh attempt is queued.");
    expect(dashboardClient).toContain("Retry failed: ");
    expect(dashboardClient).toContain("button.disabled = true");
    expect(dashboardClient).toContain("history.replaceState");
    expect(dashboardClient).toContain("data-filter-repository");
    expect(dashboardClient).toContain("data-board-search");
    expect(dashboardClient).toContain("doneRequestVersion");
    expect(dashboardClient).toContain("conveyor:dashboard-rendered', bindBoardFilters");
  });

  test("updates the browser quota element countdown and stale accessibility state", () => {
    const now = Date.parse("2026-10-03T14:04:00.000Z");
    const attributes = new Map<string, string>([
      ["data-reset-at", "2026-10-05T22:00:00.000Z"],
      ["data-reported-at", "2026-10-03T14:04:00.000Z"],
      ["data-remaining", "4"],
      ["data-window-name", "weekly"],
    ]);
    const countdown = { textContent: "" };
    const value = { textContent: "" };
    const lowLabel = { hidden: false };
    const resetDetail = { textContent: "" };
    const reportedDetail = { textContent: "" };
    const classes = new Set<string>(["quota-window--low"]);
    const element = {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      querySelector: (selector: string) => selector === "[data-countdown]" ? countdown
        : selector === ".quota-value" ? value
          : selector === ".quota-low-label" ? lowLabel
          : selector === "[data-reset-detail]" ? resetDetail
            : selector === "[data-reported-detail]" ? reportedDetail : null,
      classList: { toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name) },
      closest: () => ({ querySelector: () => ({ textContent: "Claude Code" }) }),
      setAttribute: (name: string, content: string) => attributes.set(name, content),
    } as unknown as HTMLElement;

    updateQuotaWindow(element, quotaCountdown, now);
    expect(countdown.textContent).toBe("resets in 2d 7h 56m");
    expect(value.textContent).toBe("4% left");
    expect(attributes.get("aria-label")).toContain("Claude Code weekly: 4% remaining.");
    const format = (iso: string) => new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(iso));
    expect(resetDetail.textContent).toBe(`Reset: ${format("2026-10-05T22:00:00.000Z")}`);
    expect(reportedDetail.textContent).toBe(`Last reported: ${format("2026-10-03T14:04:00.000Z")}`);
    expect(classes.has("quota-window--stale")).toBe(false);
    expect(classes.has("quota-window--low")).toBe(true);
    expect(lowLabel.hidden).toBe(false);

    attributes.set("data-reset-at", new Date(now).toISOString());
    updateQuotaWindow(element, quotaCountdown, now);
    expect(countdown.textContent).toBe("stale");
    expect(value.textContent).toBe("Stale");
    expect(attributes.get("aria-label")).toContain("weekly: stale.");
    expect(attributes.get("aria-label")).not.toContain("remaining");
    expect(classes.has("quota-window--stale")).toBe(true);
    expect(classes.has("quota-window--low")).toBe(false);
    expect(lowLabel.hidden).toBe(true);

    attributes.set("data-reset-at", "2026-10-05T22:00:00.000Z");
    updateQuotaWindow(element, quotaCountdown, now);
    expect(countdown.textContent).toBe("resets in 2d 7h 56m");
    expect(value.textContent).toBe("4% left");
    expect(attributes.get("aria-label")).toContain("weekly: 4% remaining.");
    expect(classes.has("quota-window--stale")).toBe(false);
    expect(classes.has("quota-window--low")).toBe(true);
    expect(lowLabel.hidden).toBe(false);
  });

  test("the embedded quota code runs on its own after a minified build, as the release serves it", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "conveyor-client-"));
    try {
      const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../../src/web/client.ts")], outdir: out, target: "bun", minify: true });
      expect(built.success).toBe(true);
      const { quotaClient } = await import(built.outputs[0]!.path) as { quotaClient: string };
      const [countdown, update] = new Function(`${quotaClient}\nreturn [quotaCountdown, updateQuotaWindow];`)() as [typeof quotaCountdown, typeof updateQuotaWindow];
      const text = { textContent: "" };
      const element = {
        getAttribute: (name: string) => name === "data-reset-at" ? "2026-10-05T22:00:00.000Z" : name === "data-remaining" ? "40" : null,
        querySelector: (selector: string) => selector === "[data-countdown]" ? text : null,
        classList: { toggle: () => {} },
        closest: () => null,
        setAttribute: () => {},
      } as unknown as HTMLElement;
      update(element, countdown, Date.parse("2026-10-03T14:04:00.000Z"));
      expect(text.textContent).toBe("resets in 2d 7h 56m");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe("dashboardViewsForEvent", () => {
  test("an item change refreshes the board", () => {
    expect(dashboardViewsForEvent("item.stageChanged")).toEqual(["board"]);
  });
  test("a conversation message refreshes the board and the conversation", () => {
    expect(dashboardViewsForEvent("message.posted")).toEqual(["board", "conversation"]);
  });
  test("a transcript line refreshes only the logs", () => {
    expect(dashboardViewsForEvent("run.progressed")).toEqual(["activity"]);
  });
  test("a run starting or finishing refreshes the board and the logs", () => {
    expect(dashboardViewsForEvent("run.finished")).toEqual(["board", "activity"]);
  });
  test("bookkeeping that shows nowhere refreshes nothing", () => {
    for (const type of ["webhook.received", "task.planned", "task.pending", "command.accepted", "session.signedIn", "item.fenced", "source.mutationStarted"]) {
      expect({ type, views: dashboardViewsForEvent(type) }).toEqual({ type, views: [] });
    }
  });
  test("every catalogued event maps only to known views", () => {
    for (const type of Object.keys(EVENT_CATALOGUE)) {
      for (const view of dashboardViewsForEvent(type)) expect(["board", "conversation", "activity"]).toContain(view);
    }
  });
});
