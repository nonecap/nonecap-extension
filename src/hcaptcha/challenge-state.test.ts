// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChallengeController, type ChallengeController } from './challenge-state';

const SINGLE_HTML = '<div class="challenge-container"><div class="prompt-text">Drag the ball</div></div>';

function gridHtml(): string {
  let html = '<div class="challenge-container">';
  for (let i = 1; i <= 4; i++) {
    html += `<div class="task-image"><div class="image" style="background: url('https://t/${i}.jpg')"></div></div>`;
  }
  return html + '</div>';
}

function makeController(): { controller: ChallengeController; sends: string[] } {
  const sends: string[] = [];
  const controller = createChallengeController({
    doc: document,
    sendReady: (task) => sends.push(task),
  });
  return { controller, sends };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('post-exec re-arm probe', () => {
  it('re-arms after exec when a SINGLE challenge stays ready (atomic round swap, no not-ready window)', () => {
    document.body.innerHTML = SINGLE_HTML;
    const { controller, sends } = makeController();

    controller.tick();
    expect(sends).toEqual(['single']); // initial round announced

    // EXEC runs and completes; the round swaps atomically — the DOM is never
    // observed not-ready, which used to leave the edge disarmed forever.
    controller.execStarted();
    controller.execFinished();

    // Poll ticks inside the floor window: nothing fires (verifying overlay
    // guard) and the edge stays disarmed.
    vi.advanceTimersByTime(1000);
    controller.tick();
    expect(sends).toHaveLength(1);

    // Floor (2500ms) passes → probe sees the challenge still present + ready
    // → forces re-arm and announces the next round.
    vi.advanceTimersByTime(1600);
    expect(sends).toEqual(['single', 'single']);
  });

  it('is cancelled by teardown (CHALLENGE_GONE)', () => {
    document.body.innerHTML = SINGLE_HTML;
    const { controller, sends } = makeController();

    controller.tick();
    expect(sends).toEqual(['single']);

    controller.execStarted();
    controller.execFinished(); // probe armed

    // Challenge closes → teardown (the CHALLENGE_GONE path)…
    document.body.innerHTML = '';
    controller.teardown();
    // …and even though a ready-looking challenge reappears before the floor,
    // the cancelled probe must NOT fire on its own.
    document.body.innerHTML = SINGLE_HTML;
    vi.advanceTimersByTime(10_000);
    expect(sends).toHaveLength(1);
  });

  it('does not stack: a new exec restarts the probe instead of doubling it', () => {
    document.body.innerHTML = SINGLE_HTML;
    const { controller, sends } = makeController();
    controller.tick();
    expect(sends).toHaveLength(1);

    controller.execStarted();
    controller.execFinished();
    vi.advanceTimersByTime(1000); // first probe mid-flight…
    controller.execStarted(); // …superseded by the next exec
    controller.execFinished();

    // Old probe's floor (would be at t=2500) passes — nothing fires early.
    vi.advanceTimersByTime(2000);
    expect(sends).toHaveLength(1);
    // Only the restarted probe fires, at its own floor.
    vi.advanceTimersByTime(600);
    expect(sends).toHaveLength(2);
  });

  it('stays additive: the normal not-ready→ready edge still announces grids, with no probe duplicate', () => {
    document.body.innerHTML = gridHtml();
    const { controller, sends } = makeController();

    controller.tick();
    expect(sends).toEqual(['grid']);

    controller.execStarted();
    controller.execFinished();

    // Grid rounds swap through a placeholder window: tiles lose their
    // background → observed not-ready → edge re-arms (normal path).
    const images = document.querySelectorAll('.task-image .image');
    for (const image of images) image.removeAttribute('style');
    controller.onMutation();
    controller.tick();
    expect(sends).toHaveLength(1);

    // New round loads before the probe floor.
    for (const [i, image] of [...images].entries()) {
      image.setAttribute('style', `background: url('https://t/next-${i}.jpg')`);
    }
    controller.onMutation();
    vi.advanceTimersByTime(400); // grid stability debounce (300ms)
    controller.tick();
    expect(sends).toEqual(['grid', 'grid']);

    // The probe must not re-announce the already-announced round at its floor.
    vi.advanceTimersByTime(5000);
    controller.tick();
    expect(sends).toHaveLength(2);
  });

  it('keeps probing on post-floor mutations when the floor check caught the verifying overlay', () => {
    document.body.innerHTML = SINGLE_HTML;
    const { controller, sends } = makeController();
    controller.tick();
    expect(sends).toHaveLength(1);

    controller.execStarted();
    controller.execFinished();

    // At the floor the overlay still hides the prompt → not ready → probe
    // stays active instead of giving up.
    const prompt = document.querySelector('.prompt-text')!;
    prompt.textContent = '';
    vi.advanceTimersByTime(2600);
    expect(sends).toHaveLength(1);

    // Next round renders after the floor → mutation → probe re-arms; the
    // stability debounce still applies before the announce.
    prompt.textContent = 'Drag the new ball';
    controller.onMutation();
    expect(sends).toHaveLength(1); // mid-swap frame not captured
    vi.advanceTimersByTime(600); // single stability debounce (500ms)
    controller.tick();
    expect(sends).toEqual(['single', 'single']);
  });

  it('does not announce mid-exec even if a probe-like state occurs', () => {
    document.body.innerHTML = SINGLE_HTML;
    const { controller, sends } = makeController();
    controller.tick();
    expect(sends).toHaveLength(1);

    controller.execStarted();
    vi.advanceTimersByTime(10_000);
    controller.tick(); // still executing → no announcements
    expect(sends).toHaveLength(1);

    controller.execFinished();
    vi.advanceTimersByTime(2600); // probe floor after THIS exec
    expect(sends).toHaveLength(2);
  });
});
